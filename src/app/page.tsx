import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Briefcase,
  CalendarClock,
  AlertTriangle,
  ArrowRight,
  Mail,
  Code2,
  CheckCircle2,
  Inbox,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  initials,
  tint,
  relativeTime,
  formatDateTime,
  formatDate,
  OPPORTUNITY_STATUS_STYLE,
  humanise,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const userId = user.id;

  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const now = new Date();

  const [
    active,
    offers,
    upcoming,
    flagged,
    activities,
    nextActions,
    drafts,
    challenges,
    quiet,
    detected,
  ] = await Promise.all([
    prisma.opportunity.count({ where: { userId, status: { in: ["ACTIVE", "ON_HOLD"] } } }),
    prisma.opportunity.count({ where: { userId, status: "OFFER" } }),
    prisma.calendarEvent.findMany({
      where: { userId, status: "CONFIRMED", startsAt: { gte: now, lte: weekAhead } },
      include: { opportunity: { include: { company: true } } },
      orderBy: { startsAt: "asc" },
      take: 5,
    }),
    prisma.activity.findMany({
      where: { userId, type: "FLAGGED" },
      include: { opportunity: { include: { company: true } } },
      orderBy: { occurredAt: "desc" },
      take: 5,
    }),
    prisma.activity.findMany({
      where: { userId },
      include: { opportunity: { include: { company: true } } },
      orderBy: { occurredAt: "desc" },
      take: 12,
    }),
    prisma.opportunity.findMany({
      where: {
        userId,
        status: { in: ["ACTIVE", "ON_HOLD", "OFFER"] },
        nextAction: { not: null },
      },
      include: { company: true, currentStage: true },
      orderBy: [{ nextActionAt: "asc" }, { lastActivityAt: "desc" }],
      take: 6,
    }),
    prisma.emailDraft.findMany({
      where: { userId, status: "DRAFT" },
      include: { opportunity: { include: { company: true } } },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
    prisma.challenge.findMany({
      where: { userId, status: { in: ["PLANNING", "IN_PROGRESS", "READY_FOR_REVIEW"] } },
      include: { opportunity: { include: { company: true } }, requirements: true },
      orderBy: { deadline: "asc" },
      take: 4,
    }),
    prisma.opportunity.findMany({
      where: {
        userId,
        status: { in: ["ACTIVE", "OFFER"] },
        currentStage: { chaseAt: { lt: now }, status: "ACTIVE" },
      },
      include: { company: true, currentStage: true },
      orderBy: { lastActivityAt: "asc" },
      take: 5,
    }),
    prisma.opportunity.findMany({
      where: { userId, autoDetected: true, confirmedAt: null },
      include: { company: true },
      orderBy: { appliedAt: "desc" },
      take: 6,
    }),
  ]);

  const stats = [
    { label: "Live processes", value: active, icon: Briefcase, href: "/processes" },
    { label: "Offers", value: offers, icon: CheckCircle2, href: "/processes" },
    { label: "Interviews this week", value: upcoming.length, icon: CalendarClock, href: "/processes" },
    { label: "Drafts to review", value: drafts.length, icon: Mail, href: "/drafts" },
  ];

  return (
    <Shell user={user} active="/" badges={{ "/drafts": drafts.length }}>
      <PageHeader
        title={`Morning, ${user.name.split(" ")[0]}`}
        subtitle="Everything you owe, and everything owed to you."
      />

      <div className="space-y-6 p-6">
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Link
                key={stat.label}
                href={stat.href}
                className="group rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-indigo-300"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">{stat.label}</span>
                  <Icon
                    className="h-4 w-4 text-slate-400 transition-colors group-hover:text-indigo-500"
                    strokeWidth={2}
                  />
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                  {stat.value}
                </div>
              </Link>
            );
          })}
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {detected.length > 0 && (
              <section className="rounded-xl border border-sky-200 bg-sky-50/60 p-5">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-sky-600" strokeWidth={2} />
                  <h2 className="text-sm font-semibold text-sky-900">
                    Picked up from your inbox
                  </h2>
                </div>
                <p className="mt-1 text-xs text-sky-800/80">
                  Already tracked — open one to check the role is right.
                </p>
                <ul className="mt-3 space-y-2">
                  {detected.map((o) => (
                    <li key={o.id}>
                      <Link
                        href={`/processes/${o.id}`}
                        className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-white"
                      >
                        <span className="min-w-0">
                          <span className="font-medium text-slate-900">
                            {o.company.name}
                          </span>
                          <span className="ml-2 text-slate-500">{o.roleTitle}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          via {o.detectedFrom} · {relativeTime(o.appliedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {nextActions.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-5 py-3.5">
                  <h2 className="text-sm font-semibold text-slate-900">Your move</h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {nextActions.map((o) => (
                    <li key={o.id}>
                      <Link
                        href={`/processes/${o.id}`}
                        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50"
                      >
                        <div
                          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-semibold ${tint(
                            o.company.name,
                          )}`}
                        >
                          {initials(o.company.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-900">
                            {o.nextAction}
                          </div>
                          <div className="truncate text-xs text-slate-500">
                            {o.company.name} · {o.currentStage?.name ?? "—"}
                          </div>
                        </div>
                        {o.nextActionAt && (
                          <span
                            className={`shrink-0 text-xs ${
                              o.nextActionAt < now ? "text-rose-600" : "text-slate-400"
                            }`}
                          >
                            {relativeTime(o.nextActionAt)}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(quiet.length > 0 || flagged.length > 0) && (
              <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" strokeWidth={2} />
                  <h2 className="text-sm font-semibold text-amber-900">Worth a nudge</h2>
                </div>
                <ul className="mt-3 space-y-2">
                  {quiet.map((o) => (
                    <li key={o.id}>
                      <Link
                        href={`/processes/${o.id}`}
                        className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-white"
                      >
                        <span className="min-w-0">
                          <span className="font-medium text-slate-900">{o.company.name}</span>
                          <span className="ml-2 text-slate-500">
                            quiet on {o.currentStage?.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {relativeTime(o.lastActivityAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                  {flagged
                    .filter((f) => !quiet.some((q) => q.id === f.opportunityId))
                    .map((item) => (
                      <li key={item.id}>
                        <Link
                          href={
                            item.opportunityId ? `/processes/${item.opportunityId}` : "/processes"
                          }
                          className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-white"
                        >
                          <span className="min-w-0 truncate text-slate-700">{item.title}</span>
                          <span className="shrink-0 text-xs text-slate-400">
                            {relativeTime(item.occurredAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              </section>
            )}

            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
                <span className="text-xs text-slate-400">
                  Mail, interviews and files sync automatically
                </span>
              </div>
              <div className="p-5">
                <ActivityFeed activities={activities} showLinks />
              </div>
            </section>
          </div>

          <div className="space-y-6">
            {drafts.length > 0 && (
              <section className="rounded-xl border border-violet-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
                  <Mail className="h-4 w-4 text-violet-600" strokeWidth={2} />
                  <h2 className="text-sm font-semibold text-slate-900">Waiting on you</h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {drafts.map((draft) => (
                    <li key={draft.id}>
                      <Link
                        href="/drafts"
                        className="block px-5 py-3 transition-colors hover:bg-slate-50"
                      >
                        <div className="truncate text-sm font-medium text-slate-900">
                          {draft.subject}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {draft.opportunity?.company.name ?? draft.toEmail} · drafted{" "}
                          {relativeTime(draft.createdAt)}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {challenges.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3.5">
                  <Code2 className="h-4 w-4 text-slate-400" strokeWidth={2} />
                  <h2 className="text-sm font-semibold text-slate-900">Challenges</h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {challenges.map((c) => {
                    const done = c.requirements.filter((r) => r.done).length;
                    return (
                      <li key={c.id}>
                        <Link
                          href={`/challenges/${c.id}`}
                          className="block px-5 py-3 transition-colors hover:bg-slate-50"
                        >
                          <div className="truncate text-sm font-medium text-slate-900">
                            {c.title}
                          </div>
                          <div className="text-xs text-slate-500">
                            {c.opportunity.company.name} · {done}/{c.requirements.length} done
                            {c.deadline && ` · due ${formatDate(c.deadline)}`}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">Upcoming</h2>
              </div>
              <div className="p-3">
                {upcoming.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-slate-500">
                    Nothing booked in the next 7 days.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {upcoming.map((event) => (
                      <li key={event.id}>
                        <Link
                          href={
                            event.opportunityId
                              ? `/processes/${event.opportunityId}`
                              : "/processes"
                          }
                          className="block rounded-lg px-2 py-2 transition-colors hover:bg-slate-50"
                        >
                          <div className="truncate text-sm font-medium text-slate-900">
                            {event.title}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {formatDateTime(event.startsAt)}
                            {event.opportunity && ` · ${event.opportunity.company.name}`}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
