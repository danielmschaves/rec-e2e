/**
 * Idempotent demo seed — a job search in progress.
 *
 * Safe to run on every boot: everything is keyed on a natural unique field and
 * upserted, so re-running never duplicates or clobbers live edits.
 */
import { PrismaClient, type StageType } from "@prisma/client";
import {
  createOpportunity,
  moveToStage,
  addCustomStage,
  skipStage,
  setNextAction,
} from "../src/server/opportunities";

const prisma = new PrismaClient();

const DEMO_EMAIL = "you@example.com";

type StageSpec = { name: string; key: string; type: StageType; chaseAfterDays?: number };

const STANDARD_FLOW: StageSpec[] = [
  { name: "Researching", key: "researching", type: "RESEARCHING", chaseAfterDays: 7 },
  { name: "Applied", key: "applied", type: "APPLIED", chaseAfterDays: 10 },
  { name: "Recruiter Screen", key: "recruiter_screen", type: "RECRUITER_SCREEN", chaseAfterDays: 5 },
  { name: "Take-home", key: "take_home", type: "TAKE_HOME", chaseAfterDays: 7 },
  { name: "Technical Interview", key: "tech_interview", type: "TECHNICAL_INTERVIEW", chaseAfterDays: 7 },
  { name: "System Design", key: "system_design", type: "SYSTEM_DESIGN", chaseAfterDays: 7 },
  { name: "Final / Values", key: "final_interview", type: "BEHAVIOURAL_INTERVIEW", chaseAfterDays: 5 },
  { name: "Offer", key: "offer", type: "OFFER", chaseAfterDays: 5 },
  { name: "Accepted", key: "accepted", type: "ACCEPTED" },
];

const STARTUP_FLOW: StageSpec[] = [
  { name: "Intro Call", key: "intro_call", type: "RECRUITER_SCREEN", chaseAfterDays: 5 },
  { name: "Founder Chat", key: "founder_chat", type: "BEHAVIOURAL_INTERVIEW", chaseAfterDays: 5 },
  { name: "Paid Trial / Work Sample", key: "work_sample", type: "TAKE_HOME", chaseAfterDays: 7 },
  { name: "Team Interview", key: "team_interview", type: "ONSITE", chaseAfterDays: 5 },
  { name: "Offer", key: "offer", type: "OFFER", chaseAfterDays: 3 },
  { name: "Accepted", key: "accepted", type: "ACCEPTED" },
];

const AGENCY_FLOW: StageSpec[] = [
  { name: "Recruiter Intro", key: "recruiter_intro", type: "RECRUITER_SCREEN", chaseAfterDays: 4 },
  { name: "CV Submitted to Client", key: "cv_submitted", type: "APPLIED", chaseAfterDays: 7 },
  { name: "Client Interview", key: "client_interview", type: "TECHNICAL_INTERVIEW", chaseAfterDays: 7 },
  { name: "Offer", key: "offer", type: "OFFER", chaseAfterDays: 3 },
  { name: "Accepted", key: "accepted", type: "ACCEPTED" },
];

async function upsertTemplate(
  userId: string,
  name: string,
  description: string,
  stages: StageSpec[],
  isDefault = false,
) {
  const template = await prisma.processTemplate.upsert({
    where: { userId_name: { userId, name } },
    create: { userId, name, description, isDefault },
    update: { description },
  });

  for (const [index, stage] of stages.entries()) {
    await prisma.templateStage.upsert({
      where: { templateId_key: { templateId: template.id, key: stage.key } },
      create: {
        templateId: template.id,
        name: stage.name,
        key: stage.key,
        type: stage.type,
        position: index,
        chaseAfterDays: stage.chaseAfterDays ?? null,
      },
      update: { name: stage.name, position: index, type: stage.type },
    });
  }

  return template;
}

async function main() {
  console.log("[seed] starting…");

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      email: DEMO_EMAIL,
      name: "Daniel Schaves",
      headline: "Senior backend engineer · Go, Python, Postgres",
      profile:
        "Senior backend engineer with 9 years' experience, mostly Go and Python on data-heavy systems. Looking for a senior or staff role, remote-first or hybrid in Lisbon. Targeting €85–110k. I care most about working on hard data problems with people who write tests. Not interested in pure management yet.",
      timezone: "Europe/Lisbon",
    },
    update: {},
  });

  // --- templates ------------------------------------------------------------
  const standard = await upsertTemplate(
    user.id,
    "Standard engineering loop",
    "The nine-step process most mid-size companies run.",
    STANDARD_FLOW,
    true,
  );
  const startup = await upsertTemplate(
    user.id,
    "Startup / founder-led",
    "Compressed flow for early-stage companies.",
    STARTUP_FLOW,
  );
  await upsertTemplate(
    user.id,
    "Via agency recruiter",
    "When an external recruiter is running the process.",
    AGENCY_FLOW,
  );

  // --- companies ------------------------------------------------------------
  const companySpecs = [
    { name: "Nimbus Data", domains: ["nimbusdata.com"], website: "https://nimbusdata.com", notes: "Series B, data infrastructure. Strong engineering blog." },
    { name: "Vela Health", domains: ["velahealth.io"], website: "https://velahealth.io", notes: "Health-tech scale-up, Lisbon office." },
    { name: "Orbital", domains: ["orbital.dev"], website: "https://orbital.dev", notes: "Seed stage, 12 people, founder-led process." },
    { name: "Kestrel Bank", domains: ["kestrelbank.com"], website: "https://kestrelbank.com", notes: "Slow process, big comp." },
    { name: "Northwind Analytics", domains: ["northwind-analytics.com"], website: null, notes: "Found via agency recruiter." },
  ];

  const companies: Record<string, string> = {};
  for (const spec of companySpecs) {
    const company = await prisma.company.upsert({
      where: { userId_name: { userId: user.id, name: spec.name } },
      create: { ...spec, userId: user.id },
      update: { domains: spec.domains },
    });
    companies[spec.name] = company.id;
  }

  // --- contacts -------------------------------------------------------------
  const contactSpecs = [
    { name: "Sara Lindqvist", email: "sara.lindqvist@nimbusdata.com", company: "Nimbus Data", role: "RECRUITER" as const, title: "Technical Recruiter" },
    { name: "Tom Beckett", email: "tom@nimbusdata.com", company: "Nimbus Data", role: "HIRING_MANAGER" as const, title: "Director of Engineering" },
    { name: "Inês Carvalho", email: "ines.carvalho@velahealth.io", company: "Vela Health", role: "RECRUITER" as const, title: "Talent Partner" },
    { name: "Maya Osei", email: "maya@orbital.dev", company: "Orbital", role: "HIRING_MANAGER" as const, title: "Co-founder & CTO" },
    { name: "Peter Novak", email: "p.novak@kestrelbank.com", company: "Kestrel Bank", role: "RECRUITER" as const, title: "Talent Acquisition" },
  ];

  for (const spec of contactSpecs) {
    await prisma.contact.upsert({
      where: { userId_email: { userId: user.id, email: spec.email } },
      create: {
        userId: user.id,
        companyId: companies[spec.company],
        name: spec.name,
        email: spec.email,
        role: spec.role,
        title: spec.title,
      },
      update: {},
    });
  }

  // --- opportunities --------------------------------------------------------
  const plan: Array<{
    company: string;
    role: string;
    templateId: string;
    advanceTo?: string;
    personalize?: "add" | "skip";
    priority?: "DREAM" | "HIGH" | "MEDIUM" | "LOW";
    nextAction?: string;
    details?: Record<string, unknown>;
  }> = [
    {
      company: "Nimbus Data",
      role: "Senior Backend Engineer",
      templateId: standard.id,
      advanceTo: "take_home",
      priority: "DREAM",
      nextAction: "Finish the take-home and submit",
      details: { location: "Remote (EU)", workMode: "REMOTE", salaryMin: 90000, salaryMax: 115000, source: "Careers page", excitement: 5 },
    },
    {
      company: "Vela Health",
      role: "Staff Engineer, Platform",
      templateId: standard.id,
      advanceTo: "tech_interview",
      personalize: "skip",
      priority: "HIGH",
      nextAction: "Send availability for the technical round",
      details: { location: "Lisbon", workMode: "HYBRID", salaryMin: 85000, salaryMax: 105000, source: "Referral", excitement: 4 },
    },
    {
      company: "Orbital",
      role: "Founding Backend Engineer",
      templateId: startup.id,
      advanceTo: "founder_chat",
      personalize: "add",
      priority: "MEDIUM",
      details: { location: "Remote (Global)", workMode: "REMOTE", salaryMin: 75000, salaryMax: 95000, source: "LinkedIn", excitement: 3 },
    },
    {
      company: "Kestrel Bank",
      role: "Senior Software Engineer",
      templateId: standard.id,
      advanceTo: "recruiter_screen",
      priority: "LOW",
      details: { location: "Lisbon", workMode: "ONSITE", salaryMin: 95000, salaryMax: 120000, source: "Cold application", excitement: 2 },
    },
    {
      company: "Northwind Analytics",
      role: "Backend Engineer",
      templateId: standard.id,
      advanceTo: "applied",
      priority: "LOW",
      details: { location: "Remote (EU)", workMode: "REMOTE", source: "Agency recruiter", excitement: 2 },
    },
  ];

  const created: Record<string, string> = {};
  for (const item of plan) {
    const existing = await prisma.opportunity.findUnique({
      where: {
        userId_companyId_roleTitle: {
          userId: user.id,
          companyId: companies[item.company],
          roleTitle: item.role,
        },
      },
    });
    if (existing) {
      created[item.company] = existing.id;
      continue;
    }

    const opportunity = await createOpportunity({
      userId: user.id,
      companyId: companies[item.company],
      templateId: item.templateId,
      roleTitle: item.role,
      actor: { type: "USER" },
      details: {
        priority: item.priority ?? "MEDIUM",
        ...(item.details as object),
      },
    });
    created[item.company] = opportunity.id;

    if (item.personalize === "add") {
      await addCustomStage({
        opportunityId: opportunity.id,
        name: "Pairing session with the team",
        type: "TECHNICAL_INTERVIEW",
        chaseAfterDays: 4,
        actor: { type: "USER" },
      });
    }
    if (item.personalize === "skip") {
      const skippable = await prisma.opportunityStage.findFirst({
        where: { opportunityId: opportunity.id, key: "take_home" },
      });
      if (skippable) {
        await skipStage({
          opportunityId: opportunity.id,
          stageId: skippable.id,
          actor: { type: "USER" },
          reason: "They waived it — the referral covered it.",
        });
      }
    }

    if (item.advanceTo) {
      await moveToStage({
        opportunityId: opportunity.id,
        target: { stageKey: item.advanceTo },
        actor: { type: "USER" },
        reason: "Seeded progress",
      });
    }

    if (item.nextAction) {
      await setNextAction({
        opportunityId: opportunity.id,
        action: item.nextAction,
        actor: { type: "USER" },
      });
    }
  }

  // --- one process the inbox scanner picked up on its own -------------------
  // Shows the "we found this, is it right?" path without needing a live inbox.
  const detectedName = "Halcyon Systems";
  const detectedCompany = await prisma.company.upsert({
    where: { userId_name: { userId: user.id, name: detectedName } },
    // No domain: the confirmation came via LinkedIn, and linkedin.com is a
    // relay — writing it here would match every future LinkedIn mail to them.
    create: { userId: user.id, name: detectedName, domains: [] },
    update: {},
  });

  const alreadyDetected = await prisma.opportunity.findUnique({
    where: {
      userId_companyId_roleTitle: {
        userId: user.id,
        companyId: detectedCompany.id,
        roleTitle: "Senior Platform Engineer",
      },
    },
  });

  if (!alreadyDetected) {
    const opportunity = await createOpportunity({
      userId: user.id,
      companyId: detectedCompany.id,
      templateId: standard.id,
      roleTitle: "Senior Platform Engineer",
      actor: { type: "SYNC" },
      details: { source: "LinkedIn", priority: "MEDIUM" },
    });

    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: {
        autoDetected: true,
        detectedFrom: "LinkedIn",
        detectionEmailId: "seed-linkedin-confirmation",
      },
    });

    await moveToStage({
      opportunityId: opportunity.id,
      target: { stageKey: "applied" },
      actor: { type: "SYNC" },
      reason: "Application confirmed by LinkedIn",
    });
  }

  // --- a technical challenge in flight --------------------------------------
  const nimbus = created["Nimbus Data"];
  if (nimbus) {
    const existing = await prisma.challenge.findFirst({
      where: { opportunityId: nimbus, title: "Event ingestion service" },
    });
    if (!existing) {
      const stage = await prisma.opportunityStage.findFirst({
        where: { opportunityId: nimbus, key: "take_home" },
      });
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 4);

      const challenge = await prisma.challenge.create({
        data: {
          userId: user.id,
          opportunityId: nimbus,
          stageId: stage?.id ?? null,
          title: "Event ingestion service",
          briefSource: "Emailed by Sara, 2 days ago",
          status: "IN_PROGRESS",
          deadline,
          estimatedHours: 6,
          brief: `Build a small service that ingests a stream of JSON events over HTTP and makes them queryable.

Requirements:
- Accept POST /events with a JSON body. Events have an id, a type, a timestamp and an arbitrary payload object.
- Events may arrive out of order and may be delivered more than once. Duplicates must not be counted twice.
- Expose GET /events/stats returning, per event type, the count and the timestamp of the most recent event.
- Persist to a real datastore — in-memory is not sufficient.
- The service should handle a sustained 500 events/second on a laptop.
- Include tests. We care more about what you chose to test than about coverage.
- A short README explaining your design decisions and what you would do with more time.

Optional, if you have time: a /events/replay endpoint, and basic auth on the write path.

Please spend no more than 4–6 hours. Send us a link to a repository when you're done.`,
          plan: `1. Sketch the schema first — an events table with a unique constraint on (id) is what makes redelivery safe. Do this before any HTTP code.
2. POST /events → validate, INSERT ... ON CONFLICT DO NOTHING. That single line is the dedupe story; call it out in the README.
3. GET /events/stats → a grouped query. Add an index on (type, timestamp desc) and show the EXPLAIN in the README.
4. Tests: out-of-order delivery, duplicate delivery, and the stats aggregation. These are the three things the brief actually cares about.
5. Load check: a short script hitting 500/s, with the number you actually measured in the README.
6. README last, but budget 45 minutes for it — it is graded.

Cut line if time runs short: skip /events/replay and auth, and say so explicitly in the README under "what I'd do next". Shipping the core clean beats half-finishing the extras.`,
        },
      });

      const requirements = [
        { text: "POST /events accepts id, type, timestamp, payload", mustHave: true },
        { text: "Duplicate deliveries are not double-counted", mustHave: true },
        { text: "Out-of-order arrival handled correctly", mustHave: true },
        { text: "GET /events/stats returns count + latest timestamp per type", mustHave: true },
        { text: "Persists to a real datastore, not in-memory", mustHave: true },
        { text: "Sustains 500 events/second locally", mustHave: true },
        { text: "Tests covering the behaviours that matter", mustHave: true },
        { text: "README explaining design decisions and next steps", mustHave: true },
        { text: "/events/replay endpoint", mustHave: false },
        { text: "Basic auth on the write path", mustHave: false },
      ];

      await prisma.challengeRequirement.createMany({
        data: requirements.map((r, index) => ({
          challengeId: challenge.id,
          text: r.text,
          mustHave: r.mustHave,
          position: index,
          done: index < 4,
        })),
      });
    }
  }

  // --- automation rules -----------------------------------------------------
  const rules = [
    {
      name: "They replied → mark the screen done",
      description:
        "An inbound reply while waiting on a screening stage means the ball moved; complete the stage.",
      trigger: "EMAIL_RECEIVED_FROM_COMPANY" as const,
      action: "COMPLETE_CURRENT_STAGE" as const,
      priority: 30,
      conditions: { currentStageType: ["APPLIED", "RECRUITER_SCREEN"] },
      config: {},
    },
    {
      name: "Rejection email → close the process",
      description:
        "Mail that reads like a rejection closes the process so it stops showing as live.",
      trigger: "EMAIL_RECEIVED_FROM_COMPANY" as const,
      action: "SET_OPPORTUNITY_STATUS" as const,
      priority: 10,
      conditions: {
        bodyContains: [
          "not moving forward",
          "decided not to proceed",
          "unfortunately",
          "other candidates",
          "will not be progressing",
        ],
      },
      config: { status: "REJECTED" },
    },
    {
      name: "Offer email → mark as offer",
      description: "Mail mentioning an offer flips the process to OFFER so it rises to the top.",
      trigger: "EMAIL_RECEIVED_FROM_COMPANY" as const,
      action: "SET_OPPORTUNITY_STATUS" as const,
      priority: 5,
      conditions: { bodyContains: ["pleased to offer", "offer letter", "we'd like to offer"] },
      config: { status: "OFFER" },
    },
    {
      name: "Interview booked → move to that stage",
      description: "A calendar invite naming a technical interview moves you to that stage.",
      trigger: "CALENDAR_EVENT_SCHEDULED" as const,
      action: "SET_STAGE" as const,
      priority: 10,
      conditions: { titleContains: ["technical", "tech screen", "coding"] },
      config: { stageKey: "tech_interview" },
    },
    {
      name: "Any interview booked → note it",
      description: "Fallback for invites that don't say which round they are.",
      trigger: "CALENDAR_EVENT_SCHEDULED" as const,
      action: "SET_NEXT_ACTION" as const,
      priority: 50,
      conditions: { titleContains: ["interview", "call", "chat", "entrevista"] },
      config: { nextAction: "Prepare for the scheduled interview" },
    },
    {
      name: "Interview finished → advance",
      description: "Once the meeting has ended, move to the next step in the process.",
      trigger: "CALENDAR_EVENT_COMPLETED" as const,
      action: "ADVANCE_STAGE" as const,
      priority: 10,
      conditions: {},
      config: {},
    },
    {
      name: "Interview cancelled → flag",
      description: "Cancellations need a human read, so raise a flag rather than moving.",
      trigger: "CALENDAR_EVENT_CANCELLED" as const,
      action: "FLAG_FOR_REVIEW" as const,
      priority: 10,
      conditions: {},
      config: { message: "An interview was cancelled — chase them for a new slot." },
    },
    {
      name: "Gone quiet → suggest a nudge",
      description: "Anything past its chase window gets a next action so it doesn't rot.",
      trigger: "STAGE_WENT_QUIET" as const,
      action: "SET_NEXT_ACTION" as const,
      priority: 10,
      conditions: {},
      config: { nextAction: "Send a follow-up — this has gone quiet" },
    },
  ];

  for (const rule of rules) {
    await prisma.automationRule.upsert({
      where: { userId_name: { userId: user.id, name: rule.name } },
      create: { ...rule, userId: user.id },
      update: { description: rule.description },
    });
  }

  const counts = {
    templates: await prisma.processTemplate.count({ where: { userId: user.id } }),
    companies: await prisma.company.count({ where: { userId: user.id } }),
    contacts: await prisma.contact.count({ where: { userId: user.id } }),
    opportunities: await prisma.opportunity.count({ where: { userId: user.id } }),
    challenges: await prisma.challenge.count({ where: { userId: user.id } }),
    rules: await prisma.automationRule.count({ where: { userId: user.id } }),
  };

  console.log("[seed] done:", counts);
  console.log(`[seed] sign in as ${user.email} (dev login)`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
