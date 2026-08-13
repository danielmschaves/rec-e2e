import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPin, Users2, Plus } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { createJobAction } from "@/app/actions";
import { relativeTime } from "@/lib/ui";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  DRAFT: "bg-slate-100 text-slate-600 ring-slate-200",
  ON_HOLD: "bg-amber-50 text-amber-700 ring-amber-200",
  CLOSED: "bg-slate-100 text-slate-600 ring-slate-200",
  FILLED: "bg-indigo-50 text-indigo-700 ring-indigo-200",
};

export default async function JobsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [jobs, pipelines] = await Promise.all([
    prisma.job.findMany({
      where: { orgId: user.orgId },
      include: {
        pipeline: { select: { name: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.pipeline.findMany({
      where: { orgId: user.orgId, archived: false },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <Shell user={user} active="/jobs">
      <PageHeader
        title="Jobs"
        subtitle={`${jobs.filter((j) => j.status === "OPEN").length} open of ${jobs.length}`}
      />

      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {jobs.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-sm text-slate-500">
                No jobs yet — create your first one on the right.
              </p>
            </div>
          )}

          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/jobs/${job.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-indigo-300"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-slate-900">
                      {job.title}
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        STATUS_STYLE[job.status] ?? STATUS_STYLE.DRAFT
                      }`}
                    >
                      {job.status.replace("_", " ").toLowerCase()}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    {job.department && <span>{job.department}</span>}
                    {job.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" strokeWidth={2} />
                        {job.location}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Users2 className="h-3 w-3" strokeWidth={2} />
                      {job._count.applications} candidate
                      {job._count.applications === 1 ? "" : "s"}
                    </span>
                    <span>Flow: {job.pipeline.name}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-slate-400">
                  {relativeTime(job.createdAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>

        <div>
          <form
            action={createJobAction}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
          >
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-indigo-600" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">New job</h2>
            </div>

            <Field label="Title" required>
              <input
                name="title"
                required
                placeholder="Senior Backend Engineer"
                className={inputClass}
              />
            </Field>

            <Field label="Hiring flow" required>
              <select name="pipelineId" required className={inputClass} defaultValue="">
                <option value="" disabled>
                  Choose a pipeline…
                </option>
                {pipelines.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Department">
                <input name="department" placeholder="Engineering" className={inputClass} />
              </Field>
              <Field label="Openings">
                <input
                  name="openings"
                  type="number"
                  min={1}
                  defaultValue={1}
                  className={inputClass}
                />
              </Field>
            </div>

            <Field label="Location">
              <input name="location" placeholder="Remote (EU)" className={inputClass} />
            </Field>

            <Field label="Description">
              <textarea
                name="description"
                rows={3}
                placeholder="What this person will own…"
                className={inputClass}
              />
            </Field>

            <button
              type="submit"
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
            >
              Create job
            </button>
          </form>
        </div>
      </div>
    </Shell>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {children}
    </label>
  );
}
