import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import { advanceStage, moveToStage, setNextAction } from "@/server/opportunities";

/**
 * Tools the assistant can call.
 *
 * Two rules shape this surface:
 *   1. Nothing here sends email or touches anything outside the app. The
 *      assistant writes an EmailDraft; sending stays a human click.
 *   2. Every mutation is attributed to ASSISTANT in the timeline, so you can
 *      always see what it did on your behalf.
 *
 * Descriptions say *when* to call, not just what the tool does — that is what
 * actually drives correct tool selection.
 */

export type ToolContext = { userId: string; opportunityId?: string | null; challengeId?: string | null };

type ToolDef<S extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  inputSchema: Anthropic.Tool["input_schema"];
  /** Short line shown in the transcript when this tool runs. */
  summarize: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: ToolDef<any>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool<S extends z.ZodTypeAny>(def: ToolDef<S>): void {
  registry.push(def);
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

tool({
  name: "list_opportunities",
  description:
    "List the user's recruitment processes with their current stage and status. Call this when the user asks a question spanning more than one company — 'what's outstanding this week', 'which processes have gone quiet', 'where am I furthest along' — or when you need to pick which process they mean.",
  schema: z.object({
    status: z
      .enum(["ACTIVE", "ON_HOLD", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED"])
      .optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["ACTIVE", "ON_HOLD", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED"],
        description: "Filter to one status. Omit for everything still open.",
      },
    },
  },
  summarize: () => "Looked at your processes",
  run: async (input, ctx) => {
    const opportunities = await prisma.opportunity.findMany({
      where: {
        userId: ctx.userId,
        status: input.status ?? { in: ["ACTIVE", "ON_HOLD", "OFFER"] },
      },
      include: { company: true, currentStage: true },
      orderBy: { lastActivityAt: "desc" },
    });

    return opportunities.map((o) => ({
      id: o.id,
      company: o.company.name,
      role: o.roleTitle,
      status: o.status,
      stage: o.currentStage?.name ?? null,
      priority: o.priority,
      nextAction: o.nextAction,
      lastActivityAt: o.lastActivityAt.toISOString(),
    }));
  },
});

tool({
  name: "get_opportunity",
  description:
    "Get the full picture of one process: every stage and its status, recent emails, upcoming interviews, contacts, notes, and any technical challenge. Call this before drafting an email or advising on a specific company, so your advice reflects what actually happened rather than what you assume.",
  schema: z.object({ opportunityId: z.string() }),
  inputSchema: {
    type: "object",
    properties: {
      opportunityId: { type: "string", description: "The opportunity's id." },
    },
    required: ["opportunityId"],
  },
  summarize: () => "Read the process history",
  run: async (input, ctx) => {
    const o = await prisma.opportunity.findFirst({
      where: { id: input.opportunityId, userId: ctx.userId },
      include: {
        company: { include: { contacts: true } },
        currentStage: true,
        stages: { orderBy: { position: "asc" } },
        emails: { orderBy: { sentAt: "desc" }, take: 10 },
        calendarEvents: { orderBy: { startsAt: "desc" }, take: 5 },
        notes: { orderBy: { createdAt: "desc" }, take: 10 },
        challenges: { include: { requirements: true } },
      },
    });
    if (!o) return { error: "Opportunity not found" };

    return {
      id: o.id,
      company: o.company.name,
      role: o.roleTitle,
      status: o.status,
      priority: o.priority,
      flowMode: o.flowMode,
      location: o.location,
      salary: o.salaryMin || o.salaryMax ? `${o.salaryMin ?? "?"}–${o.salaryMax ?? "?"} ${o.currency}` : null,
      nextAction: o.nextAction,
      appliedAt: o.appliedAt.toISOString(),
      lastActivityAt: o.lastActivityAt.toISOString(),
      currentStage: o.currentStage?.name ?? null,
      stages: o.stages.map((s) => ({
        id: s.id,
        name: s.name,
        key: s.key,
        type: s.type,
        status: s.status,
        isCustom: s.isCustom,
      })),
      contacts: o.company.contacts.map((c) => ({
        name: c.name,
        email: c.email,
        role: c.role,
      })),
      recentEmails: o.emails.map((e) => ({
        direction: e.direction,
        subject: e.subject,
        from: e.fromEmail,
        sentAt: e.sentAt.toISOString(),
        snippet: e.snippet,
      })),
      interviews: o.calendarEvents.map((e) => ({
        title: e.title,
        startsAt: e.startsAt.toISOString(),
        status: e.status,
      })),
      notes: o.notes.map((n) => ({ body: n.body, at: n.createdAt.toISOString() })),
      challenges: o.challenges.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        deadline: c.deadline?.toISOString() ?? null,
        requirementsDone: c.requirements.filter((r) => r.done).length,
        requirementsTotal: c.requirements.length,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Email — drafts only, never sends
// ---------------------------------------------------------------------------

tool({
  name: "draft_email",
  description:
    "Write an email to a company and save it as a draft for the user to review. Call this whenever the user asks you to follow up, chase, reply, accept, decline, negotiate, or thank someone. This NEVER sends — the user reads your draft and presses send themselves, so write it ready to go rather than as a sketch, and match their voice: plain, warm, specific about what already happened, no filler.",
  schema: z.object({
    opportunityId: z.string(),
    toEmail: z.string(),
    subject: z.string(),
    body: z.string(),
    rationale: z.string().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      opportunityId: { type: "string", description: "Which process this is about." },
      toEmail: { type: "string", description: "Recipient address — use a known contact where one exists." },
      subject: { type: "string", description: "Subject line. Reuse the existing thread's subject when replying." },
      body: { type: "string", description: "Full plain-text body, ready to send, signed off with the user's first name." },
      rationale: {
        type: "string",
        description: "One line on why you wrote it this way, shown above the draft.",
      },
    },
    required: ["opportunityId", "toEmail", "subject", "body"],
  },
  summarize: (input) => `Drafted an email: "${input.subject}"`,
  run: async (input, ctx) => {
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: input.opportunityId, userId: ctx.userId },
      include: { company: true },
    });
    if (!opportunity) return { error: "Opportunity not found" };

    const draft = await prisma.emailDraft.create({
      data: {
        userId: ctx.userId,
        opportunityId: opportunity.id,
        toEmail: input.toEmail,
        subject: input.subject,
        body: input.body,
        threadId: opportunity.emailThreadId,
        rationale: input.rationale ?? null,
        createdBy: "ASSISTANT",
      },
    });

    await logActivity({
      userId: ctx.userId,
      opportunityId: opportunity.id,
      type: "DRAFT_CREATED",
      title: `Draft ready: ${input.subject}`,
      body: input.rationale ?? null,
      actorType: "ASSISTANT",
    });

    return {
      draftId: draft.id,
      status: "awaiting your approval",
      note: "The draft is saved. The user must review and send it — you cannot send it.",
    };
  },
});

// ---------------------------------------------------------------------------
// Process bookkeeping
// ---------------------------------------------------------------------------

tool({
  name: "set_next_action",
  description:
    "Record what the user owes this company next (or what they're waiting on), with an optional due date. Call this after any exchange that creates an obligation — 'send them my availability', 'complete the take-home by Friday' — so it surfaces on the dashboard instead of living only in this conversation.",
  schema: z.object({
    opportunityId: z.string(),
    action: z.string(),
    dueAt: z.string().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      opportunityId: { type: "string" },
      action: { type: "string", description: "Short imperative, e.g. 'Send availability for next week'." },
      dueAt: { type: "string", description: "ISO 8601 date/time it's due, if there is a deadline." },
    },
    required: ["opportunityId", "action"],
  },
  summarize: (input) => `Set next action: ${input.action}`,
  run: async (input, ctx) => {
    const owned = await prisma.opportunity.findFirst({
      where: { id: input.opportunityId, userId: ctx.userId },
    });
    if (!owned) return { error: "Opportunity not found" };

    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    await setNextAction({
      opportunityId: input.opportunityId,
      action: input.action,
      dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null,
      actor: { type: "ASSISTANT" },
    });
    return { ok: true };
  },
});

tool({
  name: "move_stage",
  description:
    "Move a process to a different stage, or advance it by one. Call this when the user tells you something happened that the tracker doesn't know about yet — 'I did the phone screen yesterday', 'they invited me onsite'. Prefer naming the stage explicitly when they said which one.",
  schema: z.object({
    opportunityId: z.string(),
    stageKey: z.string().optional(),
    advance: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      opportunityId: { type: "string" },
      stageKey: {
        type: "string",
        description: "Key of the target stage, from get_opportunity's stages list.",
      },
      advance: { type: "boolean", description: "Set true to just move to the next stage." },
      reason: { type: "string", description: "What the user told you that caused this." },
    },
    required: ["opportunityId"],
  },
  summarize: (input) => (input.advance ? "Advanced the process" : `Moved to ${input.stageKey}`),
  run: async (input, ctx) => {
    const owned = await prisma.opportunity.findFirst({
      where: { id: input.opportunityId, userId: ctx.userId },
    });
    if (!owned) return { error: "Opportunity not found" };

    const actor = { type: "ASSISTANT" as const };
    const result = input.stageKey
      ? await moveToStage({
          opportunityId: input.opportunityId,
          target: { stageKey: input.stageKey },
          actor,
          reason: input.reason,
        })
      : await advanceStage({
          opportunityId: input.opportunityId,
          actor,
          reason: input.reason,
        });

    return result.moved
      ? { ok: true, nowOn: result.stage?.name }
      : { ok: false, why: result.reason };
  },
});

tool({
  name: "add_note",
  description:
    "Save something the user told you onto a process's record — interviewer names, what they asked, salary numbers, a gut feeling. Call this when they share a detail worth having later; conversation history is not the record, the process is.",
  schema: z.object({ opportunityId: z.string(), body: z.string() }),
  inputSchema: {
    type: "object",
    properties: {
      opportunityId: { type: "string" },
      body: { type: "string", description: "The note, in the user's own framing." },
    },
    required: ["opportunityId", "body"],
  },
  summarize: () => "Saved a note",
  run: async (input, ctx) => {
    const owned = await prisma.opportunity.findFirst({
      where: { id: input.opportunityId, userId: ctx.userId },
    });
    if (!owned) return { error: "Opportunity not found" };

    await prisma.note.create({
      data: { userId: ctx.userId, opportunityId: input.opportunityId, body: input.body },
    });
    await logActivity({
      userId: ctx.userId,
      opportunityId: input.opportunityId,
      type: "NOTE_ADDED",
      title: "Note added by the assistant",
      body: input.body.slice(0, 300),
      actorType: "ASSISTANT",
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Technical challenges
// ---------------------------------------------------------------------------

tool({
  name: "set_challenge_requirements",
  description:
    "Break a take-home brief into an explicit, checkable requirement list, replacing whatever is there. Call this as soon as a brief is available — take-homes are failed on requirements stated in passing in paragraph four, so pull out every deliverable, constraint, and evaluation criterion, marking which are explicitly optional.",
  schema: z.object({
    challengeId: z.string(),
    requirements: z.array(
      z.object({ text: z.string(), mustHave: z.boolean().optional() }),
    ),
  }),
  inputSchema: {
    type: "object",
    properties: {
      challengeId: { type: "string" },
      requirements: {
        type: "array",
        description: "In the order the brief presents them.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "One checkable requirement." },
            mustHave: {
              type: "boolean",
              description: "False only when the brief calls it optional or a bonus.",
            },
          },
          required: ["text"],
        },
      },
    },
    required: ["challengeId", "requirements"],
  },
  summarize: (input) => `Extracted ${input.requirements.length} requirements`,
  run: async (input, ctx) => {
    const challenge = await prisma.challenge.findFirst({
      where: { id: input.challengeId, userId: ctx.userId },
    });
    if (!challenge) return { error: "Challenge not found" };

    await prisma.challengeRequirement.deleteMany({
      where: { challengeId: challenge.id, fromBrief: true },
    });
    await prisma.challengeRequirement.createMany({
      data: input.requirements.map((r, index) => ({
        challengeId: challenge.id,
        text: r.text,
        mustHave: r.mustHave ?? true,
        position: index,
        fromBrief: true,
      })),
    });

    await logActivity({
      userId: ctx.userId,
      opportunityId: challenge.opportunityId,
      type: "CHALLENGE_UPDATED",
      title: `Requirements extracted for "${challenge.title}"`,
      body: `${input.requirements.length} items.`,
      actorType: "ASSISTANT",
    });

    return { ok: true, count: input.requirements.length };
  },
});

tool({
  name: "set_challenge_plan",
  description:
    "Save a concrete plan of attack for a technical challenge, replacing any previous one. Call this once you understand the brief. Write it as ordered steps the user can work through, sized against the deadline, calling out what to build first and what to cut if time runs short.",
  schema: z.object({
    challengeId: z.string(),
    plan: z.string(),
    estimatedHours: z.number().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      challengeId: { type: "string" },
      plan: { type: "string", description: "Markdown. Ordered steps, with a suggested cut line." },
      estimatedHours: { type: "number", description: "Realistic total hours." },
    },
    required: ["challengeId", "plan"],
  },
  summarize: () => "Wrote a plan for the challenge",
  run: async (input, ctx) => {
    const challenge = await prisma.challenge.findFirst({
      where: { id: input.challengeId, userId: ctx.userId },
    });
    if (!challenge) return { error: "Challenge not found" };

    await prisma.challenge.update({
      where: { id: challenge.id },
      data: {
        plan: input.plan,
        estimatedHours: input.estimatedHours ?? challenge.estimatedHours,
        status: challenge.status === "NOT_STARTED" ? "PLANNING" : challenge.status,
      },
    });

    await logActivity({
      userId: ctx.userId,
      opportunityId: challenge.opportunityId,
      type: "CHALLENGE_UPDATED",
      title: `Plan saved for "${challenge.title}"`,
      actorType: "ASSISTANT",
    });

    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function toolDefinitions(): Anthropic.Tool[] {
  return registry.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export type ToolRun = {
  name: string;
  summary: string;
  result: unknown;
  isError: boolean;
};

/** Validates and executes one tool call. Errors come back as tool results. */
export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolRun> {
  const def = registry.find((t) => t.name === name);
  if (!def) {
    return { name, summary: `Unknown tool ${name}`, result: { error: `No tool named ${name}` }, isError: true };
  }

  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      name,
      summary: `Invalid input for ${name}`,
      result: {
        error: (parsed.error.issues as z.ZodIssue[])
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      isError: true,
    };
  }

  try {
    const result = await def.run(parsed.data, ctx);
    return { name, summary: def.summarize(parsed.data), result, isError: false };
  } catch (err) {
    return {
      name,
      summary: `${name} failed`,
      result: { error: err instanceof Error ? err.message : "Tool failed" },
      isError: true,
    };
  }
}
