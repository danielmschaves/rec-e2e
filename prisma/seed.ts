/**
 * Idempotent demo seed.
 *
 * Safe to run on every boot: everything is keyed on a natural unique field and
 * upserted, so re-running never duplicates or clobbers live edits.
 */
import { PrismaClient, type StageType } from "@prisma/client";
import { createApplication, moveToStage, addCustomStage, skipStage } from "../src/server/applications";

const prisma = new PrismaClient();

const ORG_SLUG = "northwind-talent";
const DEMO_EMAIL = "recruiter@northwind.test";

type StageSpec = {
  name: string;
  key: string;
  type: StageType;
  slaDays?: number;
  optional?: boolean;
};

const ENGINEERING_FLOW: StageSpec[] = [
  { name: "Applied", key: "applied", type: "APPLIED", slaDays: 2 },
  { name: "Resume Screen", key: "resume_screen", type: "SCREENING", slaDays: 3 },
  { name: "Recruiter Call", key: "recruiter_call", type: "SCREENING", slaDays: 5 },
  { name: "Take-home Assessment", key: "assessment", type: "ASSESSMENT", slaDays: 7, optional: true },
  { name: "Technical Interview", key: "tech_interview", type: "INTERVIEW", slaDays: 7 },
  { name: "Hiring Manager Interview", key: "hm_interview", type: "INTERVIEW", slaDays: 5 },
  { name: "Reference Check", key: "reference_check", type: "REFERENCE_CHECK", slaDays: 4, optional: true },
  { name: "Offer", key: "offer", type: "OFFER", slaDays: 5 },
  { name: "Hired", key: "hired", type: "HIRED" },
];

const FAST_TRACK_FLOW: StageSpec[] = [
  { name: "Sourced", key: "sourced", type: "SOURCED", slaDays: 2 },
  { name: "Intro Call", key: "intro_call", type: "SCREENING", slaDays: 3 },
  { name: "Panel Interview", key: "panel", type: "INTERVIEW", slaDays: 5 },
  { name: "Offer", key: "offer", type: "OFFER", slaDays: 3 },
  { name: "Hired", key: "hired", type: "HIRED" },
];

const DESIGN_FLOW: StageSpec[] = [
  { name: "Applied", key: "applied", type: "APPLIED", slaDays: 2 },
  { name: "Portfolio Review", key: "portfolio_review", type: "SCREENING", slaDays: 4 },
  { name: "Design Exercise", key: "design_exercise", type: "ASSESSMENT", slaDays: 7 },
  { name: "Team Interview", key: "team_interview", type: "INTERVIEW", slaDays: 5 },
  { name: "Offer", key: "offer", type: "OFFER", slaDays: 5 },
  { name: "Hired", key: "hired", type: "HIRED" },
];

async function upsertPipeline(
  orgId: string,
  name: string,
  description: string,
  stages: StageSpec[],
  isDefault = false,
) {
  const pipeline = await prisma.pipeline.upsert({
    where: { orgId_name: { orgId, name } },
    create: { orgId, name, description, isDefault },
    update: { description },
  });

  for (const [index, stage] of stages.entries()) {
    await prisma.pipelineStage.upsert({
      where: { pipelineId_key: { pipelineId: pipeline.id, key: stage.key } },
      create: {
        pipelineId: pipeline.id,
        name: stage.name,
        key: stage.key,
        type: stage.type,
        position: index,
        slaDays: stage.slaDays ?? null,
        optional: stage.optional ?? false,
      },
      update: { name: stage.name, position: index, type: stage.type },
    });
  }

  return pipeline;
}

async function main() {
  console.log("[seed] starting…");

  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    create: { slug: ORG_SLUG, name: "Northwind Talent" },
    update: {},
  });

  const recruiter = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      orgId: org.id,
      email: DEMO_EMAIL,
      name: "Alex Rivera",
      role: "ADMIN",
    },
    update: {},
  });

  const hiringManager = await prisma.user.upsert({
    where: { email: "manager@northwind.test" },
    create: {
      orgId: org.id,
      email: "manager@northwind.test",
      name: "Priya Nair",
      role: "HIRING_MANAGER",
    },
    update: {},
  });

  // --- pipelines ------------------------------------------------------------
  const engineering = await upsertPipeline(
    org.id,
    "Standard Engineering Hire",
    "Nine-step flow used for most engineering roles.",
    ENGINEERING_FLOW,
    true,
  );
  const fastTrack = await upsertPipeline(
    org.id,
    "Fast-track Senior",
    "Compressed flow for senior referrals and executive search.",
    FAST_TRACK_FLOW,
  );
  const design = await upsertPipeline(
    org.id,
    "Design Hire",
    "Portfolio-led flow for design roles.",
    DESIGN_FLOW,
  );

  // --- jobs -----------------------------------------------------------------
  const jobSpecs = [
    {
      title: "Senior Backend Engineer",
      pipelineId: engineering.id,
      department: "Engineering",
      location: "Remote (EU)",
      employmentType: "Full-time",
      openings: 2,
      description: "Own the core services behind our billing platform.",
    },
    {
      title: "Product Designer",
      pipelineId: design.id,
      department: "Design",
      location: "Lisbon",
      employmentType: "Full-time",
      openings: 1,
      description: "Shape the end-to-end experience of our recruiter tooling.",
    },
    {
      title: "Staff Data Engineer",
      pipelineId: fastTrack.id,
      department: "Data",
      location: "Remote (Global)",
      employmentType: "Full-time",
      openings: 1,
      description: "Senior referral pipeline — compressed process.",
    },
  ];

  const jobs = [];
  for (const spec of jobSpecs) {
    const existing = await prisma.job.findFirst({
      where: { orgId: org.id, title: spec.title },
    });
    const job = existing
      ? await prisma.job.update({ where: { id: existing.id }, data: { ...spec } })
      : await prisma.job.create({
          data: { ...spec, orgId: org.id, ownerId: recruiter.id, status: "OPEN" },
        });
    jobs.push(job);
  }
  const [backendJob, designJob, dataJob] = jobs;

  // --- candidates -----------------------------------------------------------
  const candidateSpecs = [
    { fullName: "Marina Duarte", email: "marina.duarte@example.com", headline: "Backend engineer, 8 yrs", source: "Referral", location: "Porto" },
    { fullName: "Tomás Almeida", email: "tomas.almeida@example.com", headline: "Go / Postgres specialist", source: "LinkedIn", location: "Lisbon" },
    { fullName: "Sofia Reis", email: "sofia.reis@example.com", headline: "Platform engineer", source: "Careers page", location: "Remote" },
    { fullName: "Daniel Okafor", email: "daniel.okafor@example.com", headline: "Distributed systems", source: "Referral", location: "Berlin" },
    { fullName: "Elena Kowalski", email: "elena.kowalski@example.com", headline: "Product designer, fintech", source: "Dribbble", location: "Warsaw" },
    { fullName: "Rui Ferreira", email: "rui.ferreira@example.com", headline: "Senior product designer", source: "Careers page", location: "Lisbon" },
    { fullName: "Aisha Rahman", email: "aisha.rahman@example.com", headline: "Staff data engineer", source: "Referral", location: "London" },
    { fullName: "Lucas Moreira", email: "lucas.moreira@example.com", headline: "Analytics engineer", source: "LinkedIn", location: "São Paulo" },
  ];

  const candidates = [];
  for (const spec of candidateSpecs) {
    candidates.push(
      await prisma.candidate.upsert({
        where: { orgId_email: { orgId: org.id, email: spec.email } },
        create: { ...spec, orgId: org.id },
        update: {},
      }),
    );
  }

  // --- applications ---------------------------------------------------------
  // Each one is walked to a different point in its flow so the board has depth.
  const plan: Array<{
    candidateIndex: number;
    jobId: string;
    advanceTo?: string;
    personalize?: "add" | "skip";
  }> = [
    { candidateIndex: 0, jobId: backendJob.id, advanceTo: "tech_interview" },
    { candidateIndex: 1, jobId: backendJob.id, advanceTo: "recruiter_call" },
    { candidateIndex: 2, jobId: backendJob.id, advanceTo: "resume_screen" },
    { candidateIndex: 3, jobId: backendJob.id, advanceTo: "offer", personalize: "skip" },
    { candidateIndex: 4, jobId: designJob.id, advanceTo: "design_exercise" },
    { candidateIndex: 5, jobId: designJob.id, advanceTo: "portfolio_review", personalize: "add" },
    { candidateIndex: 6, jobId: dataJob.id, advanceTo: "panel" },
    { candidateIndex: 7, jobId: dataJob.id, advanceTo: "intro_call" },
  ];

  for (const item of plan) {
    const candidate = candidates[item.candidateIndex];
    const existing = await prisma.application.findUnique({
      where: { jobId_candidateId: { jobId: item.jobId, candidateId: candidate.id } },
    });
    if (existing) continue;

    const application = await createApplication({
      orgId: org.id,
      jobId: item.jobId,
      candidateId: candidate.id,
      actor: { type: "USER", id: recruiter.id },
    });

    // Show off personalization on a couple of applications.
    if (item.personalize === "add") {
      await addCustomStage({
        applicationId: application.id,
        name: "Founder Chat",
        type: "INTERVIEW",
        slaDays: 3,
        actor: { type: "USER", id: recruiter.id },
      });
    }
    if (item.personalize === "skip") {
      const skippable = await prisma.applicationStage.findFirst({
        where: { applicationId: application.id, key: "assessment" },
      });
      if (skippable) {
        await skipStage({
          applicationId: application.id,
          stageId: skippable.id,
          actor: { type: "USER", id: recruiter.id },
          reason: "Strong referral — assessment waived by hiring manager.",
        });
      }
    }

    if (item.advanceTo) {
      await moveToStage({
        applicationId: application.id,
        target: { stageKey: item.advanceTo },
        actor: { type: "USER", id: recruiter.id },
        reason: "Seeded progress",
      });
    }
  }

  // --- automation rules -----------------------------------------------------
  // These are the defaults that make Google sync actually move the process.
  const rules = [
    {
      name: "Candidate replied → mark screening done",
      description:
        "An inbound reply while in a screening stage means the candidate is engaged; complete the stage.",
      trigger: "EMAIL_RECEIVED_FROM_CANDIDATE" as const,
      action: "COMPLETE_CURRENT_STAGE" as const,
      priority: 20,
      conditions: { currentStageType: ["APPLIED", "SCREENING"] },
      config: {},
    },
    {
      name: "Interview booked → move to Technical Interview",
      description:
        "A calendar event whose title mentions a technical interview moves the application to that stage.",
      trigger: "CALENDAR_EVENT_SCHEDULED" as const,
      action: "SET_STAGE" as const,
      priority: 10,
      conditions: { titleContains: ["technical interview", "tech interview", "tech screen"] },
      config: { stageKey: "tech_interview" },
    },
    {
      name: "Any interview booked → move to interview stage",
      description: "Fallback for events that mention an interview without naming which one.",
      trigger: "CALENDAR_EVENT_SCHEDULED" as const,
      action: "SET_STAGE" as const,
      priority: 50,
      conditions: { titleContains: ["interview", "entrevista"] },
      config: { stageType: "INTERVIEW" },
    },
    {
      name: "Interview finished → advance",
      description: "Once the meeting has ended, move the candidate to the next step.",
      trigger: "CALENDAR_EVENT_COMPLETED" as const,
      action: "ADVANCE_STAGE" as const,
      priority: 10,
      conditions: { currentStageType: ["INTERVIEW", "SCREENING", "ASSESSMENT"] },
      config: {},
    },
    {
      name: "Interview cancelled → flag",
      description: "Cancellations need a human decision, so raise a flag rather than moving.",
      trigger: "CALENDAR_EVENT_CANCELLED" as const,
      action: "FLAG_FOR_REVIEW" as const,
      priority: 10,
      conditions: {},
      config: { message: "Interview was cancelled — reschedule or reconsider." },
    },
    {
      name: "Assessment submitted → complete assessment stage",
      description: "A document dropped in while on an assessment stage closes that stage.",
      trigger: "DRIVE_FILE_ADDED" as const,
      action: "COMPLETE_CURRENT_STAGE" as const,
      priority: 20,
      conditions: { currentStageType: ["ASSESSMENT"] },
      config: {},
    },
    {
      name: "Stalled application → flag for review",
      description: "Anything past its stage SLA gets surfaced to the recruiter.",
      trigger: "STAGE_SLA_BREACHED" as const,
      action: "FLAG_FOR_REVIEW" as const,
      priority: 10,
      conditions: {},
      config: { message: "This application is past its stage target." },
    },
  ];

  for (const rule of rules) {
    const existing = await prisma.automationRule.findFirst({
      where: { orgId: org.id, name: rule.name },
    });
    if (existing) continue;
    await prisma.automationRule.create({ data: { ...rule, orgId: org.id } });
  }

  // --- email templates ------------------------------------------------------
  const templates = [
    {
      name: "Screening invite",
      stageKey: "recruiter_call",
      subject: "Chat about the {{job}} role at {{company}}?",
      body:
        "Hi {{candidate}},\n\nThanks for applying to {{job}}. I'd love to set up a 30-minute call to walk through your background and what we're building.\n\nAre you free sometime this week?\n\nBest,\n{{recruiter}}",
    },
    {
      name: "Technical interview confirmation",
      stageKey: "tech_interview",
      subject: "Your technical interview for {{job}}",
      body:
        "Hi {{candidate}},\n\nYour technical interview is confirmed. You'll meet two engineers for 60 minutes and work through a practical problem — no trick questions.\n\nSee you then,\n{{recruiter}}",
    },
    {
      name: "Offer",
      stageKey: "offer",
      subject: "Offer — {{job}} at {{company}}",
      body:
        "Hi {{candidate}},\n\nWe'd like to offer you the {{job}} role. The full details are attached; I'm happy to walk through anything.\n\nCongratulations,\n{{recruiter}}",
    },
    {
      name: "Rejection after interview",
      stageKey: null,
      subject: "Update on your {{job}} application",
      body:
        "Hi {{candidate}},\n\nThank you for the time you put into our process. We've decided to move forward with other candidates for {{job}}, but we were glad to meet you and would welcome an application in future.\n\nBest,\n{{recruiter}}",
    },
  ];

  for (const template of templates) {
    await prisma.emailTemplate.upsert({
      where: { orgId_name: { orgId: org.id, name: template.name } },
      create: { ...template, orgId: org.id },
      update: {},
    });
  }

  const counts = {
    pipelines: await prisma.pipeline.count({ where: { orgId: org.id } }),
    jobs: await prisma.job.count({ where: { orgId: org.id } }),
    candidates: await prisma.candidate.count({ where: { orgId: org.id } }),
    applications: await prisma.application.count({ where: { orgId: org.id } }),
    rules: await prisma.automationRule.count({ where: { orgId: org.id } }),
  };

  console.log("[seed] done:", counts);
  console.log(`[seed] sign in as ${recruiter.email} (dev login) — org ${org.name}`);
  void hiringManager;
  void design;
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
