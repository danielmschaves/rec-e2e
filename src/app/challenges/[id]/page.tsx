import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarClock, CheckSquare, ListChecks, Map, FileCode2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assistantConfigured } from "@/server/ai/client";
import { Shell, PageHeader } from "@/components/Shell";
import { AssistantPanel, type PanelMessage } from "@/components/AssistantPanel";
import {
  updateChallengeAction,
  toggleRequirementAction,
  addRequirementAction,
} from "@/app/actions";
import {
  relativeTime,
  formatDate,
  inputClass,
  humanise,
  CHALLENGE_STATUS_STYLE,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function ChallengePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const challenge = await prisma.challenge.findFirst({
    where: { id, userId: user.id },
    include: {
      opportunity: { include: { company: true } },
      requirements: { orderBy: { position: "asc" } },
    },
  });
  if (!challenge) notFound();

  const [thread, draftCount] = await Promise.all([
    prisma.assistantThread.findFirst({
      where: { userId: user.id, challengeId: challenge.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.emailDraft.count({ where: { userId: user.id, status: "DRAFT" } }),
  ]);

  const panelMessages: PanelMessage[] = (thread?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolSummary: m.toolSummary,
    isError: m.isError,
  }));

  const mustHaves = challenge.requirements.filter((r) => r.mustHave);
  const doneMust = mustHaves.filter((r) => r.done).length;
  const progress = mustHaves.length > 0 ? Math.round((doneMust / mustHaves.length) * 100) : 0;

  const daysLeft = challenge.deadline
    ? Math.ceil((challenge.deadline.getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <Shell user={user} active="/challenges" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title={challenge.title}
        subtitle={`${challenge.opportunity.company.name} · ${challenge.opportunity.roleTitle}`}
        actions={
          <>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                CHALLENGE_STATUS_STYLE[challenge.status]
              }`}
            >
              {humanise(challenge.status)}
            </span>
            <Link
              href={`/processes/${challenge.opportunityId}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              The process
            </Link>
          </>
        }
      />

      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-6">
          {/* Status bar */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <form
              action={updateChallengeAction}
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="challengeId" value={challenge.id} />
              <label>
                <span className="mb-1 block text-xs font-medium text-slate-600">Status</span>
                <select name="status" defaultValue={challenge.status} className={inputClass}>
                  <option value="NOT_STARTED">Not started</option>
                  <option value="PLANNING">Planning</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="READY_FOR_REVIEW">Ready for review</option>
                  <option value="SUBMITTED">Submitted</option>
                  <option value="PASSED">Passed</option>
                  <option value="FAILED">Didn&apos;t pass</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium text-slate-600">Deadline</span>
                <input
                  name="deadline"
                  type="date"
                  defaultValue={
                    challenge.deadline ? challenge.deadline.toISOString().slice(0, 10) : ""
                  }
                  className={inputClass}
                />
              </label>
              <label className="min-w-48 flex-1">
                <span className="mb-1 block text-xs font-medium text-slate-600">
                  Repository
                </span>
                <input
                  name="repoUrl"
                  defaultValue={challenge.repoUrl ?? ""}
                  placeholder="https://github.com/…"
                  className={inputClass}
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save
              </button>
            </form>

            <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500">
                  {doneMust}/{mustHaves.length} must-haves
                </span>
              </div>
              {daysLeft !== null && (
                <span
                  className={`flex items-center gap-1.5 text-xs ${
                    daysLeft <= 1 ? "text-rose-600" : "text-slate-500"
                  }`}
                >
                  <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} />
                  {daysLeft < 0
                    ? `${Math.abs(daysLeft)} days overdue`
                    : daysLeft === 0
                      ? "Due today"
                      : `${daysLeft} days left`}
                  {challenge.deadline && ` · ${formatDate(challenge.deadline)}`}
                </span>
              )}
              {challenge.estimatedHours && (
                <span className="text-xs text-slate-500">
                  ~{challenge.estimatedHours}h estimated
                </span>
              )}
            </div>
          </section>

          {/* Requirements */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
              <ListChecks className="h-4 w-4 text-slate-400" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">Requirements</h2>
              <span className="ml-auto text-xs text-slate-400">
                Ask the assistant to pull these out of the brief
              </span>
            </div>

            {challenge.requirements.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">
                Nothing extracted yet. Paste the brief below, then ask the assistant to break
                it into requirements.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {challenge.requirements.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 px-5 py-2.5">
                    <form action={toggleRequirementAction} className="pt-0.5">
                      <input type="hidden" name="requirementId" value={r.id} />
                      <button
                        type="submit"
                        aria-label={r.done ? "Mark not done" : "Mark done"}
                        className={`grid h-4 w-4 place-items-center rounded border transition-colors ${
                          r.done
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-slate-300 hover:border-indigo-400"
                        }`}
                      >
                        {r.done && <CheckSquare className="h-3 w-3" strokeWidth={3} />}
                      </button>
                    </form>
                    <span
                      className={`flex-1 text-sm ${
                        r.done ? "text-slate-400 line-through" : "text-slate-800"
                      }`}
                    >
                      {r.text}
                    </span>
                    {!r.mustHave && (
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        optional
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <form action={addRequirementAction} className="flex gap-2 border-t border-slate-100 p-4">
              <input type="hidden" name="challengeId" value={challenge.id} />
              <input
                name="text"
                required
                placeholder="Add a requirement you spotted"
                className={`${inputClass} flex-1`}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Add
              </button>
            </form>
          </section>

          {/* Plan */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
              <Map className="h-4 w-4 text-slate-400" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">Plan</h2>
            </div>
            <form action={updateChallengeAction} className="space-y-2 p-5">
              <input type="hidden" name="challengeId" value={challenge.id} />
              <textarea
                name="plan"
                rows={challenge.plan ? 12 : 4}
                defaultValue={challenge.plan ?? ""}
                placeholder="Ask the assistant for a plan, or write your own. It'll appear here."
                className={`${inputClass} font-mono text-xs leading-relaxed`}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save plan
              </button>
            </form>
          </section>

          {/* Brief */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
              <FileCode2 className="h-4 w-4 text-slate-400" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">The brief</h2>
              {challenge.briefSource && (
                <span className="ml-auto text-xs text-slate-400">{challenge.briefSource}</span>
              )}
            </div>
            <form action={updateChallengeAction} className="space-y-2 p-5">
              <input type="hidden" name="challengeId" value={challenge.id} />
              <textarea
                name="brief"
                rows={challenge.brief ? 14 : 5}
                defaultValue={challenge.brief ?? ""}
                placeholder="Paste the brief exactly as they sent it."
                className={`${inputClass} font-mono text-xs leading-relaxed`}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save brief
              </button>
            </form>
          </section>

          {/* Working notes */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">Working notes</h2>
            </div>
            <form action={updateChallengeAction} className="space-y-2 p-5">
              <input type="hidden" name="challengeId" value={challenge.id} />
              <textarea
                name="notes"
                rows={5}
                defaultValue={challenge.notes ?? ""}
                placeholder="Decisions, blockers, things to mention in the README."
                className={inputClass}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Save notes
              </button>
            </form>
          </section>
        </div>

        <div className="xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)]">
          <AssistantPanel
            heading="Challenge assistant"
            messages={panelMessages}
            challengeId={challenge.id}
            configured={assistantConfigured()}
            suggestions={[
              "Break the brief into requirements",
              "Give me a plan for the time I have",
              "What would you cut if I'm short on time?",
              "Review this code",
            ]}
          />
        </div>
      </div>
    </Shell>
  );
}
