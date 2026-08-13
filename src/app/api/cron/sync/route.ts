import { NextResponse, type NextRequest } from "next/server";
import { syncAllAccounts } from "@/server/sync";

export const dynamic = "force-dynamic";
// Serverless functions are short-lived; keep the sync bounded well inside it.
export const maxDuration = 60;

/**
 * Sync entry point for serverless deployments.
 *
 * Docker runs a persistent BullMQ worker, but Vercel has no long-running
 * process — there, this route is what keeps applications up to date, driven by
 * the cron entry in vercel.json.
 *
 * Protected by CRON_SECRET: Vercel Cron sends it as a bearer token. When the
 * variable is unset the route refuses to run rather than defaulting to open,
 * since it is an unauthenticated path that syncs every user's account.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — refusing to run" },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { accounts, results } = await syncAllAccounts();
    return NextResponse.json({
      ok: true,
      accounts,
      linked: results.reduce((sum, r) => sum + r.linked, 0),
      rulesFired: results.reduce((sum, r) => sum + r.rulesFired, 0),
      errors: results.filter((r) => r.error).map((r) => `${r.provider}: ${r.error}`),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[cron] sync failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}
