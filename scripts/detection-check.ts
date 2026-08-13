/**
 * Application-detection check.
 *
 * Runs realistic confirmation emails from the major applicant-tracking systems
 * through the deterministic parsers, then drives one all the way to a tracked
 * process. No API key needed — the model fallback is exercised separately and
 * is skipped here.
 *
 * The negative cases matter as much as the positive ones: a job alert or a
 * rejection must never create a process.
 *
 * Run with: npx tsx scripts/detection-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  parseDeterministic,
  looksLikeConfirmation,
  detectApplication,
  createFromDetection,
  isRelayDomain,
} from "../src/server/sync/detect";

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Fixture = {
  name: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  body: string;
  expect: { company: string; role?: string | null; source: string };
};

const POSITIVE: Fixture[] = [
  {
    name: "LinkedIn Easy Apply",
    fromEmail: "jobs-noreply@linkedin.com",
    fromName: "LinkedIn",
    subject: "Your application was sent to Nimbus Data",
    body: `Your application was sent to Nimbus Data.

Senior Backend Engineer
Nimbus Data · Remote (EU)
Applied on 12 August

See more jobs that match your profile on LinkedIn.`,
    expect: { company: "Nimbus Data", source: "LinkedIn" },
  },
  {
    name: "Greenhouse",
    fromEmail: "no-reply@greenhouse.io",
    fromName: "Vela Health",
    subject: "Thanks for applying to Vela Health",
    body: `Hi Daniel,

Thanks for applying to the Staff Engineer, Platform role at Vela Health. We've received your application and the team will review it shortly.

— The Vela Health Recruiting Team`,
    expect: { company: "Vela Health", role: "Staff Engineer, Platform", source: "Greenhouse" },
  },
  {
    name: "Lever",
    fromEmail: "no-reply@hire.lever.co",
    subject: "Thank you for applying to Orbital",
    body: `Thank you for applying to Orbital.

We have received your application for Founding Backend Engineer and will be in touch.`,
    expect: { company: "Orbital", source: "Lever" },
  },
  {
    name: "Ashby",
    fromEmail: "no-reply@ashbyhq.com",
    subject: "Application received: Principal Engineer at Kestrel Bank",
    body: `Application received: Principal Engineer at Kestrel Bank

We'll review it and get back to you.`,
    expect: { company: "Kestrel Bank", role: "Principal Engineer", source: "Ashby" },
  },
  {
    name: "Workday",
    fromEmail: "donotreply@myworkday.com",
    subject: "Thank you for your application",
    body: `Dear Daniel,

Thank you for applying to the Senior Software Engineer position at Meridian Logistics. We have received your application.`,
    expect: { company: "Meridian Logistics", role: "Senior Software Engineer", source: "Workday" },
  },
  {
    name: "Company's own ATS, plain wording",
    fromEmail: "careers@brightloom.com",
    fromName: "Brightloom Careers",
    subject: "We received your application",
    body: `Hi Daniel,

Your application for Backend Engineer at Brightloom has been received. We review every application manually, so please allow a week.`,
    // Not a known ATS, so the source falls back to the sender's display name —
    // "Brightloom Careers" reads better than the bare domain.
    expect: { company: "Brightloom", role: "Backend Engineer", source: "Brightloom Careers" },
  },
  {
    name: "Portuguese confirmation",
    fromEmail: "recrutamento@lisboatech.pt",
    subject: "Recebemos a sua candidatura",
    body: `Olá Daniel,

Recebemos a sua candidatura para Lisboa Tech. Entraremos em contacto em breve.`,
    expect: { company: "Lisboa Tech", source: "lisboatech.pt" },
  },
];

const NEGATIVE: Array<{ name: string; fromEmail: string; subject: string; body: string }> = [
  {
    name: "LinkedIn job alert",
    fromEmail: "jobs-listings@linkedin.com",
    subject: "8 new jobs for you",
    body: "Jobs you may be interested in: Senior Backend Engineer at Acme, Staff Engineer at Globex.",
  },
  {
    name: "Rejection",
    fromEmail: "no-reply@greenhouse.io",
    subject: "Update on your application",
    body: "Thank you for applying to Acme. Unfortunately we have decided not to proceed with your application at this time.",
  },
  {
    name: "Newsletter",
    fromEmail: "news@techweekly.com",
    subject: "This week in backend engineering",
    body: "Postgres 17 is out, and here's what changed in the query planner.",
  },
  {
    name: "Interview invitation, not a receipt",
    fromEmail: "sara@nimbusdata.com",
    subject: "Booking your technical interview",
    body: "Hi Daniel, could you share some times next week for the technical round?",
  },
];

async function main() {
  console.log("\n1. Confirmations from each major ATS are parsed");
  for (const fixture of POSITIVE) {
    const result = parseDeterministic(fixture);
    const ok =
      result?.company === fixture.expect.company &&
      result?.source === fixture.expect.source &&
      (fixture.expect.role === undefined || result?.role === fixture.expect.role);
    check(
      fixture.name,
      ok,
      result
        ? `got company="${result.company}" role="${result.role}" source="${result.source}"`
        : "no match",
    );
  }

  console.log("\n2. Non-confirmations are rejected");
  for (const fixture of NEGATIVE) {
    const prefiltered = looksLikeConfirmation(fixture);
    const parsed = parseDeterministic(fixture);
    check(
      fixture.name,
      !prefiltered || !parsed,
      prefiltered && parsed ? `wrongly parsed as "${parsed.company}"` : "",
    );
  }

  console.log("\n3. Relay domains are never treated as the employer");
  check("linkedin.com is a relay", isRelayDomain("jobs-noreply@linkedin.com"));
  check("greenhouse.io is a relay", isRelayDomain("no-reply@greenhouse.io"));
  check("a company domain is not", !isRelayDomain("careers@brightloom.com"));

  console.log("\n4. A confirmation becomes a tracked process");
  const user = await prisma.user.findUnique({ where: { email: "you@example.com" } });
  if (!user) throw new Error("Seed data missing — run `npx tsx prisma/seed.ts` first");

  const stamp = Date.now();
  const companyName = `Detected Co ${stamp}`;
  const fixture: Fixture = {
    name: "synthetic",
    fromEmail: "no-reply@ashbyhq.com",
    subject: `Application received: Staff Engineer at ${companyName}`,
    body: `Application received: Staff Engineer at ${companyName}\n\nWe'll be in touch.`,
    expect: { company: companyName, role: "Staff Engineer", source: "Ashby" },
  };

  let createdId = "";
  try {
    const detected = await detectApplication(fixture);
    check("detected end to end", detected?.company === companyName, JSON.stringify(detected));
    if (!detected) throw new Error("detection failed");

    const opportunity = await createFromDetection({
      userId: user.id,
      detected,
      gmailId: `gmail-${stamp}`,
      receivedAt: new Date(),
      senderEmail: fixture.fromEmail,
    });
    check("a process was created", Boolean(opportunity));
    if (!opportunity) throw new Error("creation failed");
    createdId = opportunity.id;

    const full = await prisma.opportunity.findUnique({
      where: { id: opportunity.id },
      include: { company: true, currentStage: true, stages: true },
    });

    check("company recorded", full?.company.name === companyName);
    check("role recorded", full?.roleTitle === "Staff Engineer", full?.roleTitle);
    check("flagged as auto-detected", full?.autoDetected === true);
    check("source recorded", full?.detectedFrom === "Ashby", full?.detectedFrom ?? "");
    check("confirmation email is traceable", full?.detectionEmailId === `gmail-${stamp}`);
    check(
      "starts on the Applied stage, not Researching",
      full?.currentStage?.type === "APPLIED",
      full?.currentStage?.name ?? "none",
    );
    check("full flow instantiated", (full?.stages.length ?? 0) === 9, `${full?.stages.length}`);

    check(
      "the relay domain was NOT written onto the company",
      (full?.company.domains.length ?? 0) === 0,
      full?.company.domains.join(","),
    );

    const activity = await prisma.activity.findFirst({
      where: { opportunityId: opportunity.id, type: "SYNC" },
    });
    check(
      "timeline explains where it came from",
      Boolean(activity?.title.includes("Ashby")),
      activity?.title ?? "",
    );

    console.log("\n5. A repeat confirmation does not create a duplicate");
    const again = await createFromDetection({
      userId: user.id,
      detected,
      gmailId: `gmail-${stamp}-again`,
      receivedAt: new Date(),
      senderEmail: fixture.fromEmail,
    });
    check("second attempt returns null", again === null);
    const count = await prisma.opportunity.count({
      where: { userId: user.id, company: { name: companyName } },
    });
    check("still exactly one process", count === 1, `got ${count}`);
  } finally {
    if (createdId) await prisma.opportunity.deleteMany({ where: { id: createdId } });
    await prisma.company.deleteMany({ where: { userId: user.id, name: companyName } });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
