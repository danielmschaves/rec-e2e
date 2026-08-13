/**
 * End-to-end check of the process engine, automation rules and assistant tools.
 *
 * Creates a throwaway company + opportunity, drives it through the lifecycle —
 * standard flow, personalization, each automation trigger the Google sync
 * emits, and the assistant's own tools — asserting state after every step, then
 * deletes everything it created.
 *
 * Does not call the Anthropic API: it exercises the tool layer directly, so it
 * runs without an API key.
 *
 * Run with: npx tsx scripts/e2e-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  createOpportunity,
  addCustomStage,
  skipStage,
  moveToStage,
} from "../src/server/opportunities";
import { dispatchEvent } from "../src/server/automation";
import { runTool } from "../src/server/ai/tools";

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

async function stagesOf(opportunityId: string) {
  return prisma.opportunityStage.findMany({
    where: { opportunityId },
    orderBy: { position: "asc" },
  });
}

async function currentKey(opportunityId: string): Promise<string | null> {
  const o = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    include: { currentStage: true },
  });
  return o?.currentStage?.key ?? null;
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "you@example.com" } });
  if (!user) throw new Error("Seed data missing — run `npx tsx prisma/seed.ts` first");

  const template = await prisma.processTemplate.findFirst({
    where: { userId: user.id, name: "Standard engineering loop" },
  });
  if (!template) throw new Error("Standard template missing");

  const stamp = Date.now();
  const company = await prisma.company.create({
    data: {
      userId: user.id,
      name: `E2E Check Co ${stamp}`,
      domains: [`e2e-${stamp}.example`],
    },
  });

  let opportunityId = "";

  try {
    // --- 1. standard flow instantiation ------------------------------------
    console.log("\n1. Standard flow is copied from the template");
    const opportunity = await createOpportunity({
      userId: user.id,
      companyId: company.id,
      templateId: template.id,
      roleTitle: "E2E Role",
      actor: { type: "USER" },
    });
    opportunityId = opportunity.id;

    const initial = await stagesOf(opportunityId);
    check("stages copied from template", initial.length === 9, `got ${initial.length}`);
    check("first stage is active", (await currentKey(opportunityId)) === "researching");
    check("flow starts STANDARD", opportunity.flowMode === "STANDARD");

    // --- 2. personalization: custom stage placement ------------------------
    console.log("\n2. Personalization — a custom step lands before terminal stages");
    await addCustomStage({
      opportunityId,
      name: "Pairing session",
      type: "TECHNICAL_INTERVIEW",
      actor: { type: "USER" },
    });
    const withCustom = await stagesOf(opportunityId);
    const pairingIdx = withCustom.findIndex((s) => s.key === "pairing_session");
    const acceptedIdx = withCustom.findIndex((s) => s.key === "accepted");
    check("custom stage added", pairingIdx !== -1);
    check(
      "custom stage sits before Accepted",
      pairingIdx !== -1 && acceptedIdx !== -1 && pairingIdx < acceptedIdx,
      `pairing=${pairingIdx} accepted=${acceptedIdx}`,
    );
    check(
      "positions stay contiguous",
      withCustom.every((s, i) => s.position === i),
      withCustom.map((s) => s.position).join(","),
    );
    const personalized = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
    check("flow flipped to PERSONALIZED", personalized?.flowMode === "PERSONALIZED");

    // --- 3. personalization: skipping ---------------------------------------
    console.log("\n3. Personalization — a skipped stage stays visible but inert");
    const takeHome = withCustom.find((s) => s.key === "take_home")!;
    await skipStage({
      opportunityId,
      stageId: takeHome.id,
      actor: { type: "USER" },
      reason: "They waived it",
    });
    const skipped = (await stagesOf(opportunityId)).find((s) => s.key === "take_home");
    check("stage marked SKIPPED", skipped?.status === "SKIPPED");
    check("skip reason recorded", skipped?.notes === "They waived it");

    // --- 4. automation: they replied ----------------------------------------
    console.log("\n4. Automation — an inbound reply completes a screening stage");
    await moveToStage({
      opportunityId,
      target: { stageKey: "recruiter_screen" },
      actor: { type: "USER" },
    });
    const replyOutcomes = await dispatchEvent({
      userId: user.id,
      opportunityId,
      trigger: "EMAIL_RECEIVED_FROM_COMPANY",
      payload: { title: "Re: next steps", body: "Great chatting — let's book the next round." },
    });
    check("a rule fired", replyOutcomes.some((o) => o.applied), JSON.stringify(replyOutcomes));
    const afterReply = (await stagesOf(opportunityId)).find((s) => s.key === "recruiter_screen");
    check("recruiter screen completed by automation", afterReply?.status === "COMPLETED");

    // --- 5. automation: interview booked ------------------------------------
    console.log("\n5. Automation — a technical interview invite moves the stage");
    const bookOutcomes = await dispatchEvent({
      userId: user.id,
      opportunityId,
      trigger: "CALENDAR_EVENT_SCHEDULED",
      payload: { title: "Technical interview — E2E Role" },
    });
    check("a rule fired", bookOutcomes.some((o) => o.applied), JSON.stringify(bookOutcomes));
    check(
      "moved to technical interview",
      (await currentKey(opportunityId)) === "tech_interview",
      `current=${await currentKey(opportunityId)}`,
    );
    const stillSkipped = (await stagesOf(opportunityId)).find((s) => s.key === "take_home");
    check(
      "jumped-over skipped stage stays SKIPPED",
      stillSkipped?.status === "SKIPPED",
      `got ${stillSkipped?.status}`,
    );

    // --- 6. automation: rejection email -------------------------------------
    console.log("\n6. Automation — a rejection email closes the process");
    const rejectOutcomes = await dispatchEvent({
      userId: user.id,
      opportunityId,
      trigger: "EMAIL_RECEIVED_FROM_COMPANY",
      payload: {
        title: "Update on your application",
        body: "Unfortunately we have decided not to proceed with your application.",
      },
    });
    check("a rule fired", rejectOutcomes.some((o) => o.applied), JSON.stringify(rejectOutcomes));
    const rejected = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
    check("opportunity marked REJECTED", rejected?.status === "REJECTED", `got ${rejected?.status}`);
    check("close date recorded", rejected?.closedAt != null);

    // --- 7. assistant tools --------------------------------------------------
    console.log("\n7. Assistant tools operate on real state");
    const ctx = { userId: user.id, opportunityId };

    const listed = await runTool("list_opportunities", {}, ctx);
    check("list_opportunities returns rows", Array.isArray(listed.result));

    const got = await runTool("get_opportunity", { opportunityId }, ctx);
    const detail = got.result as { company?: string; stages?: unknown[] };
    check("get_opportunity returns the process", detail.company === company.name);
    check("get_opportunity includes stages", (detail.stages?.length ?? 0) === 10);

    const drafted = await runTool(
      "draft_email",
      {
        opportunityId,
        toEmail: "someone@e2e.example",
        subject: "Thanks for the update",
        body: "Thanks for letting me know — I'd welcome the chance to stay in touch.",
        rationale: "Keeps the door open after a rejection.",
      },
      ctx,
    );
    const draftResult = drafted.result as { draftId?: string };
    check("draft_email created a draft", Boolean(draftResult.draftId));

    const draftRow = draftResult.draftId
      ? await prisma.emailDraft.findUnique({ where: { id: draftResult.draftId } })
      : null;
    check("draft is unsent and awaiting approval", draftRow?.status === "DRAFT");
    check("draft is attributed to the assistant", draftRow?.createdBy === "ASSISTANT");
    check("draft was NOT sent", draftRow?.sentAt === null && draftRow?.gmailId === null);

    const noted = await runTool(
      "add_note",
      { opportunityId, body: "Interviewer mentioned they use Go and Temporal." },
      ctx,
    );
    check("add_note succeeded", (noted.result as { ok?: boolean }).ok === true);

    const badTool = await runTool("get_opportunity", { opportunityId: 42 }, ctx);
    check("invalid tool input is rejected, not thrown", badTool.isError);

    const foreign = await runTool(
      "get_opportunity",
      { opportunityId: "does-not-exist" },
      ctx,
    );
    check(
      "tools refuse records outside your account",
      (foreign.result as { error?: string }).error === "Opportunity not found",
    );

    // --- 8. audit trail ------------------------------------------------------
    console.log("\n8. Every change left an audit trail");
    const transitions = await prisma.stageTransition.count({ where: { opportunityId } });
    const activities = await prisma.activity.count({ where: { opportunityId } });
    const automated = await prisma.stageTransition.count({
      where: { opportunityId, actorType: "AUTOMATION" },
    });
    const assisted = await prisma.activity.count({
      where: { opportunityId, actorType: "ASSISTANT" },
    });
    // Three: created, → recruiter screen, → technical interview. The rejection
    // sets status without moving a stage, which is the intended behaviour.
    check("transitions recorded", transitions >= 3, `got ${transitions}`);
    check("activities recorded", activities >= 8, `got ${activities}`);
    check("automation attributed to rules", automated >= 1, `got ${automated}`);
    check("assistant actions attributed", assisted >= 2, `got ${assisted}`);
  } finally {
    // Clean up — cascades remove stages, transitions, activities, drafts, notes.
    if (opportunityId) {
      await prisma.opportunity.deleteMany({ where: { id: opportunityId } });
    }
    await prisma.company.deleteMany({ where: { id: company.id } });
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
