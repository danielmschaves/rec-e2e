import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { addCandidateAction } from "@/app/actions";
import {
  initials,
  avatarTint,
  relativeTime,
  APPLICATION_STATUS_STYLE,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function CandidatesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [candidates, jobs] = await Promise.all([
    prisma.candidate.findMany({
      where: { orgId: user.orgId },
      include: {
        applications: {
          include: { job: true, currentStage: true },
          orderBy: { lastActivityAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.job.findMany({
      where: { orgId: user.orgId, status: "OPEN" },
      orderBy: { title: "asc" },
    }),
  ]);

  return (
    <Shell user={user} active="/candidates">
      <PageHeader
        title="Candidates"
        subtitle={`${candidates.length} people in your talent pool`}
      />

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {candidates.length === 0 ? (
            <p className="p-10 text-center text-sm text-slate-500">
              No candidates yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {candidates.map((candidate) => {
                const primary = candidate.applications[0];
                return (
                  <li key={candidate.id}>
                    <Link
                      href={
                        primary ? `/applications/${primary.id}` : "/candidates"
                      }
                      className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50"
                    >
                      <div
                        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold ${avatarTint(
                          candidate.email,
                        )}`}
                      >
                        {initials(candidate.fullName)}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900">
                          {candidate.fullName}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {candidate.headline ?? candidate.email}
                        </div>
                      </div>

                      <div className="hidden min-w-0 flex-1 sm:block">
                        {primary ? (
                          <>
                            <div className="truncate text-sm text-slate-700">
                              {primary.job.title}
                            </div>
                            <div className="truncate text-xs text-slate-500">
                              {primary.currentStage?.name ?? "—"}
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">
                            No application
                          </span>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        {primary && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                              APPLICATION_STATUS_STYLE[primary.status]
                            }`}
                          >
                            {primary.status.toLowerCase()}
                          </span>
                        )}
                        <span className="hidden text-xs text-slate-400 md:inline">
                          {relativeTime(candidate.createdAt)}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form
          action={addCandidateAction}
          className="h-fit space-y-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <h2 className="text-sm font-semibold text-slate-900">Add a candidate</h2>
          <input name="fullName" required placeholder="Full name" className={inputClass} />
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className={inputClass}
          />
          <input name="headline" placeholder="Headline" className={inputClass} />
          <input name="phone" placeholder="Phone" className={inputClass} />
          <select name="jobId" defaultValue="" className={inputClass}>
            <option value="">No job yet — add to pool</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                Apply to {job.title}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Add candidate
          </button>
          <p className="text-xs text-slate-400">
            Their email address is how Gmail, Calendar and Drive activity gets
            matched back to this person.
          </p>
        </form>
      </div>
    </Shell>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";
