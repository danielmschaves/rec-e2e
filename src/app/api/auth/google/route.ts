import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { authUrl } from "@/lib/google";
import { googleConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Kicks off the Google OAuth consent flow. */
export async function GET() {
  if (!googleConfigured()) {
    return NextResponse.redirect(
      new URL(
        "/login?error=google_not_configured",
        process.env.APP_URL ?? "http://localhost:3000",
      ),
    );
  }

  // CSRF guard: the callback must present this exact state value back.
  const state = randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("google_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authUrl(state));
}
