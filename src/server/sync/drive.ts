import { prisma } from "@/lib/prisma";
import { clientForAccount, driveFor } from "@/lib/google";
import { pickApplication } from "@/server/sync/match";
import { dispatchEvent } from "@/server/automation";
import { logActivity } from "@/server/activity";
import type { GoogleAccount, DriveFileKind } from "@prisma/client";
import type { SyncResult } from "@/server/sync/gmail";
import type { drive_v3 } from "googleapis";

/** Guesses what a document is from its filename. */
export function inferKind(name: string): DriveFileKind {
  const n = name.toLowerCase();
  if (/\b(cv|resume|curriculo|currículo)\b/.test(n)) return "RESUME";
  if (/cover\s*letter|carta/.test(n)) return "COVER_LETTER";
  if (/offer|proposta/.test(n)) return "OFFER_LETTER";
  if (/portfolio|portf[oó]lio/.test(n)) return "PORTFOLIO";
  if (/assessment|challenge|test|desafio|teste/.test(n)) return "ASSESSMENT";
  if (/notes|scorecard|feedback/.test(n)) return "NOTES";
  return "OTHER";
}

/**
 * Drive has no candidate email in its metadata, so we match on the two signals
 * that do exist: the file living in a candidate's folder, or the candidate's
 * name/email appearing in the filename.
 */
async function matchFile(
  orgId: string,
  file: drive_v3.Schema$File,
): Promise<{ candidateId: string | null; applicationId: string | null } | null> {
  const parents = file.parents ?? [];

  if (parents.length > 0) {
    const byFolder = await prisma.application.findFirst({
      where: { orgId, driveFolderId: { in: parents } },
    });
    if (byFolder) {
      return { candidateId: byFolder.candidateId, applicationId: byFolder.id };
    }

    const byJobFolder = await prisma.job.findFirst({
      where: { orgId, driveFolderId: { in: parents } },
    });
    if (byJobFolder) {
      // A job folder tells us the job but not the person — fall through to the
      // name check below, scoped to that job.
      const name = file.name?.toLowerCase() ?? "";
      const candidates = await prisma.candidate.findMany({
        where: { orgId, applications: { some: { jobId: byJobFolder.id } } },
      });
      const hit = candidates.find(
        (c) =>
          name.includes(c.fullName.toLowerCase()) ||
          name.includes(c.email.toLowerCase().split("@")[0]),
      );
      if (hit) {
        const app = await pickApplication(hit.id, byJobFolder.id);
        return { candidateId: hit.id, applicationId: app?.id ?? null };
      }
    }
  }

  const name = file.name?.toLowerCase();
  if (!name) return null;

  const candidates = await prisma.candidate.findMany({ where: { orgId } });
  const hit = candidates.find((c) => {
    const local = c.email.toLowerCase().split("@")[0];
    return (
      name.includes(c.fullName.toLowerCase()) ||
      (local.length >= 4 && name.includes(local))
    );
  });
  if (!hit) return null;

  const app = await pickApplication(hit.id);
  return { candidateId: hit.id, applicationId: app?.id ?? null };
}

/** Mirrors candidate-related Drive files into the application timeline. */
export async function syncDrive(
  account: GoogleAccount,
  orgId: string,
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
      where: { orgId_googleFileId: { orgId, googleFileId: file.id } },
    });
    if (existing) continue;

    const match = await matchFile(orgId, file);
    if (!match) continue;

    const kind = inferKind(file.name);

    await prisma.driveFile.create({
      data: {
        orgId,
        applicationId: match.applicationId,
        candidateId: match.candidateId,
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
      orgId,
      applicationId: match.applicationId,
      candidateId: match.candidateId,
      type: "FILE_ATTACHED",
      title: `Document added: ${file.name}`,
      body: kind.replace("_", " ").toLowerCase(),
      actorType: "SYNC",
      externalId: file.id,
      occurredAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(),
    });

    if (match.applicationId) {
      const outcomes = await dispatchEvent({
        orgId,
        applicationId: match.applicationId,
        trigger: "DRIVE_FILE_ADDED",
        payload: {
          title: file.name,
          mimeType: file.mimeType,
          externalId: file.id,
        },
      });
      result.rulesFired += outcomes.filter((o) => o.applied).length;
    }
  }

  if (newStartPageToken) {
    await prisma.googleAccount.update({
      where: { id: account.id },
      data: { driveStartPageToken: newStartPageToken, lastSyncedAt: new Date() },
    });
  }

  return result;
}

/** Creates (once) a Drive folder for an application's documents. */
export async function ensureApplicationFolder(params: {
  account: GoogleAccount;
  applicationId: string;
}): Promise<string | null> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { candidate: true, job: true },
  });
  if (!application) return null;
  if (application.driveFolderId) return application.driveFolderId;

  const auth = await clientForAccount(params.account);
  const drive = driveFor(auth);

  const res = await drive.files.create({
    requestBody: {
      name: `${application.candidate.fullName} — ${application.job.title}`,
      mimeType: "application/vnd.google-apps.folder",
      parents: application.job.driveFolderId ? [application.job.driveFolderId] : undefined,
    },
    fields: "id",
  });

  const folderId = res.data.id ?? null;
  if (folderId) {
    await prisma.application.update({
      where: { id: application.id },
      data: { driveFolderId: folderId },
    });
  }
  return folderId;
}
