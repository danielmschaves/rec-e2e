/**
 * End-to-end check of the process engine.
 *
 * Creates a throwaway job + candidate, drives an application through the
 * lifecycle — standard flow, personalization, and each automation trigger the
 * Google sync emits — asserting the state after every step, then deletes
 * everything it created.
 *
 * Run with: npx tsx scripts/e2e-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  createApplication,
  addCustomStage,
  skipStage,
  moveToStage,
} from "../src/server/applications";
import { dispatchEvent } from "../src/server/automation";

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

async function stagesOf(applicationId: string) {
  return prisma.applicationStage.findMany({
    where: { applicationId },
    orderBy: { position: "asc" },
  });
}

async function currentKey(applicationId: string): Promise<string | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { currentStage: true },
  });
  return app?.currentStage?.key ?? null;
}

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug: "northwind-talent" } });
  if (!org) throw new Error("Seed data missing — run `npx tsx prisma/seed.ts` first");

  const pipeline = await prisma.pipeline.findFirst({
    where: { orgId: org.id, name: "Standard Engineering Hire" },
  });
  if (!pipeline) throw new Error("Standard Engineering Hire pipeline missing");

  const stamp = Date.now();
  const job = await prisma.job.create({
    data: {
      orgId: org.id,
      pipelineId: pipeline.id,
      title: `E2E Check Role ${stamp}`,
      status: "OPEN",
    },
  });
  const candidate = await prisma.candidate.create({
    data: {
      orgId: org.id,
      fullName: "E2E Check Candidate",
      email: `e2e-check-${stamp}@example.com`,
    },
  });

  try {
    // --- 1. standard flow instantiation ------------------------------------
    console.log("\n1. Standard flow is copied from the template");
    const app = await createApplication({
      orgId: org.id,
      jobId: job.id,
      candidateId: candidate.id,
      actor: { type: "USER" },
    });
    const initial = await stagesOf(app.id);
    check("stages copied from pipeline", initial.length === 9, `got ${initial.length}`);
    check("first stage is active", await currentKey(app.id) === "applied");
    check("flow starts STANDARD", app.flowMode === "STANDARD");
    check(
      "later stages are pending",
      initial.filter((s) => s.status === "PENDING").length === 8,
    );

    // --- 2. personalization: custom stage placement ------------------------
    console.log("\n2. Personalization — a custom stage lands before terminal stages");
    await addCustomStage({
      applicationId: app.id,
      name: "Founder Chat",
      type: "INTERVIEW",
      actor: { type: "USER" },
    });
    const withCustom = await stagesOf(app.id);
    const founderIdx = withCustom.findIndex((s) => s.key === "founder_chat");
    const hiredIdx = withCustom.findIndex((s) => s.key === "hired");
    check("custom stage was added", founderIdx !== -1);
    check(
      "custom stage sits before Hired",
      founderIdx !== -1 && hiredIdx !== -1 && founderIdx < hiredIdx,
      `founder=${founderIdx} hired=${hiredIdx}`,
    );
    check(
      "positions stay contiguous",
      withCustom.every((s, i) => s.position === i),
      withCustom.map((s) => s.position).join(","),
    );
    const afterPersonalize = await prisma.application.findUnique({ where: { id: app.id } });
    check("flow flipped to PERSONALIZED", afterPersonalize?.flowMode === "PERSONALIZED");

    // --- 3. personalization: skipping ---------------------------------------
    console.log("\n3. Personalization — skipping a stage keeps it visible but inert");
    const assessment = withCustom.find((s) => s.key === "assessment")!;
    await skipStage({
      applicationId: app.id,
      stageId: assessment.id,
      actor: { type: "USER" },
      reason: "Waived",
    });
    const skipped = (await stagesOf(app.id)).find((s) => s.key === "assessment");
    check("stage marked SKIPPED", skipped?.status === "SKIPPED");
    check("skip reason recorded", skipped?.notes === "Waived");

    // --- 4. automation: candidate replies -----------------------------------
    console.log("\n4. Automation — an inbound reply completes a screening stage");
    await moveToStage({
      applicationId: app.id,
      target: { stageKey: "recruiter_call" },
      actor: { type: "USER" },
    });
    check("moved to recruiter call", await currentKey(app.id) === "recruiter_call");

    const replyOutcomes = await dispatchEvent({
      orgId: org.id,
      applicationId: app.id,
      trigger: "EMAIL_RECEIVED_FROM_CANDIDATE",
      payload: {
        title: "Re: chat about the role",
        body: "Yes, Tuesday works for me!",
        fromEmail: candidate.email,
      },
    });
    check("a rule fired", replyOutcomes.some((o) => o.applied), JSON.stringify(replyOutcomes));
    const afterReply = (await stagesOf(app.id)).find((s) => s.key === "recruiter_call");
    check("recruiter call completed by automation", afterReply?.status === "COMPLETED");

    // --- 5. automation: interview booked ------------------------------------
    console.log("\n5. Automation — booking a technical interview moves the stage");
    const bookOutcomes = await dispatchEvent({
      orgId: org.id,
      applicationId: app.id,
      trigger: "CALENDAR_EVENT_SCHEDULED",
      payload: { title: "Technical Interview — E2E Check Candidate" },
    });
    check("a rule fired", bookOutcomes.some((o) => o.applied), JSON.stringify(bookOutcomes));
    check(
      "moved to technical interview",
      await currentKey(app.id) === "tech_interview",
      `current=${await currentKey(app.id)}`,
    );
    const skippedStillSkipped = (await stagesOf(app.id)).find((s) => s.key === "assessment");
    check(
      "jumped-over skipped stage stays SKIPPED",
      skippedStillSkipped?.status === "SKIPPED",
      `got ${skippedStillSkipped?.status}`,
    );

    // --- 6. automation: interview finished ----------------------------------
    console.log("\n6. Automation — a finished interview advances the flow");
    const doneOutcomes = await dispatchEvent({
      orgId: org.id,
      applicationId: app.id,
      trigger: "CALENDAR_EVENT_COMPLETED",
      payload: { title: "Technical Interview — E2E Check Candidate" },
    });
    check("a rule fired", doneOutcomes.some((o) => o.applied), JSON.stringify(doneOutcomes));
    check(
      "advanced past the interview",
      await currentKey(app.id) === "hm_interview",
      `current=${await currentKey(app.id)}`,
    );

    // --- 7. terminal stage settles the application --------------------------
    console.log("\n7. Reaching a terminal stage settles the application");
    await moveToStage({
      applicationId: app.id,
      target: { stageKey: "hired" },
      actor: { type: "USER" },
    });
    const settled = await prisma.application.findUnique({ where: { id: app.id } });
    check("application marked HIRED", settled?.status === "HIRED", `got ${settled?.status}`);

    // --- 8. audit trail -----------------------------------------------------
    console.log("\n8. Every change left an audit trail");
    const transitions = await prisma.stageTransition.count({ where: { applicationId: app.id } });
    const activities = await prisma.activity.count({ where: { applicationId: app.id } });
    const automated = await prisma.stageTransition.count({
      where: { applicationId: app.id, actorType: "AUTOMATION" },
    });
    check("transitions recorded", transitions >= 5, `got ${transitions}`);
    check("activities recorded", activities >= 8, `got ${activities}`);
    check("automation attributed to rules", automated >= 2, `got ${automated}`);
  } finally {
    // Clean up — cascades remove stages, transitions, activities and notes.
    await prisma.application.deleteMany({ where: { jobId: job.id } });
    await prisma.job.delete({ where: { id: job.id } });
    await prisma.candidate.delete({ where: { id: candidate.id } });
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
