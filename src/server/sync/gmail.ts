import { prisma } from "@/lib/prisma";
import { clientForAccount, gmailFor, parseAddress, parseAddressList } from "@/lib/google";
import { matchByEmails } from "@/server/sync/match";
import { detectApplication, createFromDetection } from "@/server/sync/detect";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount } from "@prisma/client";
import type { gmail_v1 } from "googleapis";

export type SyncResult = {
  seen: number;
  linked: number;
  rulesFired: number;
  /** New processes created from application confirmations. */
  detected: number;
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
  return (
    message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? undefined
  );
}

/**
 * Pulls new mail from your inbox, links anything from a company you're in a
 * process with, and lets the automation engine react.
 *
 * Uses the history API when we have a cursor (cheap, incremental) and falls
 * back to a bounded message list for the very first sync.
 */
export async function syncGmail(
  account: GoogleAccount,
  userId: string,
  options: { backfillDays?: number; maxMessages?: number } = {},
): Promise<SyncResult> {
  const backfillDays = options.backfillDays ?? 30;
  const maxMessages = options.maxMessages ?? 100;

  const result: SyncResult = { seen: 0, linked: 0, rulesFired: 0, detected: 0 };

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
      if ((err as { code?: number })?.code !== 404) throw err;
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
      where: { userId_gmailId: { userId, gmailId: id } },
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

    // The company is whoever is on the other end of the conversation.
    const counterparts = direction === "OUTBOUND" ? [...to, ...cc] : [from.email, ...cc];

    const bodyText = extractPlainText(message.payload);
    const match = await matchByEmails(
      userId,
      counterparts,
      [subject, bodyText?.slice(0, 2000)].filter(Boolean).join("\n"),
    );

    let opportunity = match?.opportunity ?? null;
    let detectedNew = false;

    // Nothing matched. Before discarding, check whether this is a confirmation
    // that you applied somewhere new — that is how a process gets tracked
    // without you typing anything.
    if (!opportunity && direction === "INBOUND") {
      const detected = await detectApplication({
        fromEmail: from.email,
        fromName: from.name,
        subject,
        body: bodyText,
      });

      if (detected) {
        const created = await createFromDetection({
          userId,
          detected,
          gmailId: id,
          receivedAt: sentAt,
          senderEmail: from.email,
        });
        if (created) {
          opportunity = created;
          detectedNew = true;
          result.detected++;
        }
      }
    }

    // Still nothing — ordinary inbox traffic. Skip it rather than copying your
    // whole mailbox into the tracker.
    if (!opportunity) continue;

    await prisma.emailMessage.create({
      data: {
        userId,
        opportunityId: opportunity.id,
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

    // Keep the opportunity pinned to the thread so replies group cleanly.
    if (!opportunity.emailThreadId && message.threadId) {
      await prisma.opportunity.update({
        where: { id: opportunity.id },
        data: { emailThreadId: message.threadId },
      });
    }

    await logActivity({
      userId,
      opportunityId: opportunity.id,
      type: direction === "INBOUND" ? "EMAIL_RECEIVED" : "EMAIL_SENT",
      title:
        direction === "INBOUND"
          ? `Email from ${from.name ?? from.email}: ${subject ?? "(no subject)"}`
          : `You emailed ${to[0] ?? "them"}: ${subject ?? "(no subject)"}`,
      body: message.snippet ?? null,
      actorType: "SYNC",
      externalId: id,
      occurredAt: sentAt,
      meta: { matchedVia: match?.via ?? "detected" },
    });

    // The confirmation that created a process must not also be treated as
    // "they replied" — that would complete the Applied stage the instant it
    // was entered.
    if (detectedNew) continue;

    const outcomes = await dispatchEvent({
      userId,
      opportunityId: opportunity.id,
      trigger:
        direction === "INBOUND" ? "EMAIL_RECEIVED_FROM_COMPANY" : "EMAIL_SENT_TO_COMPANY",
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

/**
 * Sends an approved draft.
 *
 * This is only ever called from an explicit user action — the assistant writes
 * drafts, it never reaches this function.
 */
export async function sendDraft(params: {
  account: GoogleAccount;
  userId: string;
  draftId: string;
}): Promise<string> {
  const draft = await prisma.emailDraft.findFirst({
    where: { id: params.draftId, userId: params.userId },
  });
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "DRAFT") throw new Error("That draft was already handled");

  const auth = await clientForAccount(params.account);
  const gmail = gmailFor(auth);

  const mime = [
    `From: ${params.account.email}`,
    `To: ${draft.toEmail}`,
    `Subject: ${draft.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    draft.body,
  ].join("\r\n");

  const raw = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: draft.threadId ?? undefined },
  });

  const messageId = res.data.id ?? "";

  await prisma.emailDraft.update({
    where: { id: draft.id },
    data: { status: "SENT", sentAt: new Date(), gmailId: messageId || null },
  });

  if (messageId) {
    await prisma.emailMessage.upsert({
      where: { userId_gmailId: { userId: params.userId, gmailId: messageId } },
      create: {
        userId: params.userId,
        opportunityId: draft.opportunityId,
        gmailId: messageId,
        threadId: res.data.threadId ?? messageId,
        direction: "OUTBOUND",
        subject: draft.subject,
        snippet: draft.body.slice(0, 200),
        bodyText: draft.body,
        fromEmail: params.account.email,
        toEmails: [draft.toEmail],
        sentAt: new Date(),
      },
      update: {},
    });
  }

  await logActivity({
    userId: params.userId,
    opportunityId: draft.opportunityId,
    type: "EMAIL_SENT",
    title: `Sent: ${draft.subject}`,
    body: draft.body.slice(0, 500),
    actorType: "USER",
    externalId: messageId,
  });

  if (draft.opportunityId) {
    await dispatchEvent({
      userId: params.userId,
      opportunityId: draft.opportunityId,
      trigger: "EMAIL_SENT_TO_COMPANY",
      payload: {
        title: draft.subject,
        body: draft.body,
        fromEmail: params.account.email,
        externalId: messageId,
      },
    });
  }

  return messageId;
}
