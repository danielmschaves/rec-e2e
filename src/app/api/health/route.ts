import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

/** Liveness probe for Docker/Vercel: reports each dependency separately. */
export async function GET() {
  const checks: Record<string, "ok" | string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    checks.database = err instanceof Error ? err.message : "unreachable";
  }

  try {
    await getRedis().ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = err instanceof Error ? err.message : "unreachable";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, at: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
