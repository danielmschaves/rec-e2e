import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPin, Plus, Sparkles } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { createProcessAction } from "@/app/actions";
import {
  initials,
  tint,
  relativeTime,
  inputClass,
  humanise,
  OPPORTUNITY_STATUS_STYLE,
  PRIORITY_STYLE,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function ProcessesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [opportunities, templates, draftCount] = await Promise.all([
    prisma.opportunity.findMany({
      where: { userId: user.id },
      include: { company: true, currentStage: true, _count: { select: { challenges: true } } },
      orderBy: [{ status: "asc" }, { lastActivityAt: "desc" }],
    }),
    prisma.processTemplate.findMany({
      where: { userId: user.id, archived: false },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    prisma.emailDraft.count({ where: { userId: user.id, status: "DRAFT" } }),
  ]);

  const open = opportunities.filter((o) =>
    ["ACTIVE", "ON_HOLD", "OFFER"].includes(o.status),
  );
  const closed = opportunities.filter(
    (o) => !["ACTIVE", "ON_HOLD", "OFFER"].includes(o.status),
  );

  return (
    <Shell user={user} active="/processes" badges={{ "/drafts": draftCount }}>
      <PageHeader
        title="Processes"
        subtitle={`${open.length} live · ${closed.length} closed`}
      />

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {open.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-sm text-slate-500">
                No live processes — add the first one on the right.
              </p>
            </div>
          )}

          {open.map((o) => (
            <Link
              key={o.id}
              href={`/processes/${o.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-indigo-300"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-sm font-semibold ${tint(
                    o.company.name,
                  )}`}
                >
                  {initials(o.company.name)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-slate-900">
                      {o.company.name}
                    </h2>
                    <span className="truncate text-sm text-slate-500">{o.roleTitle}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        OPPORTUNITY_STATUS_STYLE[o.status]
                      }`}
                    >
                      {humanise(o.status)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                        PRIORITY_STYLE[o.priority]
                      }`}
                    >
                      {humanise(o.priority)}
                    </span>
                    {o.flowMode === "PERSONALIZED" && (
                      <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                        <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                        Their own flow
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span className="font-medium text-indigo-600">
                      {o.currentStage?.name ?? "—"}
                    </span>
                    {o.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" strokeWidth={2} />
                        {o.location}
                      </span>
                    )}
                    {o._count.challenges > 0 && (
                      <span>
                        {o._count.challenges} challenge{o._count.challenges === 1 ? "" : "s"}
                      </span>
                    )}
                    <span>{relativeTime(o.lastActivityAt)}</span>
                  </div>

                  {o.nextAction && (
                    <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                      Next: {o.nextAction}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}

          {closed.length > 0 && (
            <div className="pt-4">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Closed
              </h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {closed.map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`/processes/${o.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-700">
                        {o.company.name} · {o.roleTitle}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                          OPPORTUNITY_STATUS_STYLE[o.status]
                        }`}
                      >
                        {humanise(o.status)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <form
          action={createProcessAction}
          className="h-fit space-y-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-indigo-600" strokeWidth={2} />
            <h2 className="text-sm font-semibold text-slate-900">Track a new process</h2>
          </div>

          <input name="companyName" required placeholder="Company" className={inputClass} />
          <input name="roleTitle" required placeholder="Role title" className={inputClass} />

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Their email domain
            </span>
            <input
              name="companyDomain"
              placeholder="acme.com"
              className={inputClass}
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              How mail from anyone there gets matched to this process.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Which flow do you expect?
            </span>
            <select name="templateId" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Choose a flow…
              </option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">
              A starting point — you can change their steps later.
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <input name="location" placeholder="Location" className={inputClass} />
            <select name="priority" defaultValue="MEDIUM" className={inputClass}>
              <option value="DREAM">Dream job</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>

          <input name="source" placeholder="Source (referral, LinkedIn…)" className={inputClass} />
          <input name="jobPostUrl" placeholder="Link to the posting" className={inputClass} />

          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Start tracking
          </button>
        </form>
      </div>
    </Shell>
  );
}
