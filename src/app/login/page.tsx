import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, getCurrentUser } from "@/lib/auth";
import { googleConfigured } from "@/lib/env";
import { CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Signs in as an existing seeded user without Google. Gated behind DEV_LOGIN so
 * it can never be reached in a deployment that has not opted in.
 */
async function devLogin(formData: FormData) {
  "use server";

  if (process.env.DEV_LOGIN !== "true" && process.env.DEV_LOGIN !== "1") {
    throw new Error("Dev login is disabled");
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}`);

  await createSession({ userId: user.id });
  redirect("/");
}

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");

  const devEnabled = process.env.DEV_LOGIN === "true" || process.env.DEV_LOGIN === "1";
  const users = devEnabled
    ? await prisma.user.findMany({ orderBy: { createdAt: "asc" }, take: 5 })
    : [];

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm animate-in-soft">
          <div className="mb-8">
            <span className="text-base font-semibold text-slate-900">Job search</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Connect Google so your processes track themselves.
          </p>

          <a
            href="/api/auth/google"
            className={`mt-7 flex w-full items-center justify-center gap-2.5 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
              googleConfigured()
                ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                : "pointer-events-none border-slate-200 bg-slate-50 text-slate-400"
            }`}
          >
            <GoogleMark />
            Continue with Google
          </a>

          {!googleConfigured() && (
            <p className="mt-2 text-xs text-slate-400">
              Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in.
            </p>
          )}

          {devEnabled && users.length > 0 && (
            <div className="mt-8">
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200" />
                <span className="text-xs font-medium text-slate-400">DEV LOGIN</span>
                <div className="h-px flex-1 bg-slate-200" />
              </div>

              <div className="mt-4 space-y-2">
                {users.map((user) => (
                  <form key={user.id} action={devLogin}>
                    <input type="hidden" name="email" value={user.email} />
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-left text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40"
                    >
                      <span className="font-medium text-slate-900">{user.name}</span>
                      <span className="ml-2 text-xs text-slate-500">{user.email}</span>
                    </button>
                  </form>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="hidden flex-col justify-center border-l border-slate-200 bg-white px-12 lg:flex">
        <div className="max-w-md">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            One place for every process you&apos;re in
          </h2>
          <ul className="mt-6 space-y-4">
            {[
              {
                title: "Their process, not a generic one",
                body: "Start from your expectation of how hiring goes, then bend it to what each company actually does — an extra founder chat, a waived take-home.",
              },
              {
                title: "It updates itself",
                body: "Recruiter mail, calendar invites and documents are matched to the right company and move the stage without you touching it.",
              },
              {
                title: "An assistant that has read the thread",
                body: "Ask for a follow-up and it drafts one from what actually happened. It never sends — you review and press send.",
              },
              {
                title: "Take-homes, handled properly",
                body: "Paste the brief and get it broken into checkable requirements and a plan sized to the deadline.",
              },
            ].map((item) => (
              <li key={item.title} className="flex gap-3">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600"
                  strokeWidth={2}
                />
                <div>
                  <div className="text-sm font-medium text-slate-900">{item.title}</div>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
      />
      <path
        fill="#34A853"
        d="M12 23.5c3.11 0 5.72-1.03 7.62-2.8l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.75H1.7v2.98A11.5 11.5 0 0 0 12 23.5Z"
      />
      <path
        fill="#FBBC05"
        d="M5.55 14.16a6.9 6.9 0 0 1 0-4.32V6.86H1.7a11.51 11.51 0 0 0 0 10.28l3.85-2.98Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.71 1.23 15.1.5 12 .5A11.5 11.5 0 0 0 1.7 6.86l3.85 2.98C6.46 7.12 9 4.75 12 4.75Z"
      />
    </svg>
  );
}
