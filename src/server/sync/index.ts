import { prisma } from "@/lib/prisma";
import { syncGmail } from "@/server/sync/gmail";
import { syncCalendar, processCompletedEvents } from "@/server/sync/calendar";
import { syncDrive } from "@/server/sync/drive";
import { checkQuietStages } from "@/server/automation";
import type { SyncProvider } from "@prisma/client";

export type ProviderResult = {
  provider: SyncProvider;
  seen: number;
  linked: number;
  rulesFired: number;
  error?: string;
};

/**
 * Runs all three Google syncs for the connected account.
 *
 * Each provider is isolated: a Gmail failure must not stop Calendar from
 * syncing, so failures are captured per provider rather than thrown.
 */
export async function syncAccount(userId: string): Promise<ProviderResult[]> {
  const account = await prisma.googleAccount.findUnique({ where: { userId } });
  if (!account) throw new Error("No Google account connected");
  if (!account.syncEnabled) return [];

  const results: ProviderResult[] = [];

  const providers: Array<{
    provider: SyncProvider;
    run: () => Promise<{ seen: number; linked: number; rulesFired: number }>;
  }> = [
    { provider: "GMAIL", run: () => syncGmail(account, userId) },
    { provider: "CALENDAR", run: () => syncCalendar(account, userId) },
    { provider: "DRIVE", run: () => syncDrive(account, userId) },
  ];

  for (const { provider, run } of providers) {
    const runRecord = await prisma.syncRun.create({
      data: { userId, provider, status: "RUNNING" },
    });

    try {
      const res = await run();
      await prisma.syncRun.update({
        where: { id: runRecord.id },
        data: {
          status: "SUCCESS",
          itemsSeen: res.seen,
          itemsLinked: res.linked,
          rulesFired: res.rulesFired,
          finishedAt: new Date(),
        },
      });
      results.push({ provider, ...res });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.syncRun.update({
        where: { id: runRecord.id },
        data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
      });
      await prisma.googleAccount.update({
        where: { id: account.id },
        data: { lastError: message.slice(0, 500) },
      });
      results.push({ provider, seen: 0, linked: 0, rulesFired: 0, error: message });
    }
  }

  // Time-based triggers that do not depend on a Google call.
  await processCompletedEvents(userId);
  await checkQuietStages(userId);

  return results;
}

/** Syncs every connected account. Used by the scheduler. */
export async function syncAllAccounts(): Promise<{
  accounts: number;
  results: ProviderResult[];
}> {
  const accounts = await prisma.googleAccount.findMany({
    where: { syncEnabled: true },
    select: { userId: true },
  });

  const results: ProviderResult[] = [];
  for (const account of accounts) {
    try {
      results.push(...(await syncAccount(account.userId)));
    } catch (err) {
      console.error(`[sync] account ${account.userId} failed:`, err);
    }
  }

  // Users without a Google connection still need the quiet-stage sweep.
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const user of users) {
    await processCompletedEvents(user.id);
    await checkQuietStages(user.id);
  }

  return { accounts: accounts.length, results };
}
