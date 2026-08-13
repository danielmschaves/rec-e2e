import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { anthropic, ASSISTANT_MODEL } from "@/server/ai/client";
import { toolDefinitions, runTool, type ToolContext } from "@/server/ai/tools";

/**
 * The assistant loop.
 *
 * A hand-written loop rather than the SDK's beta tool runner: every turn is
 * persisted to Postgres as it happens (so a page refresh mid-answer loses
 * nothing) and each tool call is attributed in the timeline. Owning the loop
 * keeps that persistence in one obvious place.
 */

const MAX_ITERATIONS = 8;
/** Bounded so a tool loop can't run away; well inside SDK HTTP timeouts. */
const MAX_TOKENS = 16000;

function effort(): "low" | "medium" | "high" | "xhigh" | "max" {
  const raw = process.env.ASSISTANT_EFFORT;
  const allowed = ["low", "medium", "high", "xhigh", "max"] as const;
  return (allowed as readonly string[]).includes(raw ?? "")
    ? (raw as "low" | "medium" | "high" | "xhigh" | "max")
    : "high";
}

/**
 * Builds the system prompt.
 *
 * The pinned opportunity or challenge is rendered inline so the assistant
 * starts every turn already knowing the situation, rather than spending a tool
 * call rediscovering it.
 */
async function buildSystemPrompt(ctx: ToolContext): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: ctx.userId } });

  const parts: string[] = [];

  parts.push(
    `You are the job-search assistant for ${user?.name ?? "the user"}. They are a candidate going through several recruitment processes at once, and you help them stay on top of all of them.

What you do:
- Answer questions about where each process stands, using the tools rather than guessing.
- Draft emails to companies for them to review and send.
- Help with technical challenges: break the brief into requirements, plan the work, review code they paste, keep the deadline in view.
- Keep the tracker honest — when they tell you something happened, record it.

How to work:
- Use the tools to read real state before advising on a specific company. Do not invent interview dates, names, or what was said.
- You cannot send email. draft_email saves a draft the user reviews and sends themselves. Say so plainly rather than implying it went out.
- When they mention something worth keeping (an interviewer's name, a salary figure, a commitment they made), save it with add_note or set_next_action instead of leaving it in chat.

How to write:
- Lead with the answer. Supporting detail after.
- Keep responses focused and brief; skip preamble and restatement. A simple question gets a direct answer in prose, not headers and bullet lists.
- Be concrete and honest about their position, including when it looks weak or a company has likely moved on. Encouragement that isn't grounded in the record is not useful to them.
- Deliver what they asked for at the scope they asked for. If you think the ask is wrong, say so in a sentence and do it anyway.`,
  );

  if (user?.profile) {
    parts.push(`About them, in their own words:\n${user.profile}`);
  }

  parts.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);

  if (ctx.opportunityId) {
    const o = await prisma.opportunity.findFirst({
      where: { id: ctx.opportunityId, userId: ctx.userId },
      include: {
        company: { include: { contacts: true } },
        currentStage: true,
        stages: { orderBy: { position: "asc" } },
      },
    });
    if (o) {
      parts.push(
        `This conversation is about one specific process — use this id when calling tools.

opportunityId: ${o.id}
Company: ${o.company.name}
Role: ${o.roleTitle}
Status: ${o.status}
Current stage: ${o.currentStage?.name ?? "none"}
Next action: ${o.nextAction ?? "none recorded"}
Stages: ${o.stages.map((s) => `${s.name} [${s.key}] (${s.status})`).join(" · ")}
Contacts: ${
          o.company.contacts.length > 0
            ? o.company.contacts.map((c) => `${c.name} <${c.email}> ${c.role}`).join("; ")
            : "none recorded"
        }`,
      );
    }
  }

  if (ctx.challengeId) {
    const c = await prisma.challenge.findFirst({
      where: { id: ctx.challengeId, userId: ctx.userId },
      include: { requirements: { orderBy: { position: "asc" } } },
    });
    if (c) {
      parts.push(
        `This conversation is about a technical challenge — use this id when calling tools.

challengeId: ${c.id}
Title: ${c.title}
Status: ${c.status}
Deadline: ${c.deadline?.toISOString() ?? "none set"}
Requirements so far: ${
          c.requirements.length > 0
            ? c.requirements.map((r) => `${r.done ? "[x]" : "[ ]"} ${r.text}`).join(" · ")
            : "none extracted yet"
        }
Plan: ${c.plan ? "already written" : "not written yet"}

The brief:
${c.brief ?? "(the user has not pasted the brief yet — ask for it)"}`,
      );
    }
  }

  return parts.join("\n\n");
}

/** Replays a stored thread into Anthropic message params. */
async function loadHistory(threadId: string): Promise<Anthropic.MessageParam[]> {
  const stored = await prisma.assistantMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "asc" },
  });

  const messages: Anthropic.MessageParam[] = [];
  for (const message of stored) {
    // `blocks` holds the exact content array; replaying it verbatim keeps
    // tool_use / tool_result pairs intact across turns.
    const blocks = message.blocks as Anthropic.ContentBlockParam[] | null;
    if (message.role === "USER") {
      messages.push({ role: "user", content: blocks ?? message.content });
    } else if (message.role === "ASSISTANT") {
      if (blocks && blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    } else if (message.role === "TOOL") {
      if (blocks && blocks.length > 0) messages.push({ role: "user", content: blocks });
    }
  }
  return messages;
}

export type AssistantReply = {
  text: string;
  toolSummaries: string[];
  error?: string;
};

/**
 * Sends one user message and runs the tool loop until the assistant stops
 * calling tools. Everything is persisted as it goes.
 */
export async function sendMessage(params: {
  threadId: string;
  userId: string;
  message: string;
  /**
   * Injection point for tests. Defaults to the real client — scripts can pass a
   * stub to exercise the loop, tool dispatch and persistence without a key.
   */
  client?: Pick<Anthropic, "messages">;
}): Promise<AssistantReply> {
  const thread = await prisma.assistantThread.findFirst({
    where: { id: params.threadId, userId: params.userId },
  });
  if (!thread) throw new Error("Thread not found");

  const ctx: ToolContext = {
    userId: params.userId,
    opportunityId: thread.opportunityId,
    challengeId: thread.challengeId,
  };

  await prisma.assistantMessage.create({
    data: {
      threadId: thread.id,
      role: "USER",
      content: params.message,
      blocks: [{ type: "text", text: params.message }],
    },
  });

  const system = await buildSystemPrompt(ctx);
  const messages = await loadHistory(thread.id);
  const tools = toolDefinitions();
  const client = params.client ?? anthropic();

  const toolSummaries: string[] = [];
  let finalText = "";

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await client.messages.create({
        model: ASSISTANT_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        // Thinking is on by default on this model; being explicit documents it.
        thinking: { type: "adaptive" },
        output_config: { effort: effort() },
        tools,
        messages,
      });

      if (response.stop_reason === "refusal") {
        const note = "I can't help with that one.";
        await prisma.assistantMessage.create({
          data: { threadId: thread.id, role: "ASSISTANT", content: note, isError: true },
        });
        return { text: note, toolSummaries, error: "refusal" };
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      messages.push({ role: "assistant", content: response.content });
      await prisma.assistantMessage.create({
        data: {
          threadId: thread.id,
          role: "ASSISTANT",
          content: text,
          blocks: response.content as unknown as Prisma.InputJsonValue,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      });

      if (text) finalText = text;

      if (toolUses.length === 0) break;

      // Execute every requested tool, then return all results in ONE user
      // message — splitting them teaches the model to stop calling in parallel.
      const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const run = await runTool(use.name, use.input, ctx);
        toolSummaries.push(run.summary);
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(run.result ?? {}),
          is_error: run.isError,
        });
      }

      messages.push({ role: "user", content: resultBlocks });
      await prisma.assistantMessage.create({
        data: {
          threadId: thread.id,
          role: "TOOL",
          content: toolSummaries.slice(-toolUses.length).join("; "),
          blocks: resultBlocks as unknown as Prisma.InputJsonValue,
          toolSummary: toolSummaries.slice(-toolUses.length).join("; "),
        },
      });
    }
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? `The assistant call failed (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : "The assistant call failed";

    await prisma.assistantMessage.create({
      data: { threadId: thread.id, role: "ASSISTANT", content: message, isError: true },
    });
    return { text: message, toolSummaries, error: message };
  }

  await prisma.assistantThread.update({
    where: { id: thread.id },
    data: {
      updatedAt: new Date(),
      // Name the thread from its first real question.
      title:
        thread.title === "New conversation"
          ? params.message.slice(0, 60)
          : thread.title,
    },
  });

  return {
    text: finalText || "(no reply)",
    toolSummaries,
  };
}
