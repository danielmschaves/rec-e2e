import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MapPin, Users2, Sparkles, AlertTriangle } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { addCandidateAction } from "@/app/actions";
import { initials, avatarTint, relativeTime } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function JobBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const job = await prisma.job.findFirst({
    where: { id, orgId: user.orgId },
    include: {
      pipeline: { include: { stages: { orderBy: { position: "asc" } } } },
      applications: {
        include: { candidate: true, currentStage: true },
        orderBy: { lastActivityAt: "desc" },
      },
    },
  });
  if (!job) notFound();

  // Columns come from the template; anything a recruiter invented for one
  // candidate is collected at the end so personalised flows stay visible.
  const templateKeys = new Set(job.pipeline.stages.map((s) => s.key));
  const columns = job.pipeline.stages.map((stage) => ({
    key: stage.key,
    name: stage.name,
    applications: job.applications.filter(
      (a) => a.status === "ACTIVE" && a.currentStage?.key === stage.key,
    ),
  }));

  const customColumn = job.applications.filter(
    (a) =>
      a.status === "ACTIVE" &&
      a.currentStage &&
      !templateKeys.has(a.currentStage.key),
  );
  if (customColumn.length > 0) {
    columns.push({
      key: "__custom__",
      name: "Custom steps",
      applications: customColumn,
    });
  }

  const settled = job.applications.filter((a) => a.status !== "ACTIVE");
  const now = Date.now();

  return (
    <Shell user={user} active="/jobs">
      <PageHeader
        title={job.title}
        subtitle={[job.department, job.location, `Flow: ${job.pipeline.name}`]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Link
            href="/jobs"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
          >
            All jobs
          </Link>
        }
      />

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
          <span className="flex items-center gap-1.5">
            <Users2 className="h-4 w-4" strokeWidth={2} />
            {job.applications.filter((a) => a.status === "ACTIVE").length} active
          </span>
          {job.location && (
            <span className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4" strokeWidth={2} />
              {job.location}
            </span>
          )}
          <span>
            {job.openings} opening{job.openings === 1 ? "" : "s"}
          </span>
        </div>

        {/* Board */}
        <div className="scroll-thin -mx-1 overflow-x-auto px-1 pb-2">
          <div className="flex gap-3">
            {columns.map((column) => (
              <div
                key={column.key}
                className="flex w-72 shrink-0 flex-col rounded-xl bg-slate-100/70"
              >
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
                    {column.name}
                  </span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500">
                    {column.applications.length}
                  </span>
                </div>

                <div className="flex-1 space-y-2 px-2 pb-2">
                  {column.applications.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
                      Empty
                    </div>
                  )}

                  {column.applications.map((application) => {
                    const overdue =
                      application.currentStage?.dueAt &&
                      application.currentStage.dueAt.getTime() < now;

                    return (
                      <Link
                        key={application.id}
                        href={`/applications/${application.id}`}
                        className="block rounded-lg border border-slate-200 bg-white p-3 transition-shadow hover:shadow-sm"
                      >
                        <div className="flex items-start gap-2.5">
                          <div
                            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${avatarTint(
                              application.candidate.email,
                            )}`}
                          >
                            {initials(application.candidate.fullName)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-slate-900">
                              {application.candidate.fullName}
                            </div>
                            {application.candidate.headline && (
                              <div className="truncate text-xs text-slate-500">
                                {application.candidate.headline}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {application.flowMode === "PERSONALIZED" && (
                            <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                              <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                              Personalised
                            </span>
                          )}
                          {overdue && (
                            <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                              <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
                              Overdue
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-slate-400">
                            {relativeTime(application.lastActivityAt)}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <form
            action={addCandidateAction}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
          >
            <h2 className="text-sm font-semibold text-slate-900">Add a candidate</h2>
            <p className="-mt-1 text-xs text-slate-500">
              They start on the first stage of {job.pipeline.name}.
            </p>
            <input type="hidden" name="jobId" value={job.id} />
            <input
              name="fullName"
              required
              placeholder="Full name"
              className={inputClass}
            />
            <input
              name="email"
              type="email"
              required
              placeholder="Email — used to match Gmail and Calendar"
              className={inputClass}
            />
            <input name="headline" placeholder="Headline (optional)" className={inputClass} />
            <input name="source" placeholder="Source (optional)" className={inputClass} />
            <button
              type="submit"
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
            >
              Add to pipeline
            </button>
          </form>

          {settled.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white lg:col-span-2">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  Closed out
                </h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {settled.map((application) => (
                  <li key={application.id}>
                    <Link
                      href={`/applications/${application.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-slate-50"
                    >
                      <span className="text-sm text-slate-900">
                        {application.candidate.fullName}
                      </span>
                      <span className="text-xs text-slate-500">
                        {application.status.toLowerCase()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";
