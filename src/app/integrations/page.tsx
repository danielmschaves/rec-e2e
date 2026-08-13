import { redirect } from "next/navigation";
import {
  Mail,
  Calendar,
  HardDrive,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Sparkles,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { googleConfigured } from "@/lib/env";
import { assistantConfigured, ASSISTANT_MODEL } from "@/server/ai/client";
import { Shell, PageHeader } from "@/components/Shell";
import {
  syncNowAction,
  toggleSyncAction,
  updateProfileAction,
} from "@/app/actions";
import { relativeTime, inputClass } from "@/lib/ui";

export const dynamic = "force-dynamic";

const SURFACES = [
  {
    icon: Mail,
    name: "Gmail",
    what: "Reads mail from companies you're in a process with and files it on their timeline.",
    effect: "A reply while you're waiting closes that stage.",
  },
  {
    icon: Calendar,
    name: "Calendar",
    what: "Watches invites whose attendees match a company you're tracking.",
    effect: "An invite moves the stage; the interview ending advances it.",
  },
  {
    icon: HardDrive,
    name: "Drive",
    what: "Picks up documents named after a company you're talking to.",
    effect: "Briefs and solutions land on the right process.",
  },
];

export default async function IntegrationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [account, recentRuns, draftCount] = await Promise.all([
    prisma.googleAccount.findUnique({ where: { userId: user.id } }),
    prisma.syncRun.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: "desc" },
      take: 12,
    }),
    prisma.emailDraft.count({ where: { userId: user.id, status: "DRAFT" } }),
  ]);

  const connected = Boolean(account);

  return (
    <Shell user={user} active="/integrations" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title="Setup"
        subtitle="Connect Google so the tracker updates itself, and tell the assistant who you are."
        actions={
          connected ? (
            <form action={syncNowAction}>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.5} />
                Sync now
              </button>
            </form>
          ) : null
        }
      />

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {connected ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" strokeWidth={2} />
                  ) : (
                    <XCircle className="h-4 w-4 text-slate-400" strokeWidth={2} />
                  )}
                  <h2 className="text-sm font-semibold text-slate-900">Google Workspace</h2>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  {connected
                    ? `Connected as ${account!.email}`
                    : "Not connected — sign in with Google to enable sync."}
                </p>
                {connected && (
                  <p className="mt-1 text-xs text-slate-400">
                    Last synced {relativeTime(account!.lastSyncedAt)}
                  </p>
                )}
                {account?.lastError && (
                  <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {account.lastError}
                  </p>
                )}
              </div>

              {connected ? (
                <form action={toggleSyncAction}>
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    {account!.syncEnabled ? "Pause sync" : "Resume sync"}
                  </button>
                </form>
              ) : (
                <a
                  href="/api/auth/google"
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    googleConfigured()
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : "pointer-events-none bg-slate-100 text-slate-400"
                  }`}
                >
                  Connect Google
                </a>
              )}
            </div>

            {!googleConfigured() && (
              <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                Set <code className="font-mono">GOOGLE_CLIENT_ID</code> and{" "}
                <code className="font-mono">GOOGLE_CLIENT_SECRET</code>, then restart.
                Everything else in the app works without them.
              </p>
            )}
          </section>

          <section className="grid gap-4 sm:grid-cols-3">
            {SURFACES.map((surface) => {
              const Icon = surface.icon;
              return (
                <div
                  key={surface.name}
                  className="rounded-xl border border-slate-200 bg-white p-4"
                >
                  <Icon className="h-5 w-5 text-indigo-600" strokeWidth={2} />
                  <h3 className="mt-2.5 text-sm font-semibold text-slate-900">
                    {surface.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{surface.what}</p>
                  <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                    {surface.effect}
                  </p>
                </div>
              );
            })}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">Assistant</h2>
              {assistantConfigured() ? (
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                  ready · {ASSISTANT_MODEL}
                </span>
              ) : (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                  needs ANTHROPIC_API_KEY
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              What you tell it here shapes every draft it writes for you.
            </p>

            <form action={updateProfileAction} className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Headline</span>
                <input
                  name="headline"
                  defaultValue={user.headline ?? ""}
                  placeholder="Senior backend engineer · Go, Python"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">
                  Your situation
                </span>
                <textarea
                  name="profile"
                  rows={6}
                  defaultValue={user.profile ?? ""}
                  placeholder="Seniority, stack, what you're looking for, salary expectations, what you'd turn down."
                  className={inputClass}
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save
              </button>
            </form>
          </section>
        </div>

        <section className="h-fit rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">Sync history</h2>
          </div>
          {recentRuns.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">No syncs have run yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">
                        {run.provider.toLowerCase()}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          run.status === "SUCCESS"
                            ? "bg-emerald-50 text-emerald-700"
                            : run.status === "FAILED"
                              ? "bg-rose-50 text-rose-700"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {run.status.toLowerCase()}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {run.itemsSeen} seen · {run.itemsLinked} linked · {run.rulesFired} rules
                    </div>
                    {run.error && (
                      <div className="mt-0.5 truncate text-xs text-rose-600">{run.error}</div>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">
                    {relativeTime(run.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
