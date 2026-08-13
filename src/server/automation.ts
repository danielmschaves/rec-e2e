import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import {
  advanceStage,
  completeCurrentStage,
  moveToStage,
  setOpportunityStatus,
  setNextAction,
} from "@/server/opportunities";
import type {
  AutomationRule,
  RuleTrigger,
  StageType,
  Opportunity,
  OpportunityStage,
} from "@prisma/client";
import { z } from "zod";

/**
 * The automation engine.
 *
 * Sync adapters never touch stages directly. They emit a typed event here, and
 * rules decide what it means. That keeps "what Google told us" separate from
 * "what that means for my process", so you can retune behaviour on the
 * Automations page without a code change.
 */

export const conditionsSchema = z
  .object({
    /** Any of these substrings must appear in the subject / event title / file name. */
    titleContains: z.array(z.string()).optional(),
    /** Any of these substrings must appear in the body / description. */
    bodyContains: z.array(z.string()).optional(),
    /** Restrict to opportunities sitting on one of these stage types. */
    currentStageType: z.array(z.string()).optional(),
    /** Restrict to opportunities sitting on one of these stage keys. */
    currentStageKey: z.array(z.string()).optional(),
    /** Restrict by file mime type substring, e.g. ["pdf"]. */
    mimeTypeContains: z.array(z.string()).optional(),
    /** Only fire when the opportunity is in one of these statuses. */
    opportunityStatus: z.array(z.string()).optional(),
  })
  .strict()
  .default({});

export const configSchema = z
  .object({
    stageKey: z.string().optional(),
    stageType: z.string().optional(),
    status: z
      .enum(["ACTIVE", "ON_HOLD", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED"])
      .optional(),
    message: z.string().optional(),
    nextAction: z.string().optional(),
  })
  .strict()
  .default({});

export type RuleEventPayload = {
  /** Subject, event title, or file name. */
  title?: string | null;
  /** Body text or event description. */
  body?: string | null;
  fromEmail?: string | null;
  mimeType?: string | null;
  /** Provenance id (gmail id, event id, file id) for the timeline. */
  externalId?: string | null;
  occurredAt?: Date;
};

export type RuleEvent = {
  userId: string;
  opportunityId: string;
  trigger: RuleTrigger;
  payload: RuleEventPayload;
};

type LoadedOpportunity = Opportunity & { currentStage: OpportunityStage | null };

function anyMatch(haystack: string | null | undefined, needles?: string[]): boolean {
  if (!needles || needles.length === 0) return true;
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function matchesConditions(
  rule: AutomationRule,
  opportunity: LoadedOpportunity,
  payload: RuleEventPayload,
): boolean {
  const parsed = conditionsSchema.safeParse(rule.conditions ?? {});
  if (!parsed.success) return false;
  const c = parsed.data;

  const allowedStatuses = c.opportunityStatus ?? ["ACTIVE", "ON_HOLD", "OFFER"];
  if (!allowedStatuses.includes(opportunity.status)) return false;

  if (!anyMatch(payload.title, c.titleContains)) return false;
  if (!anyMatch(payload.body, c.bodyContains)) return false;
  if (!anyMatch(payload.mimeType, c.mimeTypeContains)) return false;

  if (c.currentStageType && c.currentStageType.length > 0) {
    if (
      !opportunity.currentStage ||
      !c.currentStageType.includes(opportunity.currentStage.type)
    ) {
      return false;
    }
  }

  if (c.currentStageKey && c.currentStageKey.length > 0) {
    if (
      !opportunity.currentStage ||
      !c.currentStageKey.includes(opportunity.currentStage.key)
    ) {
      return false;
    }
  }

  return true;
}

export type RuleOutcome = {
  ruleId: string;
  ruleName: string;
  applied: boolean;
  detail: string;
};

async function runAction(
  rule: AutomationRule,
  opportunity: LoadedOpportunity,
  payload: RuleEventPayload,
): Promise<RuleOutcome> {
  const cfgParsed = configSchema.safeParse(rule.config ?? {});
  const cfg = cfgParsed.success ? cfgParsed.data : {};
  const actor = { type: "AUTOMATION" as const, ruleId: rule.id };
  const base = { ruleId: rule.id, ruleName: rule.name };

  switch (rule.action) {
    case "ADVANCE_STAGE": {
      const res = await advanceStage({
        opportunityId: opportunity.id,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return {
        ...base,
        applied: res.moved,
        detail: res.moved ? `Advanced to ${res.stage?.name}` : res.reason ?? "No move",
      };
    }

    case "SET_STAGE": {
      if (!cfg.stageKey && !cfg.stageType) {
        return { ...base, applied: false, detail: "Rule has no target stage configured" };
      }
      const res = await moveToStage({
        opportunityId: opportunity.id,
        target: {
          stageKey: cfg.stageKey,
          stageType: cfg.stageType as StageType | undefined,
        },
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return {
        ...base,
        applied: res.moved,
        detail: res.moved ? `Moved to ${res.stage?.name}` : res.reason ?? "No move",
      };
    }

    case "COMPLETE_CURRENT_STAGE": {
      const done = await completeCurrentStage({
        opportunityId: opportunity.id,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return {
        ...base,
        applied: done,
        detail: done ? "Marked the current stage complete" : "No active stage",
      };
    }

    case "SET_OPPORTUNITY_STATUS": {
      if (!cfg.status) {
        return { ...base, applied: false, detail: "Rule has no status configured" };
      }
      await setOpportunityStatus({
        opportunityId: opportunity.id,
        status: cfg.status,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return { ...base, applied: true, detail: `Status set to ${cfg.status}` };
    }

    case "SET_NEXT_ACTION": {
      if (!cfg.nextAction) {
        return { ...base, applied: false, detail: "Rule has no next action configured" };
      }
      await setNextAction({
        opportunityId: opportunity.id,
        action: cfg.nextAction,
        actor,
      });
      return { ...base, applied: true, detail: `Next action: ${cfg.nextAction}` };
    }

    case "FLAG_FOR_REVIEW": {
      await logActivity({
        userId: opportunity.userId,
        opportunityId: opportunity.id,
        type: "FLAGGED",
        title: cfg.message ?? `Flagged by "${rule.name}"`,
        body: payload.title ?? null,
        actorType: "AUTOMATION",
        externalId: payload.externalId ?? null,
      });
      return { ...base, applied: true, detail: "Flagged for review" };
    }

    case "LOG_ACTIVITY":
    default: {
      await logActivity({
        userId: opportunity.userId,
        opportunityId: opportunity.id,
        type: "SYNC",
        title: cfg.message ?? rule.name,
        body: payload.title ?? null,
        actorType: "AUTOMATION",
        externalId: payload.externalId ?? null,
      });
      return { ...base, applied: true, detail: "Logged to timeline" };
    }
  }
}

/**
 * Evaluates every enabled rule for a trigger, in priority order, and runs the
 * first that matches. Stopping at the first match keeps outcomes predictable —
 * two rules cannot fight over the same event.
 */
export async function dispatchEvent(event: RuleEvent): Promise<RuleOutcome[]> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: event.opportunityId },
    include: { currentStage: true },
  });
  if (!opportunity) return [];

  const rules = await prisma.automationRule.findMany({
    where: { userId: event.userId, trigger: event.trigger, enabled: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  const outcomes: RuleOutcome[] = [];

  for (const rule of rules) {
    if (!matchesConditions(rule, opportunity as LoadedOpportunity, event.payload)) continue;

    const outcome = await runAction(rule, opportunity as LoadedOpportunity, event.payload);
    outcomes.push(outcome);

    await prisma.automationRule.update({
      where: { id: rule.id },
      data: { timesFired: { increment: 1 }, lastFiredAt: new Date() },
    });

    // First matching rule wins for this trigger.
    break;
  }

  return outcomes;
}

/**
 * Flags processes that have gone quiet past the stage's chase-after window —
 * the "should I nudge them?" signal. Run on a schedule by the worker.
 */
export async function checkQuietStages(userId: string): Promise<number> {
  const now = new Date();
  const quiet = await prisma.opportunity.findMany({
    where: {
      userId,
      status: { in: ["ACTIVE", "OFFER"] },
      currentStage: { chaseAt: { lt: now }, status: "ACTIVE" },
    },
    include: { currentStage: true, company: true },
  });

  let fired = 0;
  for (const opportunity of quiet) {
    if (!opportunity.currentStage) continue;

    // Only flag once per stage entry.
    const already = await prisma.activity.findFirst({
      where: {
        opportunityId: opportunity.id,
        type: "FLAGGED",
        occurredAt: { gte: opportunity.currentStage.enteredAt ?? opportunity.createdAt },
      },
    });
    if (already) continue;

    await logActivity({
      userId,
      opportunityId: opportunity.id,
      type: "FLAGGED",
      title: `${opportunity.company.name} has gone quiet`,
      body: `No movement on ${opportunity.currentStage.name} for ${opportunity.currentStage.chaseAfterDays} days — worth a nudge.`,
      actorType: "AUTOMATION",
    });

    await dispatchEvent({
      userId,
      opportunityId: opportunity.id,
      trigger: "STAGE_WENT_QUIET",
      payload: { title: opportunity.currentStage.name, occurredAt: now },
    });

    fired++;
  }

  return fired;
}
