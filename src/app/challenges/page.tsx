import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, Code2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { formatDate, humanise, CHALLENGE_STATUS_STYLE } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function ChallengesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [challenges, draftCount] = await Promise.all([
    prisma.challenge.findMany({
      where: { userId: user.id },
      include: {
        opportunity: { include: { company: true } },
        requirements: true,
      },
      orderBy: [{ status: "asc" }, { deadline: "asc" }],
    }),
    prisma.emailDraft.count({ where: { userId: user.id, status: "DRAFT" } }),
  ]);

  return (
    <Shell user={user} active="/challenges" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title="Challenges"
        subtitle="Take-homes and technical exercises across every process."
      />

      <div className="space-y-3 p-6">
        {challenges.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <Code2 className="mx-auto h-6 w-6 text-slate-300" strokeWidth={2} />
            <p className="mt-2 text-sm text-slate-500">
              No challenges yet. Add one from a process when a take-home lands.
            </p>
          </div>
        )}

        {challenges.map((c) => {
          const must = c.requirements.filter((r) => r.mustHave);
          const done = must.filter((r) => r.done).length;
          const progress = must.length > 0 ? Math.round((done / must.length) * 100) : 0;
          const daysLeft = c.deadline
            ? Math.ceil((c.deadline.getTime() - Date.now()) / 86_400_000)
            : null;
          const urgent =
            daysLeft !== null &&
            daysLeft <= 2 &&
            !["SUBMITTED", "PASSED", "FAILED"].includes(c.status);

          return (
            <Link
              key={c.id}
              href={`/challenges/${c.id}`}
              className={`block rounded-xl border bg-white p-4 transition-colors ${
                urgent ? "border-amber-300" : "border-slate-200 hover:border-indigo-300"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-slate-900">
                      {c.title}
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        CHALLENGE_STATUS_STYLE[c.status]
                      }`}
                    >
                      {humanise(c.status)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {c.opportunity.company.name} · {c.opportunity.roleTitle}
                  </div>
                </div>

                {c.deadline && (
                  <span
                    className={`flex shrink-0 items-center gap-1.5 text-xs ${
                      urgent ? "font-medium text-amber-700" : "text-slate-500"
                    }`}
                  >
                    <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} />
                    {daysLeft !== null && daysLeft < 0
                      ? `${Math.abs(daysLeft)}d overdue`
                      : daysLeft === 0
                        ? "Due today"
                        : `${daysLeft}d left`}
                    {" · "}
                    {formatDate(c.deadline)}
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500">
                  {done}/{must.length} must-haves
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </Shell>
  );
}
