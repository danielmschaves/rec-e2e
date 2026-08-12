import { prisma } from "@/lib/prisma";
import type { Application, Candidate } from "@prisma/client";

export type Match = {
  candidate: Candidate;
  application: Application | null;
};

/**
 * Resolves an incoming Google artifact to a candidate.
 *
 * Email address is the join key across all three Google surfaces — it is the
 * one identifier that appears in a Gmail header, a Calendar attendee list and
 * a Drive sharing record alike.
 */
export async function matchByEmails(
  orgId: string,
  emails: string[],
): Promise<Match | null> {
  const normalised = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  if (normalised.length === 0) return null;

  const candidate = await prisma.candidate.findFirst({
    where: { orgId, email: { in: normalised, mode: "insensitive" } },
  });
  if (!candidate) return null;

  const application = await pickApplication(candidate.id);
  return { candidate, application };
}

/**
 * A candidate may be in flight for several roles. Prefer the active one with
 * the most recent activity — that is nearly always the thread being discussed.
 */
export async function pickApplication(
  candidateId: string,
  jobHint?: string | null,
): Promise<Application | null> {
  if (jobHint) {
    const byJob = await prisma.application.findFirst({
      where: { candidateId, jobId: jobHint },
    });
    if (byJob) return byJob;
  }

  const active = await prisma.application.findFirst({
    where: { candidateId, status: "ACTIVE" },
    orderBy: { lastActivityAt: "desc" },
  });
  if (active) return active;

  return prisma.application.findFirst({
    where: { candidateId },
    orderBy: { lastActivityAt: "desc" },
  });
}

/**
 * Narrows to one application when a text blob (email subject, event title)
 * mentions a job title. Useful when a candidate is in two pipelines at once.
 */
export async function matchWithJobHint(
  orgId: string,
  emails: string[],
  text: string | null | undefined,
): Promise<Match | null> {
  const match = await matchByEmails(orgId, emails);
  if (!match || !text) return match;

  const applications = await prisma.application.findMany({
    where: { candidateId: match.candidate.id },
    include: { job: { select: { id: true, title: true } } },
    orderBy: { lastActivityAt: "desc" },
  });
  if (applications.length < 2) return match;

  const lower = text.toLowerCase();
  const hinted = applications.find((a) => lower.includes(a.job.title.toLowerCase()));
  return hinted ? { candidate: match.candidate, application: hinted } : match;
}
