import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { oauthClient } from "@/lib/google";
import { createSession } from "@/lib/auth";
import { enqueueAccountSync } from "@/server/queue";

export const dynamic = "force-dynamic";

function appUrl(path: string) {
  return new URL(path, process.env.APP_URL ?? "http://localhost:3000");
}

/**
 * OAuth callback. Creates (or finds) the user, stores tokens, and kicks off a
 * first sync so the app has data immediately after connecting.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (error) return NextResponse.redirect(appUrl(`/login?error=${error}`));
  if (!code) return NextResponse.redirect(appUrl("/login?error=missing_code"));

  const store = await cookies();
  const expectedState = store.get("google_oauth_state")?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(appUrl("/login?error=state_mismatch"));
  }
  store.delete("google_oauth_state");

  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email?.toLowerCase();
    if (!email) return NextResponse.redirect(appUrl("/login?error=no_email"));

    // Single-user app: signing in with Google either finds your account or
    // creates it.
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: profile.data.name ?? email,
        avatarUrl: profile.data.picture ?? null,
      },
      update: { avatarUrl: profile.data.picture ?? undefined },
    });

    const scopes = tokens.scope?.split(" ") ?? [];

    await prisma.googleAccount.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        email,
        accessToken: tokens.access_token ?? "",
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes,
      },
      update: {
        email,
        accessToken: tokens.access_token ?? "",
        // Google only returns a refresh token on first consent — never
        // overwrite a stored one with null.
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes,
        lastError: null,
      },
    });

    await createSession({ userId: user.id });

    // Best-effort: if Redis is down, sign-in should still succeed.
    try {
      await enqueueAccountSync(user.id);
    } catch (err) {
      console.error("[oauth] could not queue initial sync:", err);
    }

    return NextResponse.redirect(appUrl("/?connected=1"));
  } catch (err) {
    console.error("[oauth] callback failed:", err);
    return NextResponse.redirect(appUrl("/login?error=oauth_failed"));
  }
}
