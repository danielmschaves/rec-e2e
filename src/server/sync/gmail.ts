import { prisma } from "@/lib/prisma";
import { clientForAccount, gmailFor, parseAddress, parseAddressList } from "@/lib/google";
import { matchWithJobHint } from "@/server/sync/match";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount } from "@prisma/client";
import type { gmail_v1 } from "googleapis";

export type SyncResult = {
  seen: number;
  linked: number;
  rulesFired: number;
  error?: string;
};

/** Walks a MIME tree and returns the first text/plain part, decoded. */
function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!payload) return null;

  const decode = (data: string) =>
    Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const found = extractPlainText(part);
    if (found) return found;
  }

  // Fall back to stripping tags out of an HTML-only message.
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return null;
}

function header(message: gmail_v1.Schema$Message, name: string): string | undefined {
  return message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? undefined;
}

/**
 * Pulls new Gmail messages for one connected account, links them to candidates
 * and lets the automation engine react.
 *
 * Uses the history API when we have a cursor (cheap, incremental) and falls
 * back to a bounded message list for the very first sync.
 */
export async function syncGmail(
  account: GoogleAccount,
  orgId: string,
  options: { backfillDays?: number; maxMessages?: number } = {},
): Promise<SyncResult> {
  const backfillDays = options.backfillDays ?? 30;
  const maxMessages = options.maxMessages ?? 100;

  const result: SyncResult = { seen: 0, linked: 0, rulesFired: 0 };

  const auth = await clientForAccount(account);
  const gmail = gmailFor(auth);

  let messageIds: string[] = [];
  let usedHistory = false;

  if (account.gmailHistoryId) {
    try {
      const history = await gmail.users.history.list({
        userId: "me",
        startHistoryId: account.gmailHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 500,
      });
      messageIds = (history.data.history ?? [])
        .flatMap((h) => h.messagesAdded ?? [])
        .map((m) => m.message?.id)
        .filter((id): id is string => Boolean(id));
      usedHistory = true;
    } catch (err: unknown) {
      // A 404 means the cursor aged out (Gmail keeps ~1 week of history).
      // Drop it and fall through to a bounded list.
      const status = (err as { code?: number })?.code;
      if (status !== 404) throw err;
      usedHistory = false;
    }
  }

  if (!usedHistory) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: `newer_than:${backfillDays}d -in:chats`,
      maxResults: maxMessages,
    });
    messageIds = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));
  }

  const unique = [...new Set(messageIds)].slice(0, maxMessages);

  for (const id of unique) {
    result.seen++;

    const existing = await prisma.emailMessage.findUnique({
      where: { orgId_gmailId: { orgId, gmailId: id } },
    });
    if (existing) continue;

    let message: gmail_v1.Schema$Message;
    try {
      const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      message = res.data;
    } catch {
      continue; // Message deleted between list and get.
    }

    const from = parseAddress(header(message, "From"));
    const to = parseAddressList(header(message, "To"));
    const cc = parseAddressList(header(message, "Cc"));
    const subject = header(message, "Subject") ?? null;
    const dateHeader = header(message, "Date");
    const sentAt = dateHeader
      ? new Date(dateHeader)
      : new Date(Number(message.internalDate ?? Date.now()));

    const accountEmail = account.email.toLowerCase();
    const direction = from.email === accountEmail ? "OUTBOUND" : "INBOUND";

    // The candidate is whoever is on the other end of the conversation.
    const counterparts =
      direction === "OUTBOUND" ? [...to, ...cc] : [from.email, ...cc];

    const bodyText = extractPlainText(message.payload);
    const match = await matchWithJobHint(
      orgId,
      counterparts,
      [subject, bodyText?.slice(0, 2000)].filter(Boolean).join("\n"),
    );

    // Unmatched mail is ordinary inbox traffic — skip it rather than storing
    // the recruiter's entire mailbox.
    if (!match) continue;

    await prisma.emailMessage.create({
      data: {
        orgId,
        applicationId: match.application?.id ?? null,
        candidateId: match.candidate.id,
        gmailId: id,
        threadId: message.threadId ?? id,
        direction,
        subject,
        snippet: message.snippet ?? null,
        bodyText: bodyText?.slice(0, 20000) ?? null,
        fromEmail: from.email,
        fromName: from.name,
        toEmails: to,
        ccEmails: cc,
        labels: message.labelIds ?? [],
        sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
      },
    });
    result.linked++;

    // Keep the application pinned to the thread so replies group cleanly.
    if (match.application && !match.application.emailThreadId && message.threadId) {
      await prisma.application.update({
        where: { id: match.application.id },
        data: { emailThreadId: message.threadId },
      });
    }

    await logActivity({
      orgId,
      applicationId: match.application?.id ?? null,
      candidateId: match.candidate.id,
      type: direction === "INBOUND" ? "EMAIL_RECEIVED" : "EMAIL_SENT",
      title:
        direction === "INBOUND"
          ? `Email from ${match.candidate.fullName}: ${subject ?? "(no subject)"}`
          : `Email sent to ${match.candidate.fullName}: ${subject ?? "(no subject)"}`,
      body: message.snippet ?? null,
      actorType: "SYNC",
      externalId: id,
      occurredAt: sentAt,
    });

    if (match.application) {
      const outcomes = await dispatchEvent({
        orgId,
        applicationId: match.application.id,
        trigger:
          direction === "INBOUND"
            ? "EMAIL_RECEIVED_FROM_CANDIDATE"
            : "EMAIL_SENT_TO_CANDIDATE",
        payload: {
          title: subject,
          body: bodyText,
          fromEmail: from.email,
          externalId: id,
          occurredAt: sentAt,
        },
      });
      result.rulesFired += outcomes.filter((o) => o.applied).length;
    }
  }

  // Advance the cursor to wherever the mailbox is now.
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    if (profile.data.historyId) {
      await prisma.googleAccount.update({
        where: { id: account.id },
        data: {
          gmailHistoryId: String(profile.data.historyId),
          lastSyncedAt: new Date(),
          lastError: null,
        },
      });
    }
  } catch {
    // Non-fatal: we simply re-list next time.
  }

  return result;
}

/** Sends a message as the connected user and mirrors it into the timeline. */
export async function sendEmail(params: {
  account: GoogleAccount;
  orgId: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  applicationId?: string | null;
  candidateId?: string | null;
  actorId?: string | null;
}): Promise<string> {
  const auth = await clientForAccount(params.account);
  const gmail = gmailFor(auth);

  const mime = [
    `From: ${params.account.email}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    params.body,
  ].join("\r\n");

  const raw = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: params.threadId ?? undefined },
  });

  const messageId = res.data.id ?? "";

  if (messageId) {
    await prisma.emailMessage.upsert({
      where: { orgId_gmailId: { orgId: params.orgId, gmailId: messageId } },
      create: {
        orgId: params.orgId,
        applicationId: params.applicationId ?? null,
        candidateId: params.candidateId ?? null,
        gmailId: messageId,
        threadId: res.data.threadId ?? messageId,
        direction: "OUTBOUND",
        subject: params.subject,
        snippet: params.body.slice(0, 200),
        bodyText: params.body,
        fromEmail: params.account.email,
        toEmails: [params.to],
        sentAt: new Date(),
      },
      update: {},
    });
  }

  await logActivity({
    orgId: params.orgId,
    applicationId: params.applicationId ?? null,
    candidateId: params.candidateId ?? null,
    type: "EMAIL_SENT",
    title: `Email sent: ${params.subject}`,
    body: params.body.slice(0, 500),
    actorType: "USER",
    actorId: params.actorId ?? null,
    externalId: messageId,
  });

  if (params.applicationId) {
    await dispatchEvent({
      orgId: params.orgId,
      applicationId: params.applicationId,
      trigger: "EMAIL_SENT_TO_CANDIDATE",
      payload: {
        title: params.subject,
        body: params.body,
        fromEmail: params.account.email,
        externalId: messageId,
      },
    });
  }

  return messageId;
}
