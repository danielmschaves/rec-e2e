import { redirect } from "next/navigation";
import { GitBranch, Clock } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { createPipelineAction } from "@/app/actions";
import { STAGE_TYPE_LABEL } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const pipelines = await prisma.pipeline.findMany({
    where: { orgId: user.orgId, archived: false },
    include: {
      stages: { orderBy: { position: "asc" } },
      _count: { select: { jobs: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return (
    <Shell user={user} active="/pipelines">
      <PageHeader
        title="Pipelines"
        subtitle="Reusable templates. Applications get their own copy, so personalising one candidate never changes the template."
      />

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {pipelines.map((pipeline) => (
            <section
              key={pipeline.id}
              className="rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-slate-400" strokeWidth={2} />
                    <h2 className="text-sm font-semibold text-slate-900">
                      {pipeline.name}
                    </h2>
                    {pipeline.isDefault && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                        Default
                      </span>
                    )}
                  </div>
                  {pipeline.description && (
                    <p className="mt-1 text-sm text-slate-500">
                      {pipeline.description}
                    </p>
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {pipeline._count.jobs} job{pipeline._count.jobs === 1 ? "" : "s"} ·{" "}
                  {pipeline.stages.length} stages
                </span>
              </div>

              <ol className="flex flex-wrap gap-2 p-5">
                {pipeline.stages.map((stage, index) => (
                  <li
                    key={stage.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-semibold text-slate-500">
                      {index + 1}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {stage.name}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span>{STAGE_TYPE_LABEL[stage.type]}</span>
                        {stage.slaDays && (
                          <span className="flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                            {stage.slaDays}d
                          </span>
                        )}
                        {stage.optional && (
                          <span className="text-slate-400">optional</span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <form
          action={createPipelineAction}
          className="h-fit space-y-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <h2 className="text-sm font-semibold text-slate-900">New pipeline</h2>
          <input name="name" required placeholder="Name" className={inputClass} />
          <input name="description" placeholder="Description" className={inputClass} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Stages — one per line, in order
            </span>
            <textarea
              name="stages"
              required
              rows={8}
              defaultValue={"Applied\nScreen\nInterview\nOffer\nHired"}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Create pipeline
          </button>
        </form>
      </div>
    </Shell>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";
