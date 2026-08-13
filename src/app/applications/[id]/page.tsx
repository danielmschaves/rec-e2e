import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  Mail,
  Phone,
  Linkedin,
  MapPin,
  ArrowRight,
  Sparkles,
  Plus,
  FileText,
  CalendarClock,
  ExternalLink,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { StageTracker } from "@/components/StageTracker";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  advanceStageAction,
  addStageAction,
  addNoteAction,
  addScorecardAction,
  setStatusAction,
  sendEmailAction,
  scheduleInterviewAction,
} from "@/app/actions";
import {
  initials,
  avatarTint,
  relativeTime,
  formatDateTime,
  APPLICATION_STATUS_STYLE,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [googleAccount, templates] = await Promise.all([
    prisma.googleAccount.findUnique({ where: { userId: user.id } }),
    prisma.emailTemplate.findMany({
      where: { orgId: user.orgId },
      orderBy: { name: "asc" },
    }),
  ]);

  const application = await prisma.application.findFirst({
    where: { id, orgId: user.orgId },
    include: {
      candidate: true,
      job: { include: { pipeline: true } },
      currentStage: true,
      stages: { orderBy: { position: "asc" } },
      notes: { include: { author: true }, orderBy: { createdAt: "desc" } },
      scorecards: { include: { author: true }, orderBy: { createdAt: "desc" } },
      activities: { orderBy: { occurredAt: "desc" }, take: 30 },
      emails: { orderBy: { sentAt: "desc" }, take: 10 },
      calendarEvents: { orderBy: { startsAt: "desc" }, take: 10 },
      driveFiles: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!application) notFound();

  const { candidate, job } = application;
  const completed = application.stages.filter((s) => s.status === "COMPLETED").length;
  const relevant = application.stages.filter((s) => s.status !== "SKIPPED").length;
  const progress = relevant > 0 ? Math.round((completed / relevant) * 100) : 0;

  const upcoming = application.calendarEvents
    .filter((e) => e.startsAt.getTime() > Date.now() && e.status !== "CANCELLED")
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return (
    <Shell user={user} active="/jobs">
      <PageHeader
        title={candidate.fullName}
        subtitle={`${job.title} · applied ${relativeTime(application.appliedAt)}`}
        actions={
          <>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                APPLICATION_STATUS_STYLE[application.status]
              }`}
            >
              {application.status.replace("_", " ").toLowerCase()}
            </span>
            <Link
              href={`/jobs/${job.id}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              Back to board
            </Link>
          </>
        }
      />

      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          {/* Flow */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  Hiring flow
                </h2>
                {application.flowMode === "PERSONALIZED" ? (
                  <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                    Personalised
                  </span>
                ) : (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                    Standard · {job.pipeline.name}
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

                {application.status === "ACTIVE" && (
                  <form action={advanceStageAction}>
                    <input type="hidden" name="applicationId" value={application.id} />
                    <button
                      type="submit"
                      className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
                    >
                      Advance
                      <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </form>
                )}
              </div>
            </div>

            <div className="p-3">
              <StageTracker
                applicationId={application.id}
                stages={application.stages}
                currentStageId={application.currentStageId}
                editable={application.status === "ACTIVE"}
              />
            </div>

            {application.status === "ACTIVE" && (
              <div className="border-t border-slate-200 bg-slate-50/60 px-5 py-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5 text-slate-500" strokeWidth={2.5} />
                  <span className="text-xs font-medium text-slate-600">
                    Add a step just for {candidate.fullName.split(" ")[0]}
                  </span>
                </div>
                <form
                  action={addStageAction}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="applicationId" value={application.id} />
                  <input
                    name="name"
                    required
                    placeholder="e.g. Founder chat"
                    className="min-w-40 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                  />
                  <select
                    name="type"
                    defaultValue="INTERVIEW"
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="SCREENING">Screening</option>
                    <option value="ASSESSMENT">Assessment</option>
                    <option value="INTERVIEW">Interview</option>
                    <option value="REFERENCE_CHECK">Reference check</option>
                    <option value="CUSTOM">Other</option>
                  </select>
                  <select
                    name="afterStageId"
                    defaultValue=""
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">Before the end</option>
                    {application.stages.map((stage) => (
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
                  Only this candidate is affected — the {job.pipeline.name}{" "}
                  template stays as it is.
                </p>
              </div>
            )}
          </section>

          {/* Timeline */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">Timeline</h2>
              <span className="text-xs text-slate-400">
                Email, interviews and documents sync automatically
              </span>
            </div>
            <div className="p-5">
              <ActivityFeed
                activities={application.activities}
                emptyMessage="No activity yet."
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
                <input type="hidden" name="applicationId" value={application.id} />
                <textarea
                  name="body"
                  rows={2}
                  required
                  placeholder="What did you learn?"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
                >
                  Add note
                </button>
              </form>

              {application.notes.length > 0 && (
                <ul className="space-y-3 border-t border-slate-100 pt-4">
                  {application.notes.map((note) => (
                    <li key={note.id} className="flex gap-3">
                      <div
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${avatarTint(
                          note.author?.email ?? "system",
                        )}`}
                      >
                        {initials(note.author?.name ?? "??")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium text-slate-900">
                            {note.author?.name ?? "Unknown"}
                          </span>
                          <span className="text-xs text-slate-400">
                            {relativeTime(note.createdAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm whitespace-pre-wrap text-slate-600">
                          {note.body}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-3">
              <div
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-sm font-semibold ${avatarTint(
                  candidate.email,
                )}`}
              >
                {initials(candidate.fullName)}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">
                  {candidate.fullName}
                </div>
                {candidate.headline && (
                  <div className="truncate text-xs text-slate-500">
                    {candidate.headline}
                  </div>
                )}
              </div>
            </div>

            <dl className="mt-4 space-y-2 text-sm">
              <ContactRow icon={Mail} value={candidate.email} href={`mailto:${candidate.email}`} />
              {candidate.phone && <ContactRow icon={Phone} value={candidate.phone} />}
              {candidate.location && <ContactRow icon={MapPin} value={candidate.location} />}
              {candidate.linkedinUrl && (
                <ContactRow
                  icon={Linkedin}
                  value="LinkedIn profile"
                  href={candidate.linkedinUrl}
                />
              )}
            </dl>

            {candidate.source && (
              <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Source: {candidate.source}
              </div>
            )}
          </section>

          {application.status === "ACTIVE" && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-900">Decision</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {(["HIRED", "REJECTED", "ON_HOLD", "WITHDRAWN"] as const).map(
                  (status) => (
                    <form key={status} action={setStatusAction}>
                      <input type="hidden" name="applicationId" value={application.id} />
                      <input type="hidden" name="status" value={status} />
                      <button
                        type="submit"
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          status === "HIRED"
                            ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            : status === "REJECTED"
                              ? "border-rose-200 text-rose-700 hover:bg-rose-50"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {status.replace("_", " ").toLowerCase()}
                      </button>
                    </form>
                  ),
                )}
              </div>
            </section>
          )}

          {application.status === "ACTIVE" && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-900">
                Reach out
              </h2>

              {googleAccount ? (
                <div className="mt-3 space-y-5">
                  <form action={sendEmailAction} className="space-y-2">
                    <input type="hidden" name="applicationId" value={application.id} />
                    <select name="templateId" defaultValue="" className={fieldClass}>
                      <option value="">Choose a template…</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                    <input
                      name="subject"
                      placeholder="Subject (overrides the template)"
                      className={fieldClass}
                    />
                    <textarea
                      name="body"
                      rows={3}
                      placeholder="Message (overrides the template)"
                      className={fieldClass}
                    />
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      Email {candidate.fullName.split(" ")[0]}
                    </button>
                    <p className="text-xs text-slate-400">
                      Sent from {googleAccount.email}. Placeholders like{" "}
                      <code className="font-mono">{"{{candidate}}"}</code> are
                      filled in automatically.
                    </p>
                  </form>

                  <form
                    action={scheduleInterviewAction}
                    className="space-y-2 border-t border-slate-100 pt-4"
                  >
                    <input type="hidden" name="applicationId" value={application.id} />
                    <input
                      name="title"
                      placeholder={`${application.currentStage?.name ?? "Interview"} — ${candidate.fullName}`}
                      className={fieldClass}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        name="startsAt"
                        type="datetime-local"
                        required
                        className={fieldClass}
                      />
                      <select name="durationMinutes" defaultValue="60" className={fieldClass}>
                        <option value="30">30 min</option>
                        <option value="45">45 min</option>
                        <option value="60">60 min</option>
                        <option value="90">90 min</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      Book interview
                    </button>
                    <p className="text-xs text-slate-400">
                      Creates a Google Meet event and invites the candidate.
                    </p>
                  </form>
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  <Link href="/integrations" className="text-indigo-600 hover:underline">
                    Connect Google
                  </Link>{" "}
                  to email and book interviews without leaving this page.
                </p>
              )}
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

          {application.driveFiles.length > 0 && (
            <SidebarList
              title="Documents"
              icon={FileText}
              items={application.driveFiles.map((file) => ({
                id: file.id,
                primary: file.name,
                secondary: file.kind.replace("_", " ").toLowerCase(),
                href: file.webViewLink ?? undefined,
              }))}
            />
          )}

          {application.emails.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Correspondence
                </h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {application.emails.map((email) => (
                  <li key={email.id} className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          email.direction === "INBOUND"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {email.direction === "INBOUND" ? "Received" : "Sent"}
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

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Scorecard</h2>
            <form action={addScorecardAction} className="mt-3 space-y-2">
              <input type="hidden" name="applicationId" value={application.id} />
              <select
                name="verdict"
                defaultValue="YES"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              >
                <option value="STRONG_YES">Strong yes</option>
                <option value="YES">Yes</option>
                <option value="NEUTRAL">Neutral</option>
                <option value="NO">No</option>
                <option value="STRONG_NO">Strong no</option>
              </select>
              <textarea
                name="strengths"
                rows={2}
                placeholder="Strengths"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
              />
              <textarea
                name="concerns"
                rows={2}
                placeholder="Concerns"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="submit"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Submit scorecard
              </button>
            </form>

            {application.scorecards.length > 0 && (
              <ul className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                {application.scorecards.map((card) => (
                  <li key={card.id} className="text-sm">
                    <span className="font-medium text-slate-900">
                      {card.verdict.replace("_", " ").toLowerCase()}
                    </span>
                    <span className="ml-2 text-xs text-slate-400">
                      {card.author?.name} · {relativeTime(card.createdAt)}
                    </span>
                    {card.strengths && (
                      <p className="mt-0.5 text-xs text-slate-500">{card.strengths}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}

const fieldClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";

function ContactRow({
  icon: Icon,
  value,
  href,
}: {
  icon: typeof Mail;
  value: string;
  href?: string;
}) {
  const content = (
    <span className="flex items-center gap-2 text-sm text-slate-600">
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
      <span className="truncate">{value}</span>
    </span>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block hover:text-indigo-600">
      {content}
    </a>
  ) : (
    content
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
                  <span className="block truncate text-sm text-slate-900">
                    {item.primary}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {item.secondary}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
              </a>
            ) : (
              <div className="px-5 py-3">
                <span className="block truncate text-sm text-slate-900">
                  {item.primary}
                </span>
                <span className="block text-xs text-slate-500">{item.secondary}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
