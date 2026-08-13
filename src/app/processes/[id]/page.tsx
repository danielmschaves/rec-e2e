import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowRight,
  Sparkles,
  Plus,
  FileText,
  CalendarClock,
  ExternalLink,
  Mail,
  Code2,
  Users,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assistantConfigured } from "@/server/ai/client";
import { Shell, PageHeader } from "@/components/Shell";
import { StageTracker } from "@/components/StageTracker";
import { ActivityFeed } from "@/components/ActivityFeed";
import { AssistantPanel, type PanelMessage } from "@/components/AssistantPanel";
import {
  advanceStageAction,
  addStageAction,
  addNoteAction,
  addContactAction,
  setStatusAction,
  setNextActionAction,
  createChallengeAction,
} from "@/app/actions";
import {
  initials,
  tint,
  relativeTime,
  formatDateTime,
  formatDate,
  inputClass,
  humanise,
  OPPORTUNITY_STATUS_STYLE,
  CHALLENGE_STATUS_STYLE,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function ProcessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const opportunity = await prisma.opportunity.findFirst({
    where: { id, userId: user.id },
    include: {
      company: { include: { contacts: true } },
      template: true,
      currentStage: true,
      stages: { orderBy: { position: "asc" } },
      notes: { orderBy: { createdAt: "desc" }, take: 10 },
      activities: { orderBy: { occurredAt: "desc" }, take: 30 },
      emails: { orderBy: { sentAt: "desc" }, take: 8 },
      calendarEvents: { orderBy: { startsAt: "desc" }, take: 8 },
      driveFiles: { orderBy: { createdAt: "desc" }, take: 8 },
      challenges: { include: { requirements: true }, orderBy: { createdAt: "desc" } },
      emailDrafts: { where: { status: "DRAFT" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!opportunity) notFound();

  const [thread, draftCount] = await Promise.all([
    prisma.assistantThread.findFirst({
      where: { userId: user.id, opportunityId: opportunity.id, challengeId: null },
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

  const completed = opportunity.stages.filter((s) => s.status === "COMPLETED").length;
  const relevant = opportunity.stages.filter((s) => s.status !== "SKIPPED").length;
  const progress = relevant > 0 ? Math.round((completed / relevant) * 100) : 0;

  const upcoming = opportunity.calendarEvents
    .filter((e) => e.startsAt.getTime() > Date.now() && e.status !== "CANCELLED")
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const isOpen = ["ACTIVE", "ON_HOLD", "OFFER"].includes(opportunity.status);

  return (
    <Shell user={user} active="/processes" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title={opportunity.company.name}
        subtitle={`${opportunity.roleTitle} · started ${relativeTime(opportunity.appliedAt)}`}
        actions={
          <>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                OPPORTUNITY_STATUS_STYLE[opportunity.status]
              }`}
            >
              {humanise(opportunity.status)}
            </span>
            <Link
              href="/processes"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              All processes
            </Link>
          </>
        }
      />

      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-6">
          {/* Next action */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <form action={setNextActionAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="opportunityId" value={opportunity.id} />
              <label className="min-w-48 flex-1">
                <span className="mb-1 block text-xs font-medium text-slate-600">
                  What&apos;s your next move?
                </span>
                <input
                  name="action"
                  defaultValue={opportunity.nextAction ?? ""}
                  placeholder="e.g. Send availability for the technical round"
                  className={inputClass}
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium text-slate-600">By</span>
                <input
                  name="dueAt"
                  type="date"
                  defaultValue={
                    opportunity.nextActionAt
                      ? opportunity.nextActionAt.toISOString().slice(0, 10)
                      : ""
                  }
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
          </section>

          {/* Their process */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">Their process</h2>
                {opportunity.flowMode === "PERSONALIZED" ? (
                  <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                    Diverged from your flow
                  </span>
                ) : (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                    Standard · {opportunity.template.name}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-indigo-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-500">{progress}%</span>
                </div>

                {isOpen && (
                  <form action={advanceStageAction}>
                    <input type="hidden" name="opportunityId" value={opportunity.id} />
                    <button
                      type="submit"
                      className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
                    >
                      Next stage
                      <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </form>
                )}
              </div>
            </div>

            <div className="p-3">
              <StageTracker
                opportunityId={opportunity.id}
                stages={opportunity.stages}
                currentStageId={opportunity.currentStageId}
                editable={isOpen}
              />
            </div>

            {isOpen && (
              <div className="border-t border-slate-200 bg-slate-50/60 px-5 py-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5 text-slate-500" strokeWidth={2.5} />
                  <span className="text-xs font-medium text-slate-600">
                    They added a step that isn&apos;t in your flow
                  </span>
                </div>
                <form action={addStageAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="opportunityId" value={opportunity.id} />
                  <input
                    name="name"
                    required
                    placeholder="e.g. Pairing session"
                    className="min-w-40 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                  />
                  <select
                    name="type"
                    defaultValue="TECHNICAL_INTERVIEW"
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="RECRUITER_SCREEN">Screen</option>
                    <option value="TAKE_HOME">Take-home</option>
                    <option value="TECHNICAL_INTERVIEW">Technical</option>
                    <option value="SYSTEM_DESIGN">System design</option>
                    <option value="BEHAVIOURAL_INTERVIEW">Behavioural</option>
                    <option value="ONSITE">Onsite</option>
                    <option value="CUSTOM">Other</option>
                  </select>
                  <select
                    name="afterStageId"
                    defaultValue=""
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">Before the end</option>
                    {opportunity.stages.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        After {stage.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    Add step
                  </button>
                </form>
                <p className="mt-2 text-xs text-slate-400">
                  Only this company&apos;s process changes — your {opportunity.template.name}{" "}
                  flow stays as it is.
                </p>
              </div>
            )}
          </section>

          {/* Challenges */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
              <Code2 className="h-4 w-4 text-slate-400" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">Technical challenges</h2>
            </div>

            {opportunity.challenges.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {opportunity.challenges.map((c) => {
                  const done = c.requirements.filter((r) => r.done).length;
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/challenges/${c.id}`}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">
                            {c.title}
                          </div>
                          <div className="text-xs text-slate-500">
                            {done}/{c.requirements.length} requirements
                            {c.deadline && ` · due ${formatDate(c.deadline)}`}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                            CHALLENGE_STATUS_STYLE[c.status]
                          }`}
                        >
                          {humanise(c.status)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <form action={createChallengeAction} className="space-y-2 p-5">
              <input type="hidden" name="opportunityId" value={opportunity.id} />
              <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
                <input
                  name="title"
                  required
                  placeholder="Challenge title"
                  className={inputClass}
                />
                <input name="deadline" type="date" className={inputClass} />
              </div>
              <textarea
                name="brief"
                rows={3}
                placeholder="Paste the brief exactly as they sent it — the assistant works from this."
                className={inputClass}
              />
              <button
                type="submit"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Add challenge
              </button>
            </form>
          </section>

          {/* Timeline */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">Timeline</h2>
              <span className="text-xs text-slate-400">Everything that happened, in order</span>
            </div>
            <div className="p-5">
              <ActivityFeed
                activities={opportunity.activities}
                emptyMessage="Nothing yet."
              />
            </div>
          </section>

          {/* Notes */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">Notes</h2>
            </div>
            <div className="space-y-4 p-5">
              <form action={addNoteAction} className="space-y-2">
                <input type="hidden" name="opportunityId" value={opportunity.id} />
                <textarea
                  name="body"
                  rows={2}
                  required
                  placeholder="Who you met, what they asked, what you thought…"
                  className={inputClass}
                />
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
                >
                  Add note
                </button>
              </form>

              {opportunity.notes.length > 0 && (
                <ul className="space-y-3 border-t border-slate-100 pt-4">
                  {opportunity.notes.map((note) => (
                    <li key={note.id}>
                      <p className="text-sm whitespace-pre-wrap text-slate-600">{note.body}</p>
                      <span className="text-xs text-slate-400">
                        {relativeTime(note.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* Sidebar: assistant first — it's the point of the page */}
        <div className="space-y-6">
          <div className="xl:sticky xl:top-6">
            <AssistantPanel
              messages={panelMessages}
              opportunityId={opportunity.id}
              configured={assistantConfigured()}
              suggestions={[
                "Draft a follow-up",
                "Where does this stand?",
                "What should I ask them?",
                "They rejected me — draft a reply",
              ]}
            />
          </div>

          {opportunity.emailDrafts.length > 0 && (
            <section className="rounded-xl border border-violet-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
                <Mail className="h-4 w-4 text-violet-600" strokeWidth={2} />
                <h2 className="text-sm font-semibold text-slate-900">Drafts to review</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {opportunity.emailDrafts.map((draft) => (
                  <li key={draft.id}>
                    <Link
                      href="/drafts"
                      className="block px-5 py-3 transition-colors hover:bg-slate-50"
                    >
                      <div className="truncate text-sm font-medium text-slate-900">
                        {draft.subject}
                      </div>
                      <div className="text-xs text-slate-500">to {draft.toEmail}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-3">
              <div
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg text-sm font-semibold ${tint(
                  opportunity.company.name,
                )}`}
              >
                {initials(opportunity.company.name)}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">
                  {opportunity.company.name}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {opportunity.company.domains.join(", ") || "no domain set"}
                </div>
              </div>
            </div>

            <dl className="mt-4 space-y-1.5 text-sm">
              {opportunity.location && (
                <Row label="Location" value={opportunity.location} />
              )}
              {opportunity.workMode && (
                <Row label="Mode" value={humanise(opportunity.workMode)} />
              )}
              {(opportunity.salaryMin || opportunity.salaryMax) && (
                <Row
                  label="Range"
                  value={`${opportunity.salaryMin ?? "?"}–${opportunity.salaryMax ?? "?"} ${
                    opportunity.currency ?? ""
                  }`}
                />
              )}
              {opportunity.source && <Row label="Source" value={opportunity.source} />}
              <Row label="Priority" value={humanise(opportunity.priority)} />
            </dl>

            {opportunity.jobPostUrl && (
              <a
                href={opportunity.jobPostUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 flex items-center gap-1.5 text-sm text-indigo-600 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
                The posting
              </a>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
              <Users className="h-4 w-4 text-slate-400" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">People</h2>
            </div>
            {opportunity.company.contacts.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {opportunity.company.contacts.map((c) => (
                  <li key={c.id} className="px-5 py-3">
                    <div className="text-sm font-medium text-slate-900">{c.name}</div>
                    <div className="truncate text-xs text-slate-500">
                      {c.email} · {humanise(c.role)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form action={addContactAction} className="space-y-2 p-5">
              <input type="hidden" name="opportunityId" value={opportunity.id} />
              <input name="name" required placeholder="Name" className={inputClass} />
              <input
                name="email"
                type="email"
                required
                placeholder="Email"
                className={inputClass}
              />
              <select name="role" defaultValue="RECRUITER" className={inputClass}>
                <option value="RECRUITER">Recruiter</option>
                <option value="HIRING_MANAGER">Hiring manager</option>
                <option value="INTERVIEWER">Interviewer</option>
                <option value="REFERRAL">Referral</option>
                <option value="OTHER">Other</option>
              </select>
              <button
                type="submit"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Add person
              </button>
            </form>
          </section>

          {isOpen && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-900">How did it end?</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {(["OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED", "ON_HOLD"] as const).map(
                  (status) => (
                    <form key={status} action={setStatusAction}>
                      <input type="hidden" name="opportunityId" value={opportunity.id} />
                      <input type="hidden" name="status" value={status} />
                      <button
                        type="submit"
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          status === "ACCEPTED" || status === "OFFER"
                            ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            : status === "REJECTED"
                              ? "border-rose-200 text-rose-700 hover:bg-rose-50"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {humanise(status)}
                      </button>
                    </form>
                  ),
                )}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <SidebarList
              title="Scheduled"
              icon={CalendarClock}
              items={upcoming.map((event) => ({
                id: event.id,
                primary: event.title,
                secondary: formatDateTime(event.startsAt),
                href: event.meetLink ?? undefined,
              }))}
            />
          )}

          {opportunity.driveFiles.length > 0 && (
            <SidebarList
              title="Documents"
              icon={FileText}
              items={opportunity.driveFiles.map((file) => ({
                id: file.id,
                primary: file.name,
                secondary: humanise(file.kind),
                href: file.webViewLink ?? undefined,
              }))}
            />
          )}

          {opportunity.emails.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">Correspondence</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {opportunity.emails.map((email) => (
                  <li key={email.id} className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          email.direction === "INBOUND"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {email.direction === "INBOUND" ? "From them" : "From you"}
                      </span>
                      <span className="text-xs text-slate-400">
                        {relativeTime(email.sentAt)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-slate-900">
                      {email.subject ?? "(no subject)"}
                    </div>
                    {email.snippet && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                        {email.snippet}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate text-sm text-slate-700">{value}</dd>
    </div>
  );
}

function SidebarList({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: typeof Mail;
  items: Array<{ id: string; primary: string; secondary: string; href?: string }>;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
        <Icon className="h-4 w-4 text-slate-400" strokeWidth={2} />
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </div>
      <ul className="divide-y divide-slate-100">
        {items.map((item) => (
          <li key={item.id}>
            {item.href ? (
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 px-5 py-3 transition-colors hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-900">{item.primary}</span>
                  <span className="block text-xs text-slate-500">{item.secondary}</span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
              </a>
            ) : (
              <div className="px-5 py-3">
                <span className="block truncate text-sm text-slate-900">{item.primary}</span>
                <span className="block text-xs text-slate-500">{item.secondary}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
