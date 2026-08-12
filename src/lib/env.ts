import { z } from "zod";

/**
 * Runtime configuration. Parsed lazily so that `next build` (which imports
 * modules without a real environment) does not explode.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  APP_URL: z.string().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16).default("dev-only-session-secret-change-me"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  /// Lets you sign in as the seeded demo user without Google credentials.
  DEV_LOGIN: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  /// Minutes between background sync passes.
  SYNC_INTERVAL_MINUTES: z.coerce.number().default(5),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when Google OAuth is fully configured. */
export function googleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}
