import { redirect } from "next/navigation";
import { GitBranch, Clock } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { createFlowAction } from "@/app/actions";
import { STAGE_TYPE_LABEL, inputClass } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function FlowsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [templates, draftCount] = await Promise.all([
    prisma.processTemplate.findMany({
      where: { userId: user.id, archived: false },
      include: {
        stages: { orderBy: { position: "asc" } },
        _count: { select: { opportunities: true } },
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.emailDraft.count({ where: { userId: user.id, status: "DRAFT" } }),
  ]);

  return (
    <Shell user={user} active="/flows" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title="Flows"
        subtitle="Your expectation of how a hiring process runs. Each company gets its own copy, so changing theirs never changes this."
      />

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {templates.map((template) => (
            <section
              key={template.id}
              className="rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-slate-400" strokeWidth={2} />
                    <h2 className="text-sm font-semibold text-slate-900">{template.name}</h2>
                    {template.isDefault && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                        Default
                      </span>
                    )}
                  </div>
                  {template.description && (
                    <p className="mt-1 text-sm text-slate-500">{template.description}</p>
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {template._count.opportunities} process
                  {template._count.opportunities === 1 ? "" : "es"} · {template.stages.length}{" "}
                  stages
                </span>
              </div>

              <ol className="flex flex-wrap gap-2 p-5">
                {template.stages.map((stage, index) => (
                  <li
                    key={stage.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-semibold text-slate-500">
                      {index + 1}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-slate-900">{stage.name}</div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span>{STAGE_TYPE_LABEL[stage.type]}</span>
                        {stage.chaseAfterDays && (
                          <span className="flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                            nudge after {stage.chaseAfterDays}d
                          </span>
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
          action={createFlowAction}
          className="h-fit space-y-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <h2 className="text-sm font-semibold text-slate-900">New flow</h2>
          <input name="name" required placeholder="Name" className={inputClass} />
          <input name="description" placeholder="When you'd use it" className={inputClass} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Stages — one per line, in order
            </span>
            <textarea
              name="stages"
              required
              rows={8}
              defaultValue={"Applied\nScreen\nInterview\nOffer\nAccepted"}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Create flow
          </button>
        </form>
      </div>
    </Shell>
  );
}
