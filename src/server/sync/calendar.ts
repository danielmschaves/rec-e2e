import { prisma } from "@/lib/prisma";
import { clientForAccount, calendarFor } from "@/lib/google";
import { matchByEmails } from "@/server/sync/match";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount, EventStatus } from "@prisma/client";
import type { SyncResult } from "@/server/sync/gmail";

/**
 * Mirrors calendar events that involve a company you're interviewing with.
 *
 * Interviews are the highest-signal event in a job search: an invite landing
 * means the stage started, and the event ending means it's done. Both become
 * automation triggers here.
 */
export async function syncCalendar(
  account: GoogleAccount,
  userId: string,
  options: { backfillDays?: number; lookaheadDays?: number } = {},
): Promise<SyncResult> {
  const backfillDays = options.backfillDays ?? 30;
  const lookaheadDays = options.lookaheadDays ?? 90;
  const result: SyncResult = { seen: 0, linked: 0, rulesFired: 0, detected: 0 };

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
        return syncCalendar({ ...account, calendarSyncToken: null }, userId, options);
      }
      throw err;
    }

    for (const event of response.data.items ?? []) {
      result.seen++;
      if (!event.id) continue;

      const attendees = (event.attendees ?? [])
        .map((a) => a.email?.toLowerCase())
        .filter((e): e is string => Boolean(e));
      const participants = [...attendees, event.organizer?.email?.toLowerCase()].filter(
        (e): e is string => Boolean(e),
      );

      const match = await matchByEmails(
        userId,
        participants,
        [event.summary, event.description].filter(Boolean).join("\n"),
      );
      if (!match?.opportunity) continue;
      const opportunity = match.opportunity;

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
        event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
        null;

      const existing = await prisma.calendarEvent.findUnique({
        where: { userId_googleEventId: { userId, googleEventId: event.id } },
      });

      const record = await prisma.calendarEvent.upsert({
        where: { userId_googleEventId: { userId, googleEventId: event.id } },
        create: {
          userId,
          opportunityId: opportunity.id,
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

      const isNew = !existing;
      const becameCancelled = existing?.status !== "CANCELLED" && status === "CANCELLED";

      if (becameCancelled) {
        await logActivity({
          userId,
          opportunityId: opportunity.id,
          type: "INTERVIEW_CANCELLED",
          title: `Cancelled: ${record.title}`,
          actorType: "SYNC",
          externalId: event.id,
        });
        const outcomes = await dispatchEvent({
          userId,
          opportunityId: opportunity.id,
          trigger: "CALENDAR_EVENT_CANCELLED",
          payload: { title: record.title, body: record.description, externalId: event.id },
        });
        result.rulesFired += outcomes.filter((o) => o.applied).length;
      } else if (isNew && status !== "CANCELLED") {
        await logActivity({
          userId,
          opportunityId: opportunity.id,
          type: "INTERVIEW_SCHEDULED",
          title: `Scheduled: ${record.title}`,
          body: startsAt.toISOString(),
          actorType: "SYNC",
          externalId: event.id,
          occurredAt: startsAt,
        });
        const outcomes = await dispatchEvent({
          userId,
          opportunityId: opportunity.id,
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
        const fresh = await prisma.opportunity.findUnique({
          where: { id: opportunity.id },
          select: { currentStageId: true },
        });
        if (fresh?.currentStageId) {
          await prisma.calendarEvent.update({
            where: { id: record.id },
            data: { stageId: fresh.currentStageId },
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
export async function processCompletedEvents(userId: string): Promise<number> {
  const now = new Date();

  const finished = await prisma.calendarEvent.findMany({
    where: {
      userId,
      status: "CONFIRMED",
      endsAt: { lt: now },
      completedHandledAt: null,
      opportunityId: { not: null },
    },
    take: 200,
  });

  let fired = 0;
  for (const event of finished) {
    if (!event.opportunityId) continue;

    await logActivity({
      userId,
      opportunityId: event.opportunityId,
      type: "INTERVIEW_COMPLETED",
      title: `Done: ${event.title}`,
      actorType: "SYNC",
      externalId: event.googleEventId,
      occurredAt: event.endsAt,
    });

    const outcomes = await dispatchEvent({
      userId,
      opportunityId: event.opportunityId,
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
