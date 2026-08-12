import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import type { GoogleAccount } from "@prisma/client";

/**
 * Scopes requested at sign-in.
 *
 * Read scopes cover the sync engine; `gmail.send` lets recruiters send stage
 * emails from the app. `drive.file` (rather than full drive) keeps us to files
 * this app created or that the user explicitly opened with it — enough to
 * organise a candidate folder without asking for the user's whole Drive.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

export function oauthClient(): OAuth2Client {
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ??
    `${process.env.APP_URL ?? "http://localhost:3000"}/api/auth/google/callback`;

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

/**
 * Returns an OAuth client bound to a stored account, refreshing the access
 * token when it is expired or about to be. Refreshed tokens are persisted.
 */
export async function clientForAccount(
  account: GoogleAccount,
): Promise<OAuth2Client> {
  const client = oauthClient();
  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiresAt?.getTime(),
  });

  const expiringSoon =
    !account.expiresAt || account.expiresAt.getTime() - Date.now() < 60_000;

  if (expiringSoon && account.refreshToken) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    await prisma.googleAccount.update({
      where: { id: account.id },
      data: {
        accessToken: credentials.access_token ?? account.accessToken,
        refreshToken: credentials.refresh_token ?? account.refreshToken,
        expiresAt: credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : null,
      },
    });
  }

  return client;
}

export function gmailFor(client: OAuth2Client) {
  return google.gmail({ version: "v1", auth: client });
}

export function calendarFor(client: OAuth2Client) {
  return google.calendar({ version: "v3", auth: client });
}

export function driveFor(client: OAuth2Client) {
  return google.drive({ version: "v3", auth: client });
}

/** Pulls "Name <a@b.com>" apart. Gmail headers come in this shape. */
export function parseAddress(raw: string | undefined | null): {
  email: string;
  name: string | null;
} {
  if (!raw) return { email: "", name: null };
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, "").trim();
    return { email: match[2].toLowerCase().trim(), name: name || null };
  }
  return { email: raw.toLowerCase().trim(), name: null };
}

/** Splits a comma-separated address header into normalised emails. */
export function parseAddressList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseAddress(part).email)
    .filter(Boolean);
}
