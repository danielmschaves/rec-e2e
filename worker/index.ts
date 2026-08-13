/**
 * Background worker.
 *
 * Runs as its own container so that a long Gmail backfill never blocks a web
 * request. Two responsibilities:
 *   1. Process on-demand sync jobs queued by the app.
 *   2. Keep a repeatable job running so syncing happens without user action —
 *      this is what makes application status update "by itself".
 */
import "./env";
import { Worker, Queue, type Job } from "bullmq";
import IORedis from "ioredis";
import { syncAccount, syncAllAccounts } from "../src/server/sync/index";
import { prisma } from "../src/lib/prisma";

const SYNC_QUEUE = "recruitment-sync";

type SyncJobData =
  | { kind: "sync-account"; userId: string }
  | { kind: "sync-all" };

const connection = new IORedis(process.env.REDIS_URL ?? "redis://redis:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 5);

async function main() {
  const queue = new Queue<SyncJobData>(SYNC_QUEUE, { connection });

  // Repeatable scheduler job. Re-adding with the same key is idempotent.
  await queue.add(
    "sync-all",
    { kind: "sync-all" },
    {
      repeat: { pattern: `*/${Math.max(1, intervalMinutes)} * * * *` },
      jobId: "scheduled-sync-all",
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  );

  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE,
    async (job: Job<SyncJobData>) => {
      const started = Date.now();

      if (job.data.kind === "sync-account") {
        const results = await syncAccount(job.data.userId);
        const linked = results.reduce((sum, r) => sum + r.linked, 0);
        const fired = results.reduce((sum, r) => sum + r.rulesFired, 0);
        console.log(
          `[worker] sync-account ${job.data.userId}: linked=${linked} rules=${fired} in ${Date.now() - started}ms`,
        );
        return { linked, fired };
      }

      const { accounts, results } = await syncAllAccounts();
      const linked = results.reduce((sum, r) => sum + r.linked, 0);
      const fired = results.reduce((sum, r) => sum + r.rulesFired, 0);
      console.log(
        `[worker] sync-all: accounts=${accounts} linked=${linked} rules=${fired} in ${Date.now() - started}ms`,
      );
      return { accounts, linked, fired };
    },
    { connection, concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} (${job.name}) completed`);
  });

  console.log(
    `[worker] ready — queue "${SYNC_QUEUE}", scheduled sync every ${intervalMinutes}m`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining…`);
    await worker.close();
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
