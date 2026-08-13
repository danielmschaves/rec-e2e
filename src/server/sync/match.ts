import { prisma } from "@/lib/prisma";
import type { Opportunity } from "@prisma/client";

export type Match = {
  companyId: string;
  opportunity: Opportunity | null;
  /** How we recognised them — shown in the timeline so matches are auditable. */
  via: "contact" | "domain";
};

/**
 * Resolves an incoming Google artifact to a company you're in a process with.
 *
 * Two signals, in order of confidence:
 *   1. A known Contact's exact address (recruiter@acme.com).
 *   2. The company's registered email domain — so a hiring manager who has
 *      never emailed you before still lands on the right process.
 */
export async function matchByEmails(
  userId: string,
  emails: string[],
  hintText?: string | null,
): Promise<Match | null> {
  const normalised = [
    ...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean)),
  ];
  if (normalised.length === 0) return null;

  const contact = await prisma.contact.findFirst({
    where: { userId, email: { in: normalised, mode: "insensitive" }, companyId: { not: null } },
  });
  if (contact?.companyId) {
    return {
      companyId: contact.companyId,
      opportunity: await pickOpportunity(userId, contact.companyId, hintText),
      via: "contact",
    };
  }

  const domains = [
    ...new Set(normalised.map((e) => e.split("@")[1]).filter(Boolean)),
  ];
  if (domains.length === 0) return null;

  // Skip the big consumer mail hosts — a gmail.com sender tells us nothing.
  const generic = new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
  ]);
  const meaningful = domains.filter((d) => !generic.has(d));
  if (meaningful.length === 0) return null;

  const company = await prisma.company.findFirst({
    where: { userId, domains: { hasSome: meaningful } },
  });
  if (!company) return null;

  return {
    companyId: company.id,
    opportunity: await pickOpportunity(userId, company.id, hintText),
    via: "domain",
  };
}

/**
 * A company may be running you through two roles at once. Prefer the open one
 * with the most recent activity, and let a role title in the text override.
 */
export async function pickOpportunity(
  userId: string,
  companyId: string,
  hintText?: string | null,
): Promise<Opportunity | null> {
  const open = await prisma.opportunity.findMany({
    where: { userId, companyId, status: { in: ["ACTIVE", "ON_HOLD", "OFFER"] } },
    orderBy: { lastActivityAt: "desc" },
  });

  const pool = open.length > 0
    ? open
    : await prisma.opportunity.findMany({
        where: { userId, companyId },
        orderBy: { lastActivityAt: "desc" },
      });

  if (pool.length === 0) return null;
  if (pool.length === 1 || !hintText) return pool[0];

  const lower = hintText.toLowerCase();
  return pool.find((o) => lower.includes(o.roleTitle.toLowerCase())) ?? pool[0];
}
