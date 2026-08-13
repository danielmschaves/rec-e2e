import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import { createOpportunity, moveToStage } from "@/server/opportunities";
import { assistantConfigured, anthropic, ASSISTANT_MODEL } from "@/server/ai/client";
import type { Opportunity } from "@prisma/client";

/**
 * Application-confirmation detection.
 *
 * When you apply somewhere, something always emails you back — LinkedIn, or the
 * company's ATS. This turns that receipt into a tracked process automatically,
 * so applying is the only thing you do by hand.
 *
 * Two tiers, cheapest first:
 *   1. Deterministic parsers for the big ATS senders. Their formats are stable,
 *      so this costs nothing and is exact.
 *   2. The model, with a structured output, for the long tail — but only after
 *      a cheap prefilter says the mail actually looks like a confirmation, so
 *      we never spend a call on ordinary inbox traffic.
 */

export type DetectedApplication = {
  company: string;
  role: string | null;
  /** Which system told us: "LinkedIn", "Greenhouse", … */
  source: string;
  confidence: "high" | "medium" | "low";
};

export type DetectionInput = {
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  body?: string | null;
};

/**
 * Senders that relay applications on a company's behalf. Their domain is never
 * the employer's domain — that distinction matters, because writing
 * "linkedin.com" onto a Company record would match every future LinkedIn mail
 * to that one employer.
 */
const RELAY_DOMAINS = [
  "linkedin.com",
  "greenhouse.io",
  "greenhouse-mail.io",
  "hire.lever.co",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "workable.com",
  "workablemail.com",
  "teamtailor.com",
  "teamtailormail.com",
  "personio.de",
  "recruitee.com",
  "bamboohr.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "breezy.hr",
  "rippling.com",
  "indeed.com",
  "glassdoor.com",
  "otta.com",
  "welcometothejungle.com",
];

/** Maps a sender domain to the human name of the system. */
const SOURCE_NAMES: Array<[RegExp, string]> = [
  [/linkedin\.com$/i, "LinkedIn"],
  [/greenhouse(-mail)?\.io$/i, "Greenhouse"],
  [/lever\.co$/i, "Lever"],
  [/ashbyhq\.com$/i, "Ashby"],
  [/myworkday(jobs)?\.com$/i, "Workday"],
  [/smartrecruiters\.com$/i, "SmartRecruiters"],
  [/workable(mail)?\.com$/i, "Workable"],
  [/teamtailor(mail)?\.com$/i, "Teamtailor"],
  [/personio\.de$/i, "Personio"],
  [/recruitee\.com$/i, "Recruitee"],
  [/bamboohr\.com$/i, "BambooHR"],
  [/icims\.com$/i, "iCIMS"],
  [/taleo\.net$/i, "Taleo"],
  [/jobvite\.com$/i, "Jobvite"],
  [/breezy\.hr$/i, "Breezy"],
  [/indeed\.com$/i, "Indeed"],
  [/glassdoor\.com$/i, "Glassdoor"],
  [/otta\.com$/i, "Otta"],
  [/welcometothejungle\.com$/i, "Welcome to the Jungle"],
];

export function domainOf(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

export function isRelayDomain(email: string): boolean {
  const domain = domainOf(email);
  return RELAY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function sourceNameFor(email: string, fromName?: string | null): string {
  const domain = domainOf(email);
  for (const [pattern, name] of SOURCE_NAMES) {
    if (pattern.test(domain)) return name;
  }
  return fromName?.trim() || domain || "Email";
}

/**
 * Cheap prefilter: does this mail plausibly confirm an application?
 *
 * Deliberately generous — a false positive here only costs a parse attempt,
 * whereas a false negative loses the application entirely.
 */
const CONFIRMATION_MARKERS = [
  "your application",
  "application received",
  "received your application",
  "we have received your application",
  "we've received your application",
  "thanks for applying",
  "thank you for applying",
  "thank you for your application",
  "thanks for your application",
  "application confirmation",
  "application submitted",
  "successfully applied",
  "was sent to",
  "applied to",
  // Portuguese / Spanish — common for a Lisbon-based search.
  "recebemos a sua candidatura",
  "recebemos sua candidatura",
  "obrigado por se candidatar",
  "hemos recibido tu solicitud",
  "gracias por postularte",
];

/** Phrases that mean this is a *rejection* or a job alert, not a receipt. */
const NEGATIVE_MARKERS = [
  "not moving forward",
  "decided not to proceed",
  "will not be progressing",
  "unsuccessful on this occasion",
  "jobs you may be interested in",
  "new jobs for you",
  "job alert",
  "recommended for you",
  "top job picks",
];

export function looksLikeConfirmation(input: DetectionInput): boolean {
  const haystack = `${input.subject ?? ""}\n${(input.body ?? "").slice(0, 3000)}`.toLowerCase();
  if (NEGATIVE_MARKERS.some((m) => haystack.includes(m))) return false;
  return CONFIRMATION_MARKERS.some((m) => haystack.includes(m));
}

// ---------------------------------------------------------------------------
// Tier 1 — deterministic parsers
// ---------------------------------------------------------------------------

/** Strips trailing punctuation, legal suffixes and stray whitespace. */
function cleanCompany(raw: string): string {
  return raw
    // A greedy capture can run past the name into the sentence tail
    // ("Brightloom has been received"). Cut at the first auxiliary verb.
    .replace(/\s+\b(?:has|have|had|is|are|was|were|will|would|been|and we|so that)\b.*$/i, "")
    .replace(/[.!,;:]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\b(inc|llc|ltd|limited|gmbh|b\.?v\.?|s\.?a\.?)\.?$/i, "")
    .trim();
}

function cleanRole(raw: string): string {
  return raw
    .replace(/[.!,;:]+$/, "")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+(role|position|opening|job|vacancy)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ordered patterns run against "subject\nbody". Each must capture a company,
 * and may capture a role. Ordering matters — the most specific formats first.
 */
const PATTERNS: Array<{
  re: RegExp;
  company: number;
  role?: number;
  confidence: "high" | "medium";
}> = [
  // LinkedIn: "Your application was sent to Acme Corp"
  { re: /your application was sent to\s+([^\n.!]{2,80})/i, company: 1, confidence: "high" },
  // Ashby: "Application received: Senior Engineer at Acme"
  {
    re: /application received:?\s+([^\n]{2,80}?)\s+at\s+([^\n.!]{2,80})/i,
    role: 1,
    company: 2,
    confidence: "high",
  },
  // Greenhouse / Lever: "Thanks for applying to the Senior Engineer role at Acme"
  {
    re: /(?:thanks|thank you) for applying to\s+(?:the\s+)?([^\n]{2,80}?)\s+(?:role|position)\s+at\s+([^\n.!]{2,80})/i,
    role: 1,
    company: 2,
    confidence: "high",
  },
  // "your application for Senior Engineer at Acme"
  {
    re: /your application (?:for|to)\s+(?:the\s+)?([^\n]{2,80}?)\s+at\s+([^\n.!]{2,80})/i,
    role: 1,
    company: 2,
    confidence: "high",
  },
  // "applied to Senior Engineer at Acme"
  {
    re: /applied (?:to|for)\s+(?:the\s+)?([^\n]{2,80}?)\s+at\s+([^\n.!]{2,80})/i,
    role: 1,
    company: 2,
    confidence: "medium",
  },
  // "we received your application for the Senior Engineer position"
  // (company comes from the sender in this shape, so it is handled separately)
  // "Thank you for applying to Acme"
  {
    re: /(?:thanks|thank you) for applying to\s+([^\n.!]{2,80})/i,
    company: 1,
    confidence: "medium",
  },
  // "Your application to Acme"
  { re: /your application to\s+([^\n.!]{2,80})/i, company: 1, confidence: "medium" },
  // Portuguese
  {
    re: /recebemos (?:a )?sua candidatura (?:para|a)\s+([^\n.!]{2,80})/i,
    company: 1,
    confidence: "medium",
  },
];

/** Words that mean we captured a sentence fragment, not a company name. */
const NOT_A_COMPANY =
  /^(us|our team|the team|this role|the role|your|you|we|it|them|a|an|the)$/i;

export function parseDeterministic(input: DetectionInput): DetectedApplication | null {
  const subject = input.subject ?? "";
  const body = (input.body ?? "").slice(0, 4000);
  const haystack = `${subject}\n${body}`;

  for (const pattern of PATTERNS) {
    const match = haystack.match(pattern.re);
    if (!match) continue;

    const company = cleanCompany(match[pattern.company] ?? "");
    if (!company || company.length < 2 || NOT_A_COMPANY.test(company)) continue;
    // A captured "company" containing a newline or an obvious sentence tail is
    // a bad grab; skip rather than create a junk record.
    if (/\b(?:if|please|we|you|your)\b/i.test(company)) continue;

    const role = pattern.role ? cleanRole(match[pattern.role] ?? "") : null;

    return {
      company,
      role: role && role.length >= 2 ? role : null,
      source: sourceNameFor(input.fromEmail, input.fromName),
      confidence: pattern.confidence,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 — the model, for anything the parsers miss
// ---------------------------------------------------------------------------

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    isApplicationConfirmation: {
      type: "boolean" as const,
      description:
        "True only if this email confirms that the recipient's job application was received. False for job alerts, newsletters, rejections, interview invitations, or anything else.",
    },
    company: {
      type: ["string", "null"] as unknown as "string",
      description:
        "The employer's name — not the ATS or job board that sent the mail. Null if not stated.",
    },
    role: {
      type: ["string", "null"] as unknown as "string",
      description: "The job title applied for, without seniority boilerplate. Null if not stated.",
    },
  },
  required: ["isApplicationConfirmation", "company", "role"],
  additionalProperties: false,
};

export async function extractWithModel(
  input: DetectionInput,
): Promise<DetectedApplication | null> {
  if (!assistantConfigured()) return null;

  try {
    const response = await anthropic().messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: 1024,
      // A short extraction — no need to spend reasoning tokens here.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
      system:
        "You extract structured data from a job seeker's email. Answer only from what the email states. The employer is never the applicant-tracking system or job board that relayed the mail.",
      messages: [
        {
          role: "user",
          content: `From: ${input.fromName ?? ""} <${input.fromEmail}>
Subject: ${input.subject ?? "(none)"}

${(input.body ?? "").slice(0, 4000)}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;

    const text = response.content
      .filter((b): b is { type: "text"; text: string; citations: null } =>
        b.type === "text",
      )
      .map((b) => b.text)
      .join("");
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      isApplicationConfirmation: boolean;
      company: string | null;
      role: string | null;
    };

    if (!parsed.isApplicationConfirmation) return null;
    const company = parsed.company ? cleanCompany(parsed.company) : "";
    if (!company || company.length < 2) return null;

    return {
      company,
      role: parsed.role ? cleanRole(parsed.role) : null,
      source: sourceNameFor(input.fromEmail, input.fromName),
      // The model is the fallback path, so its guesses stay reviewable.
      confidence: "low",
    };
  } catch (err) {
    console.error("[detect] model extraction failed:", err);
    return null;
  }
}

/** Runs both tiers. Deterministic first; the model only if that found nothing. */
export async function detectApplication(
  input: DetectionInput,
): Promise<DetectedApplication | null> {
  if (!looksLikeConfirmation(input)) return null;
  return parseDeterministic(input) ?? (await extractWithModel(input));
}

// ---------------------------------------------------------------------------
// Turning a detection into a tracked process
// ---------------------------------------------------------------------------

/** Finds an existing company by loose name match before creating a new one. */
async function resolveCompany(
  userId: string,
  name: string,
  senderEmail: string,
): Promise<string> {
  const existing = await prisma.company.findFirst({
    where: { userId, name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing.id;

  // Only adopt the sender's domain when it is the employer's own — an ATS relay
  // domain would wrongly claim every future mail from that system.
  const domains = isRelayDomain(senderEmail) ? [] : [domainOf(senderEmail)].filter(Boolean);

  const company = await prisma.company.create({
    data: { userId, name, domains },
  });
  return company.id;
}

/** The flow an auto-detected application starts on. */
async function defaultTemplateId(userId: string): Promise<string | null> {
  const template =
    (await prisma.processTemplate.findFirst({
      where: { userId, archived: false, isDefault: true },
    })) ??
    (await prisma.processTemplate.findFirst({
      where: { userId, archived: false },
      orderBy: { createdAt: "asc" },
    }));
  return template?.id ?? null;
}

/**
 * Creates a tracked process from a detected confirmation.
 *
 * Returns null when we already track it, so a re-sync or a duplicate
 * confirmation never produces a second row.
 */
export async function createFromDetection(params: {
  userId: string;
  detected: DetectedApplication;
  gmailId: string;
  receivedAt: Date;
  senderEmail: string;
}): Promise<Opportunity | null> {
  const { userId, detected } = params;

  const templateId = await defaultTemplateId(userId);
  if (!templateId) {
    console.error("[detect] no process template — cannot auto-create");
    return null;
  }

  const companyId = await resolveCompany(userId, detected.company, params.senderEmail);
  const roleTitle = detected.role ?? "Role not stated";

  const existing = await prisma.opportunity.findUnique({
    where: { userId_companyId_roleTitle: { userId, companyId, roleTitle } },
  });
  if (existing) return null;

  // When the role was not stated, don't create a second "Role not stated" row
  // for a company we already track — attach to what's there instead.
  if (!detected.role) {
    const anyOpen = await prisma.opportunity.findFirst({
      where: { userId, companyId, status: { in: ["ACTIVE", "ON_HOLD", "OFFER"] } },
    });
    if (anyOpen) return null;
  }

  const opportunity = await createOpportunity({
    userId,
    companyId,
    templateId,
    roleTitle,
    actor: { type: "SYNC" },
    details: { source: detected.source },
  });

  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: {
      autoDetected: true,
      detectedFrom: detected.source,
      detectionEmailId: params.gmailId,
      appliedAt: params.receivedAt,
      nextAction: detected.role
        ? null
        : "Check the role title — we couldn't read it from the confirmation",
    },
  });

  // The confirmation means you have applied, so start there rather than at the
  // research stage the template opens on.
  await moveToStage({
    opportunityId: opportunity.id,
    target: { stageType: "APPLIED" },
    actor: { type: "SYNC" },
    reason: `Application confirmed by ${detected.source}`,
  });

  await logActivity({
    userId,
    opportunityId: opportunity.id,
    type: "SYNC",
    title: `Picked up your application to ${detected.company} from ${detected.source}`,
    body: detected.role
      ? `Role read as "${detected.role}". Confirm or correct it on the process.`
      : "The confirmation didn't name the role — add it when you can.",
    actorType: "SYNC",
    externalId: params.gmailId,
    occurredAt: params.receivedAt,
    meta: { confidence: detected.confidence, source: detected.source },
  });

  return prisma.opportunity.findUnique({ where: { id: opportunity.id } });
}
