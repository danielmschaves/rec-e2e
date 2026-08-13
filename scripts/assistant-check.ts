/**
 * Assistant loop check.
 *
 * Drives the real agent loop — tool dispatch, persistence, history replay —
 * against a stubbed Anthropic client, so it runs with no API key. It proves the
 * wiring: that a tool_use block reaches the right tool, that its result is fed
 * back as a tool_result in a single user message, that the transcript is
 * persisted in a replayable shape, and above all that draft_email produces an
 * unsent draft.
 *
 * What it does NOT prove: that the model chooses the right tools or writes a
 * good email. That needs a real key.
 *
 * Run with: npx tsx scripts/assistant-check.ts
 */
import { PrismaClient } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";
import { createOpportunity } from "../src/server/opportunities";
import { sendMessage } from "../src/server/ai/agent";

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

/** Records what the loop sent us, and replies with a scripted sequence. */
function stubClient(opportunityId: string) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let turn = 0;

  const scripted: Anthropic.Message[] = [
    // Turn 1: read the process.
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "stub",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
      content: [
        { type: "text", text: "Let me look at where this stands." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_opportunity",
          input: { opportunityId },
        },
      ],
    } as Anthropic.Message,
    // Turn 2: two tools at once — exercises the parallel path.
    {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "stub",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 } as Anthropic.Usage,
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "draft_email",
          input: {
            opportunityId,
            toEmail: "recruiter@stub.example",
            subject: "Following up on the Principal Engineer role",
            body: "Hi — just checking in on next steps. Best, Daniel",
            rationale: "Two weeks of silence after the screen.",
          },
        },
        {
          type: "tool_use",
          id: "toolu_3",
          name: "set_next_action",
          input: { opportunityId, action: "Wait for their reply" },
        },
      ],
    } as Anthropic.Message,
    // Turn 3: final answer, no tools.
    {
      id: "msg_3",
      type: "message",
      role: "assistant",
      model: "stub",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 12 } as Anthropic.Usage,
      content: [
        {
          type: "text",
          text: "Drafted a follow-up for you to review — it's on the Drafts page.",
        },
      ],
    } as Anthropic.Message,
  ];

  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        // The loop mutates one `messages` array across iterations, so snapshot
        // it — holding the reference would show every request final state.
        requests.push({
          ...params,
          messages: JSON.parse(JSON.stringify(params.messages)),
        });
        return scripted[Math.min(turn++, scripted.length - 1)];
      },
    },
  } as unknown as Pick<Anthropic, "messages">;

  return { client, requests };
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
    data: { userId: user.id, name: `Assistant Check ${stamp}`, domains: [] },
  });

  let opportunityId = "";
  let threadId = "";

  try {
    const opportunity = await createOpportunity({
      userId: user.id,
      companyId: company.id,
      templateId: template.id,
      roleTitle: "Principal Engineer",
      actor: { type: "USER" },
    });
    opportunityId = opportunity.id;

    const thread = await prisma.assistantThread.create({
      data: { userId: user.id, opportunityId },
    });
    threadId = thread.id;

    const { client, requests } = stubClient(opportunityId);

    console.log("\n1. The loop runs until the assistant stops calling tools");
    const reply = await sendMessage({
      threadId,
      userId: user.id,
      message: "Can you chase them for me?",
      client,
    });
    check("loop ran three turns", requests.length === 3, `got ${requests.length}`);
    check(
      "final text returned",
      reply.text.includes("Drafted a follow-up"),
      reply.text,
    );
    check("tool runs were summarised", reply.toolSummaries.length === 3, reply.toolSummaries.join(" | "));

    console.log("\n2. The request is shaped correctly");
    const first = requests[0];
    check("model is claude-opus-5", first.model === "claude-opus-5", first.model);
    check("tools were offered", (first.tools?.length ?? 0) >= 6, `${first.tools?.length}`);
    check(
      "system prompt carries the process context",
      typeof first.system === "string" && first.system.includes(opportunityId),
    );
    check(
      "system prompt states it cannot send",
      typeof first.system === "string" && first.system.includes("cannot send email"),
    );

    console.log("\n3. Tool results are returned in one user message");
    const secondTurn = requests[1];
    const lastOfSecond = secondTurn.messages.at(-1);
    check(
      "one user message carries the tool result",
      lastOfSecond?.role === "user" && Array.isArray(lastOfSecond.content),
    );
    const thirdTurn = requests[2];
    const lastOfThird = thirdTurn.messages.at(-1);
    const blocks = Array.isArray(lastOfThird?.content) ? lastOfThird.content : [];
    check(
      "both parallel tool results are in that single message",
      blocks.length === 2 && blocks.every((b) => b.type === "tool_result"),
      `got ${blocks.length} blocks`,
    );

    console.log("\n4. The transcript is persisted in a replayable shape");
    const stored = await prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
    });
    const roles = stored.map((m) => m.role).join(",");
    check(
      "roles alternate user → assistant → tool → assistant → tool → assistant",
      roles === "USER,ASSISTANT,TOOL,ASSISTANT,TOOL,ASSISTANT",
      roles,
    );
    check(
      "assistant turns kept their raw blocks",
      stored.filter((m) => m.role === "ASSISTANT").every((m) => Array.isArray(m.blocks)),
    );
    check(
      "token usage recorded",
      stored.some((m) => (m.inputTokens ?? 0) > 0),
    );

    console.log("\n5. The safety guarantee: it drafted, it did not send");
    const drafts = await prisma.emailDraft.findMany({ where: { opportunityId } });
    check("exactly one draft created", drafts.length === 1, `got ${drafts.length}`);
    check("draft is unsent", drafts[0]?.status === "DRAFT");
    check("draft has no sent timestamp", drafts[0]?.sentAt === null);
    check("draft has no gmail id", drafts[0]?.gmailId === null);
    check("draft attributed to the assistant", drafts[0]?.createdBy === "ASSISTANT");
    check(
      "rationale is shown to the user",
      drafts[0]?.rationale === "Two weeks of silence after the screen.",
    );

    console.log("\n6. Side effects landed on the process");
    const updated = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
    check("next action was set", updated?.nextAction === "Wait for their reply");
    const assistantActivity = await prisma.activity.count({
      where: { opportunityId, actorType: "ASSISTANT" },
    });
    check("assistant actions are in the timeline", assistantActivity >= 1);

    console.log("\n7. A second message replays the stored history");
    const { client: client2, requests: requests2 } = stubClient(opportunityId);
    await sendMessage({
      threadId,
      userId: user.id,
      message: "Thanks",
      client: client2,
    });
    const replayed = requests2[0].messages;
    check(
      "prior turns were replayed",
      replayed.length >= 7,
      `got ${replayed.length} messages`,
    );
    check("history starts with the original question", replayed[0]?.role === "user");
    check(
      "no assistant turn has empty content",
      replayed
        .filter((m) => m.role === "assistant")
        .every((m) => Array.isArray(m.content) && m.content.length > 0),
    );
  } finally {
    if (opportunityId) await prisma.opportunity.deleteMany({ where: { id: opportunityId } });
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
