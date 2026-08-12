import { prisma } from "@/lib/prisma";
import { clientForAccount, calendarFor } from "@/lib/google";
import { matchWithJobHint } from "@/server/sync/match";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount, EventStatus } from "@prisma/client";
import type { SyncResult } from "@/server/sync/gmail";

/**
 * Mirrors Calendar events that involve a known candidate.
 *
 * Interviews are the highest-signal event in recruiting: an event being booked
 * means the stage started, and the event ending means it is done. Both become
 * automation triggers here.
 */
export async function syncCalendar(
  account: GoogleAccount,
  orgId: string,
  options: { backfillDays?: number; lookaheadDays?: number } = {},
): Promise<SyncResult> {
  const backfillDays = options.backfillDays ?? 30;
  const lookaheadDays = options.lookaheadDays ?? 90;
  const result: SyncResult = { seen: 0, linked: 0, rulesFired: 0 };

  const auth = await clientForAccount(account);
  const calendar = calendarFor(auth);

  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - backfillDays);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + lookaheadDays);

  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
    let response;
    try {
      response = await calendar.events.list({
        calendarId: "primary",
        singleEvents: true,
        maxResults: 250,
        pageToken,
        ...(account.calendarSyncToken && !pageToken
          ? { syncToken: account.calendarSyncToken }
          : {
              timeMin: timeMin.toISOString(),
              timeMax: timeMax.toISOString(),
              orderBy: "startTime",
            }),
      });
    } catch (err: unknown) {
      // 410 GONE means the sync token expired — restart from a full window.
      if ((err as { code?: number })?.code === 410) {
        await prisma.googleAccount.update({
          where: { id: account.id },
          data: { calendarSyncToken: null },
        });
        return syncCalendar({ ...account, calendarSyncToken: null }, orgId, options);
      }
      throw err;
    }

    for (const event of response.data.items ?? []) {
      result.seen++;
      if (!event.id) continue;

      const attendees = (event.attendees ?? [])
        .map((a) => a.email?.toLowerCase())
        .filter((e): e is string => Boolean(e));

      const match = await matchWithJobHint(
        orgId,
        attendees,
        [event.summary, event.description].filter(Boolean).join("\n"),
      );
      if (!match) continue;

      const startsAt = event.start?.dateTime
        ? new Date(event.start.dateTime)
        : event.start?.date
          ? new Date(event.start.date)
          : null;
      const endsAt = event.end?.dateTime
        ? new Date(event.end.dateTime)
        : event.end?.date
          ? new Date(event.end.date)
          : null;
      if (!startsAt || !endsAt) continue;

      const status: EventStatus =
        event.status === "cancelled"
          ? "CANCELLED"
          : event.status === "tentative"
            ? "TENTATIVE"
            : "CONFIRMED";

      const meetLink =
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
          ?.uri ??
        null;

      const existing = await prisma.calendarEvent.findUnique({
        where: { orgId_googleEventId: { orgId, googleEventId: event.id } },
      });

      const record = await prisma.calendarEvent.upsert({
        where: { orgId_googleEventId: { orgId, googleEventId: event.id } },
        create: {
          orgId,
          applicationId: match.application?.id ?? null,
          googleEventId: event.id,
          title: event.summary ?? "(untitled event)",
          description: event.description ?? null,
          location: event.location ?? null,
          meetLink,
          startsAt,
          endsAt,
          attendees,
          organizerEmail: event.organizer?.email ?? null,
          status,
        },
        update: {
          title: event.summary ?? "(untitled event)",
          description: event.description ?? null,
          location: event.location ?? null,
          meetLink,
          startsAt,
          endsAt,
          attendees,
          status,
        },
      });
      result.linked++;

      if (!match.application) continue;

      const isNew = !existing;
      const becameCancelled = existing?.status !== "CANCELLED" && status === "CANCELLED";

      if (becameCancelled) {
        await logActivity({
          orgId,
          applicationId: match.application.id,
          candidateId: match.candidate.id,
          type: "INTERVIEW_CANCELLED",
          title: `Interview cancelled: ${record.title}`,
          actorType: "SYNC",
          externalId: event.id,
          occurredAt: new Date(),
        });
        const outcomes = await dispatchEvent({
          orgId,
          applicationId: match.application.id,
          trigger: "CALENDAR_EVENT_CANCELLED",
          payload: {
            title: record.title,
            body: record.description,
            externalId: event.id,
          },
        });
        result.rulesFired += outcomes.filter((o) => o.applied).length;
      } else if (isNew && status !== "CANCELLED") {
        await logActivity({
          orgId,
          applicationId: match.application.id,
          candidateId: match.candidate.id,
          type: "INTERVIEW_SCHEDULED",
          title: `Scheduled: ${record.title}`,
          body: `${startsAt.toISOString()} — ${attendees.join(", ")}`,
          actorType: "SYNC",
          externalId: event.id,
          occurredAt: startsAt,
        });
        const outcomes = await dispatchEvent({
          orgId,
          applicationId: match.application.id,
          trigger: "CALENDAR_EVENT_SCHEDULED",
          payload: {
            title: record.title,
            body: record.description,
            externalId: event.id,
            occurredAt: startsAt,
          },
        });
        result.rulesFired += outcomes.filter((o) => o.applied).length;

        // Tie the event to whichever stage it represents so the tracker can
        // show "interview booked for Thursday" against the right step.
        const app = await prisma.application.findUnique({
          where: { id: match.application.id },
          select: { currentStageId: true },
        });
        if (app?.currentStageId) {
          await prisma.calendarEvent.update({
            where: { id: record.id },
            data: { stageId: app.currentStageId },
          });
        }
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
    nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  await prisma.googleAccount.update({
    where: { id: account.id },
    data: {
      calendarSyncToken: nextSyncToken ?? account.calendarSyncToken,
      lastSyncedAt: new Date(),
    },
  });

  return result;
}

/**
 * Fires CALENDAR_EVENT_COMPLETED for interviews that have finished.
 *
 * Google has no "event ended" push notification, so this is a sweep. The
 * `completedHandledAt` stamp makes it idempotent.
 */
export async function processCompletedEvents(orgId: string): Promise<number> {
  const now = new Date();

  const finished = await prisma.calendarEvent.findMany({
    where: {
      orgId,
      status: "CONFIRMED",
      endsAt: { lt: now },
      completedHandledAt: null,
      applicationId: { not: null },
    },
    include: { application: { select: { candidateId: true } } },
    take: 200,
  });

  let fired = 0;
  for (const event of finished) {
    if (!event.applicationId) continue;

    await logActivity({
      orgId,
      applicationId: event.applicationId,
      candidateId: event.application?.candidateId ?? null,
      type: "INTERVIEW_COMPLETED",
      title: `Interview completed: ${event.title}`,
      actorType: "SYNC",
      externalId: event.googleEventId,
      occurredAt: event.endsAt,
    });

    const outcomes = await dispatchEvent({
      orgId,
      applicationId: event.applicationId,
      trigger: "CALENDAR_EVENT_COMPLETED",
      payload: {
        title: event.title,
        body: event.description,
        externalId: event.googleEventId,
        occurredAt: event.endsAt,
      },
    });
    fired += outcomes.filter((o) => o.applied).length;

    await prisma.calendarEvent.update({
      where: { id: event.id },
      data: { completedHandledAt: now },
    });
  }

  return fired;
}

/** Books an interview on the recruiter's calendar and invites the candidate. */
export async function scheduleInterview(params: {
  account: GoogleAccount;
  orgId: string;
  applicationId: string;
  title: string;
  startsAt: Date;
  durationMinutes: number;
  attendeeEmails: string[];
  description?: string;
  actorId?: string | null;
}): Promise<string> {
  const auth = await clientForAccount(params.account);
  const calendar = calendarFor(auth);

  const endsAt = new Date(params.startsAt.getTime() + params.durationMinutes * 60_000);

  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: params.title,
      description: params.description,
      start: { dateTime: params.startsAt.toISOString() },
      end: { dateTime: endsAt.toISOString() },
      attendees: params.attendeeEmails.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `rec-${params.applicationId}-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    select: { candidateId: true, currentStageId: true },
  });

  if (res.data.id) {
    await prisma.calendarEvent.upsert({
      where: { orgId_googleEventId: { orgId: params.orgId, googleEventId: res.data.id } },
      create: {
        orgId: params.orgId,
        applicationId: params.applicationId,
        stageId: application?.currentStageId ?? null,
        googleEventId: res.data.id,
        title: params.title,
        description: params.description ?? null,
        meetLink: res.data.hangoutLink ?? null,
        startsAt: params.startsAt,
        endsAt,
        attendees: params.attendeeEmails,
        organizerEmail: params.account.email,
        status: "CONFIRMED",
      },
      update: {},
    });
  }

  await logActivity({
    orgId: params.orgId,
    applicationId: params.applicationId,
    candidateId: application?.candidateId ?? null,
    type: "INTERVIEW_SCHEDULED",
    title: `Scheduled: ${params.title}`,
    body: params.startsAt.toISOString(),
    actorType: "USER",
    actorId: params.actorId ?? null,
    externalId: res.data.id ?? null,
  });

  await dispatchEvent({
    orgId: params.orgId,
    applicationId: params.applicationId,
    trigger: "CALENDAR_EVENT_SCHEDULED",
    payload: {
      title: params.title,
      body: params.description ?? null,
      externalId: res.data.id ?? null,
      occurredAt: params.startsAt,
    },
  });

  return res.data.id ?? "";
}
