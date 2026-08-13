import { prisma } from "@/lib/prisma";
import { clientForAccount, driveFor } from "@/lib/google";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount, DriveFileKind } from "@prisma/client";
import type { SyncResult } from "@/server/sync/gmail";
import type { drive_v3 } from "googleapis";

/** Guesses what a document is from its filename. */
export function inferKind(name: string): DriveFileKind {
  const n = name.toLowerCase();
  if (/\b(cv|resume|curriculo|currículo)\b/.test(n)) return "CV";
  if (/cover\s*letter|carta/.test(n)) return "COVER_LETTER";
  if (/offer|proposta/.test(n)) return "OFFER_LETTER";
  if (/portfolio|portf[oó]lio/.test(n)) return "PORTFOLIO";
  if (/brief|spec|assignment|take[-\s]?home/.test(n)) return "CHALLENGE_BRIEF";
  if (/solution|submission|challenge|desafio/.test(n)) return "CHALLENGE_SOLUTION";
  if (/research|notes|prep/.test(n)) return "RESEARCH";
  return "OTHER";
}

/**
 * Drive metadata has no company address in it, so we match on the two signals
 * that do exist: the file living in an opportunity's folder, or the company or
 * role name appearing in the filename ("Acme take-home.md").
 */
async function matchFile(
  userId: string,
  file: drive_v3.Schema$File,
): Promise<string | null> {
  const parents = file.parents ?? [];

  if (parents.length > 0) {
    const byFolder = await prisma.opportunity.findFirst({
      where: { userId, driveFolderId: { in: parents } },
    });
    if (byFolder) return byFolder.id;
  }

  const name = file.name?.toLowerCase();
  if (!name) return null;

  const opportunities = await prisma.opportunity.findMany({
    where: { userId, status: { in: ["ACTIVE", "ON_HOLD", "OFFER"] } },
    include: { company: true },
    orderBy: { lastActivityAt: "desc" },
  });

  const hit = opportunities.find((o) => {
    const company = o.company.name.toLowerCase();
    // Require a reasonably distinctive company name to avoid matching "Co".
    return company.length >= 3 && name.includes(company);
  });

  return hit?.id ?? null;
}

/** Mirrors job-search-related Drive files into the right process timeline. */
export async function syncDrive(
  account: GoogleAccount,
  userId: string,
  options: { maxFiles?: number } = {},
): Promise<SyncResult> {
  const maxFiles = options.maxFiles ?? 200;
  const result: SyncResult = { seen: 0, linked: 0, rulesFired: 0 };

  const auth = await clientForAccount(account);
  const drive = driveFor(auth);

  const fields =
    "id, name, mimeType, webViewLink, iconLink, size, modifiedTime, parents, trashed";

  let files: drive_v3.Schema$File[] = [];
  let newStartPageToken: string | null = null;

  if (account.driveStartPageToken) {
    let pageToken: string | undefined = account.driveStartPageToken;
    while (pageToken && files.length < maxFiles) {
      const res: { data: drive_v3.Schema$ChangeList } = await drive.changes.list({
        pageToken,
        pageSize: 100,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${fields}))`,
      });
      for (const change of res.data.changes ?? []) {
        if (change.removed || change.file?.trashed) continue;
        if (change.file) files.push(change.file);
      }
      newStartPageToken = res.data.newStartPageToken ?? newStartPageToken;
      pageToken = res.data.nextPageToken ?? undefined;
    }
  } else {
    const res = await drive.files.list({
      pageSize: Math.min(maxFiles, 100),
      orderBy: "modifiedTime desc",
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: `files(${fields})`,
    });
    files = res.data.files ?? [];

    const token = await drive.changes.getStartPageToken({});
    newStartPageToken = token.data.startPageToken ?? null;
  }

  for (const file of files.slice(0, maxFiles)) {
    result.seen++;
    if (!file.id || !file.name) continue;

    const existing = await prisma.driveFile.findUnique({
      where: { userId_googleFileId: { userId, googleFileId: file.id } },
    });
    if (existing) continue;

    const opportunityId = await matchFile(userId, file);
    if (!opportunityId) continue;

    const kind = inferKind(file.name);

    await prisma.driveFile.create({
      data: {
        userId,
        opportunityId,
        googleFileId: file.id,
        name: file.name,
        mimeType: file.mimeType ?? "application/octet-stream",
        kind,
        webViewLink: file.webViewLink ?? null,
        iconLink: file.iconLink ?? null,
        sizeBytes: file.size ? BigInt(file.size) : null,
        modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
      },
    });
    result.linked++;

    await logActivity({
      userId,
      opportunityId,
      type: "FILE_ATTACHED",
      title: `Document: ${file.name}`,
      body: kind.replace("_", " ").toLowerCase(),
      actorType: "SYNC",
      externalId: file.id,
      occurredAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(),
    });

    const outcomes = await dispatchEvent({
      userId,
      opportunityId,
      trigger: "DRIVE_FILE_ADDED",
      payload: { title: file.name, mimeType: file.mimeType, externalId: file.id },
    });
    result.rulesFired += outcomes.filter((o) => o.applied).length;
  }

  if (newStartPageToken) {
    await prisma.googleAccount.update({
      where: { id: account.id },
      data: { driveStartPageToken: newStartPageToken, lastSyncedAt: new Date() },
    });
  }

  return result;
}
