import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

export function getRedis(): IORedis {
  if (globalForRedis.redis) return globalForRedis.redis;
  const client = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    // BullMQ requires this to be null on the connection it uses for blocking ops.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });
  if (process.env.NODE_ENV !== "production") globalForRedis.redis = client;
  return client;
}
