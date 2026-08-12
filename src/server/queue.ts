import { Queue } from "bullmq";
import { getRedis } from "@/lib/redis";

export const SYNC_QUEUE = "recruitment-sync";

export type SyncJobData =
  | { kind: "sync-account"; userId: string }
  | { kind: "sync-all" };

let queue: Queue<SyncJobData> | null = null;

export function syncQueue(): Queue<SyncJobData> {
  if (!queue) {
    queue = new Queue<SyncJobData>(SYNC_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

/** Queues an immediate sync for one user (the "Sync now" button). */
export async function enqueueAccountSync(userId: string) {
  return syncQueue().add(
    "sync-account",
    { kind: "sync-account", userId },
    // Collapses repeated clicks into a single in-flight job.
    { jobId: `sync-account:${userId}:${Math.floor(Date.now() / 10_000)}` },
  );
}
