import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import {
  advanceStage,
  completeCurrentStage,
  moveToStage,
  setApplicationStatus,
} from "@/server/applications";
import type {
  AutomationRule,
  RuleTrigger,
  StageType,
  Application,
  ApplicationStage,
} from "@prisma/client";
import { z } from "zod";

/**
 * The automation engine.
 *
 * Sync adapters never touch stages directly. They emit a typed event here, and
 * rules decide what it means. That keeps "what Google told us" separate from
 * "what our process does about it", so a customer can retune the process
 * without a code change.
 */

export const conditionsSchema = z
  .object({
    /** Any of these substrings must appear in the subject / event title / file name. */
    titleContains: z.array(z.string()).optional(),
    /** Any of these substrings must appear in the body / description. */
    bodyContains: z.array(z.string()).optional(),
    /** Restrict to applications currently sitting on one of these stage types. */
    currentStageType: z.array(z.string()).optional(),
    /** Restrict to applications currently sitting on one of these stage keys. */
    currentStageKey: z.array(z.string()).optional(),
    /** Restrict by the sender's domain, e.g. ["gmail.com"]. */
    fromDomain: z.array(z.string()).optional(),
    /** Restrict by file mime type substring, e.g. ["pdf"]. */
    mimeTypeContains: z.array(z.string()).optional(),
    /** Only fire when the application is in this status (default: ACTIVE only). */
    applicationStatus: z.array(z.string()).optional(),
  })
  .strict()
  .default({});

export const configSchema = z
  .object({
    stageKey: z.string().optional(),
    stageType: z.string().optional(),
    status: z
      .enum(["ACTIVE", "ON_HOLD", "HIRED", "REJECTED", "WITHDRAWN"])
      .optional(),
    message: z.string().optional(),
    fileKind: z.string().optional(),
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
  orgId: string;
  applicationId: string;
  trigger: RuleTrigger;
  payload: RuleEventPayload;
};

type LoadedApplication = Application & {
  currentStage: ApplicationStage | null;
  job: { id: string; pipelineId: string; title: string };
};

function anyMatch(haystack: string | null | undefined, needles?: string[]): boolean {
  if (!needles || needles.length === 0) return true;
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function matchesConditions(
  rule: AutomationRule,
  app: LoadedApplication,
  payload: RuleEventPayload,
): boolean {
  const parsed = conditionsSchema.safeParse(rule.conditions ?? {});
  if (!parsed.success) return false;
  const c = parsed.data;

  const allowedStatuses = c.applicationStatus ?? ["ACTIVE"];
  if (!allowedStatuses.includes(app.status)) return false;

  if (!anyMatch(payload.title, c.titleContains)) return false;
  if (!anyMatch(payload.body, c.bodyContains)) return false;
  if (!anyMatch(payload.mimeType, c.mimeTypeContains)) return false;

  if (c.fromDomain && c.fromDomain.length > 0) {
    const domain = payload.fromEmail?.split("@")[1]?.toLowerCase();
    if (!domain || !c.fromDomain.some((d) => domain.endsWith(d.toLowerCase()))) {
      return false;
    }
  }

  if (c.currentStageType && c.currentStageType.length > 0) {
    if (!app.currentStage || !c.currentStageType.includes(app.currentStage.type)) {
      return false;
    }
  }

  if (c.currentStageKey && c.currentStageKey.length > 0) {
    if (!app.currentStage || !c.currentStageKey.includes(app.currentStage.key)) {
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
  app: LoadedApplication,
  payload: RuleEventPayload,
): Promise<RuleOutcome> {
  const cfgParsed = configSchema.safeParse(rule.config ?? {});
  const cfg = cfgParsed.success ? cfgParsed.data : {};
  const actor = { type: "AUTOMATION" as const, ruleId: rule.id };
  const base = { ruleId: rule.id, ruleName: rule.name };

  switch (rule.action) {
    case "ADVANCE_STAGE": {
      const res = await advanceStage({
        applicationId: app.id,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return {
        ...base,
        applied: res.moved,
        detail: res.moved
          ? `Advanced to ${res.stage?.name}`
          : res.reason ?? "No move",
      };
    }

    case "SET_STAGE": {
      if (!cfg.stageKey && !cfg.stageType) {
        return { ...base, applied: false, detail: "Rule has no target stage configured" };
      }
      const res = await moveToStage({
        applicationId: app.id,
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
        detail: res.moved
          ? `Moved to ${res.stage?.name}`
          : res.reason ?? "No move",
      };
    }

    case "COMPLETE_CURRENT_STAGE": {
      const done = await completeCurrentStage({
        applicationId: app.id,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return {
        ...base,
        applied: done,
        detail: done ? "Marked current stage complete" : "No active stage",
      };
    }

    case "SET_APPLICATION_STATUS": {
      if (!cfg.status) {
        return { ...base, applied: false, detail: "Rule has no status configured" };
      }
      await setApplicationStatus({
        applicationId: app.id,
        status: cfg.status,
        actor,
        reason: `Automation: ${rule.name}`,
      });
      return { ...base, applied: true, detail: `Status set to ${cfg.status}` };
    }

    case "FLAG_FOR_REVIEW": {
      await logActivity({
        orgId: app.orgId,
        applicationId: app.id,
        candidateId: app.candidateId,
        type: "FLAGGED",
        title: cfg.message ?? `Flagged by "${rule.name}"`,
        body: payload.title ?? null,
        actorType: "AUTOMATION",
        externalId: payload.externalId ?? null,
      });
      return { ...base, applied: true, detail: "Flagged for review" };
    }

    case "LOG_ACTIVITY":
    case "ATTACH_TO_APPLICATION":
    default: {
      await logActivity({
        orgId: app.orgId,
        applicationId: app.id,
        candidateId: app.candidateId,
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
 * first one that matches. Stopping at the first match keeps outcomes
 * predictable — two rules cannot fight over the same event.
 */
export async function dispatchEvent(event: RuleEvent): Promise<RuleOutcome[]> {
  const app = await prisma.application.findUnique({
    where: { id: event.applicationId },
    include: {
      currentStage: true,
      job: { select: { id: true, pipelineId: true, title: true } },
    },
  });
  if (!app) return [];

  const rules = await prisma.automationRule.findMany({
    where: {
      orgId: event.orgId,
      trigger: event.trigger,
      enabled: true,
      OR: [{ jobId: null }, { jobId: app.jobId }],
      AND: [{ OR: [{ pipelineId: null }, { pipelineId: app.job.pipelineId }] }],
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  const outcomes: RuleOutcome[] = [];

  for (const rule of rules) {
    if (!matchesConditions(rule, app as LoadedApplication, event.payload)) continue;

    const outcome = await runAction(rule, app as LoadedApplication, event.payload);
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
 * Flags applications that have sat in a stage past its SLA. Run on a schedule
 * by the worker.
 */
export async function checkStageSlas(orgId: string): Promise<number> {
  const now = new Date();
  const overdue = await prisma.application.findMany({
    where: {
      orgId,
      status: "ACTIVE",
      currentStage: { dueAt: { lt: now }, status: "ACTIVE" },
    },
    include: { currentStage: true },
  });

  let fired = 0;
  for (const app of overdue) {
    if (!app.currentStage) continue;

    // Only flag once per stage entry — look for an existing flag raised after
    // the application entered this stage.
    const already = await prisma.activity.findFirst({
      where: {
        applicationId: app.id,
        type: "FLAGGED",
        occurredAt: { gte: app.currentStage.enteredAt ?? app.createdAt },
      },
    });
    if (already) continue;

    await logActivity({
      orgId,
      applicationId: app.id,
      candidateId: app.candidateId,
      type: "FLAGGED",
      title: `Stalled in ${app.currentStage.name}`,
      body: `Past its ${app.currentStage.slaDays}-day target.`,
      actorType: "AUTOMATION",
    });

    await dispatchEvent({
      orgId,
      applicationId: app.id,
      trigger: "STAGE_SLA_BREACHED",
      payload: { title: app.currentStage.name, occurredAt: now },
    });

    fired++;
  }

  return fired;
}
