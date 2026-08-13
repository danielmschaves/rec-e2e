import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Briefcase,
  Users,
  CalendarClock,
  AlertTriangle,
  ArrowRight,
  Zap,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { ActivityFeed } from "@/components/ActivityFeed";
import { initials, avatarTint, relativeTime, formatDateTime } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgId = user.orgId;

  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);

  const [
    openJobs,
    activeApplications,
    upcomingInterviews,
    flagged,
    activities,
    byStageType,
    recentApplications,
    hiredThisMonth,
  ] = await Promise.all([
    prisma.job.count({ where: { orgId, status: "OPEN" } }),
    prisma.application.count({ where: { orgId, status: "ACTIVE" } }),
    prisma.calendarEvent.findMany({
      where: {
        orgId,
        status: "CONFIRMED",
        startsAt: { gte: new Date(), lte: weekAhead },
      },
      include: { application: { include: { candidate: true, job: true } } },
      orderBy: { startsAt: "asc" },
      take: 5,
    }),
    prisma.activity.findMany({
      where: { orgId, type: "FLAGGED" },
      include: { application: { include: { candidate: true, job: true } } },
      orderBy: { occurredAt: "desc" },
      take: 5,
    }),
    prisma.activity.findMany({
      where: { orgId },
      include: { application: { include: { candidate: true, job: true } } },
      orderBy: { occurredAt: "desc" },
      take: 12,
    }),
    prisma.applicationStage.groupBy({
      by: ["type"],
      where: { status: "ACTIVE", application: { orgId, status: "ACTIVE" } },
      _count: { _all: true },
    }),
    prisma.application.findMany({
      where: { orgId, status: "ACTIVE" },
      include: { candidate: true, job: true, currentStage: true },
      orderBy: { lastActivityAt: "desc" },
      take: 6,
    }),
    prisma.application.count({
      where: {
        orgId,
        status: "HIRED",
        updatedAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
    }),
  ]);

  const stageOrder = [
    "SOURCED",
    "APPLIED",
    "SCREENING",
    "ASSESSMENT",
    "INTERVIEW",
    "REFERENCE_CHECK",
    "OFFER",
  ];
  const funnel = stageOrder
    .map((type) => ({
      type,
      count: byStageType.find((s) => s.type === type)?._count._all ?? 0,
    }))
    .filter((s) => s.count > 0);
  const funnelMax = Math.max(1, ...funnel.map((s) => s.count));

  const stats = [
    { label: "Open roles", value: openJobs, icon: Briefcase, href: "/jobs" },
    {
      label: "Active candidates",
      value: activeApplications,
      icon: Users,
      href: "/candidates",
    },
    {
      label: "Interviews this week",
      value: upcomingInterviews.length,
      icon: CalendarClock,
      href: "/jobs",
    },
    {
      label: "Hired this month",
      value: hiredThisMonth,
      icon: Zap,
      href: "/candidates",
    },
  ];

  return (
    <Shell user={user} active="/">
      <PageHeader
        title={`Good to see you, ${user.name.split(" ")[0]}`}
        subtitle="Everything moving through your process right now."
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
            {flagged.length > 0 && (
              <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" strokeWidth={2} />
                  <h2 className="text-sm font-semibold text-amber-900">
                    Needs your attention
                  </h2>
                </div>
                <ul className="mt-3 space-y-2">
                  {flagged.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={
                          item.applicationId
                            ? `/applications/${item.applicationId}`
                            : "/jobs"
                        }
                        className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm transition-colors hover:bg-white"
                      >
                        <span className="min-w-0">
                          <span className="font-medium text-slate-900">
                            {item.application?.candidate.fullName ?? "Application"}
                          </span>
                          <span className="ml-2 text-slate-500">{item.title}</span>
                        </span>
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
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Where candidates are right now
                </h2>
              </div>
              <div className="p-5">
                {funnel.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No active candidates yet. Add one from a job page.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {funnel.map((step) => (
                      <div key={step.type} className="flex items-center gap-3">
                        <span className="w-32 shrink-0 text-xs font-medium text-slate-600">
                          {step.type.replace("_", " ").toLowerCase()}
                        </span>
                        <div className="h-6 flex-1 overflow-hidden rounded-md bg-slate-100">
                          <div
                            className="flex h-full items-center justify-end rounded-md bg-indigo-500 px-2 text-xs font-medium text-white transition-all"
                            style={{
                              width: `${Math.max(8, (step.count / funnelMax) * 100)}%`,
                            }}
                          >
                            {step.count}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Recent activity
                </h2>
                <span className="text-xs text-slate-400">
                  Synced from Gmail, Calendar and Drive
                </span>
              </div>
              <div className="p-5">
                <ActivityFeed activities={activities} showLinks />
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Upcoming interviews
                </h2>
              </div>
              <div className="p-3">
                {upcomingInterviews.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-slate-500">
                    Nothing scheduled in the next 7 days.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {upcomingInterviews.map((event) => (
                      <li key={event.id}>
                        <Link
                          href={
                            event.applicationId
                              ? `/applications/${event.applicationId}`
                              : "/"
                          }
                          className="block rounded-lg px-2 py-2 transition-colors hover:bg-slate-50"
                        >
                          <div className="truncate text-sm font-medium text-slate-900">
                            {event.title}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {formatDateTime(event.startsAt)}
                            {event.application &&
                              ` · ${event.application.candidate.fullName}`}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Recently active
                </h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {recentApplications.map((application) => (
                  <li key={application.id}>
                    <Link
                      href={`/applications/${application.id}`}
                      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
                    >
                      <div
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold ${avatarTint(
                          application.candidate.email,
                        )}`}
                      >
                        {initials(application.candidate.fullName)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900">
                          {application.candidate.fullName}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {application.currentStage?.name ?? "—"} ·{" "}
                          {application.job.title}
                        </div>
                      </div>
                      <ArrowRight
                        className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-indigo-500"
                        strokeWidth={2}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
