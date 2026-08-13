import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import type {
  ActorType,
  Opportunity,
  OpportunityStage,
  StageType,
} from "@prisma/client";

export type Actor = { type: ActorType; ruleId?: string | null };

const SYSTEM_ACTOR: Actor = { type: "SYSTEM" };

/** Days added to `chaseAt` when a stage says how long to wait before nudging. */
function chaseDateFrom(from: Date, days: number | null | undefined): Date | null {
  if (!days) return null;
  const due = new Date(from);
  due.setDate(due.getDate() + days);
  return due;
}

/**
 * Starts tracking an opportunity, materialising the chosen template into
 * per-opportunity stages. The first stage is activated immediately.
 */
export async function createOpportunity(params: {
  userId: string;
  companyId: string;
  templateId: string;
  roleTitle: string;
  actor?: Actor;
  details?: Partial<
    Pick<
      Opportunity,
      | "location"
      | "workMode"
      | "jobPostUrl"
      | "source"
      | "salaryMin"
      | "salaryMax"
      | "priority"
      | "excitement"
    >
  >;
}): Promise<Opportunity> {
  const { userId, companyId, templateId, roleTitle } = params;
  const actor = params.actor ?? SYSTEM_ACTOR;

  const template = await prisma.processTemplate.findFirst({
    where: { id: templateId, userId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!template) throw new Error("Process template not found");
  if (template.stages.length === 0) {
    throw new Error("That flow has no stages — add stages before using it");
  }

  const company = await prisma.company.findFirst({
    where: { id: companyId, userId },
  });
  if (!company) throw new Error("Company not found");

  const existing = await prisma.opportunity.findUnique({
    where: { userId_companyId_roleTitle: { userId, companyId, roleTitle } },
  });
  if (existing) return existing;

  const now = new Date();

  const opportunity = await prisma.$transaction(async (tx) => {
    const created = await tx.opportunity.create({
      data: {
        userId,
        companyId,
        templateId,
        roleTitle,
        appliedAt: now,
        lastActivityAt: now,
        ...params.details,
      },
    });

    await tx.opportunityStage.createMany({
      data: template.stages.map((stage, index) => ({
        opportunityId: created.id,
        templateStageId: stage.id,
        name: stage.name,
        key: stage.key,
        type: stage.type,
        position: index,
        chaseAfterDays: stage.chaseAfterDays,
        status: index === 0 ? ("ACTIVE" as const) : ("PENDING" as const),
        enteredAt: index === 0 ? now : null,
        chaseAt: index === 0 ? chaseDateFrom(now, stage.chaseAfterDays) : null,
      })),
    });

    const first = await tx.opportunityStage.findFirst({
      where: { opportunityId: created.id },
      orderBy: { position: "asc" },
    });

    const withStage = await tx.opportunity.update({
      where: { id: created.id },
      data: { currentStageId: first?.id ?? null },
    });

    if (first) {
      await tx.stageTransition.create({
        data: {
          opportunityId: created.id,
          toStageId: first.id,
          actorType: actor.type,
          reason: "Started tracking",
        },
      });
    }

    return withStage;
  });

  await logActivity({
    userId,
    opportunityId: opportunity.id,
    type: "OPPORTUNITY_CREATED",
    title: `Started tracking ${roleTitle} at ${company.name}`,
    body: `Using the "${template.name}" flow (${template.stages.length} stages).`,
    actorType: actor.type,
  });

  return opportunity;
}

export type StageRef = { stageId?: string; stageKey?: string; stageType?: StageType };

async function resolveStage(
  opportunityId: string,
  ref: StageRef,
): Promise<OpportunityStage | null> {
  if (ref.stageId) {
    return prisma.opportunityStage.findFirst({
      where: { id: ref.stageId, opportunityId },
    });
  }
  if (ref.stageKey) {
    return prisma.opportunityStage.findUnique({
      where: { opportunityId_key: { opportunityId, key: ref.stageKey } },
    });
  }
  if (ref.stageType) {
    return prisma.opportunityStage.findFirst({
      where: { opportunityId, type: ref.stageType },
      orderBy: { position: "asc" },
    });
  }
  return null;
}

/**
 * Moves an opportunity to a specific stage.
 *
 * Stages before the target that are still PENDING/ACTIVE are marked COMPLETED
 * when moving forward, and reset to PENDING when moving backward, so the
 * tracker always reads coherently regardless of how the jump happened.
 */
export async function moveToStage(params: {
  opportunityId: string;
  target: StageRef;
  actor?: Actor;
  reason?: string;
}): Promise<{ moved: boolean; stage?: OpportunityStage; reason?: string }> {
  const actor = params.actor ?? SYSTEM_ACTOR;

  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { stages: { orderBy: { position: "asc" } }, company: true },
  });
  if (!opportunity) return { moved: false, reason: "Opportunity not found" };
  if (opportunity.status !== "ACTIVE" && opportunity.status !== "ON_HOLD") {
    return { moved: false, reason: `This process is ${opportunity.status}` };
  }

  const target = await resolveStage(opportunity.id, params.target);
  if (!target) return { moved: false, reason: "Target stage not found" };
  if (target.status === "SKIPPED") {
    return { moved: false, reason: "That stage was skipped for this company" };
  }
  if (opportunity.currentStageId === target.id) {
    return { moved: false, reason: "Already on that stage" };
  }

  const from = opportunity.stages.find((s) => s.id === opportunity.currentStageId);
  const movingForward = !from || target.position > from.position;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (movingForward) {
      // Close out everything we are jumping over, leaving SKIPPED as-is.
      await tx.opportunityStage.updateMany({
        where: {
          opportunityId: opportunity.id,
          position: { lt: target.position },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: { status: "COMPLETED", completedAt: now },
      });
    } else {
      // Rewinding: reopen anything after the target.
      await tx.opportunityStage.updateMany({
        where: {
          opportunityId: opportunity.id,
          position: { gt: target.position },
          status: { in: ["COMPLETED", "ACTIVE"] },
        },
        data: { status: "PENDING", completedAt: null, enteredAt: null },
      });
    }

    await tx.opportunityStage.update({
      where: { id: target.id },
      data: {
        status: "ACTIVE",
        enteredAt: now,
        completedAt: null,
        chaseAt: chaseDateFrom(now, target.chaseAfterDays),
      },
    });

    await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { currentStageId: target.id, lastActivityAt: now },
    });

    await tx.stageTransition.create({
      data: {
        opportunityId: opportunity.id,
        fromStageId: from?.id ?? null,
        toStageId: target.id,
        actorType: actor.type,
        ruleId: actor.ruleId ?? null,
        reason: params.reason ?? null,
      },
    });
  });

  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STAGE_CHANGED",
    title: from
      ? `${opportunity.company.name}: ${from.name} → ${target.name}`
      : `${opportunity.company.name}: moved to ${target.name}`,
    body: params.reason ?? null,
    actorType: actor.type,
    meta: { fromStage: from?.key ?? null, toStage: target.key },
  });

  // Reaching a terminal stage settles the opportunity itself.
  if (target.type === "ACCEPTED") {
    await setOpportunityStatus({
      opportunityId: opportunity.id,
      status: "ACCEPTED",
      actor,
    });
  } else if (target.type === "REJECTED") {
    await setOpportunityStatus({
      opportunityId: opportunity.id,
      status: "REJECTED",
      actor,
      reason: params.reason,
    });
  } else if (target.type === "OFFER") {
    await setOpportunityStatus({
      opportunityId: opportunity.id,
      status: "OFFER",
      actor,
    });
  }

  const updated = await prisma.opportunityStage.findUnique({ where: { id: target.id } });
  return { moved: true, stage: updated ?? target };
}

/** Completes the current stage and activates the next non-skipped one. */
export async function advanceStage(params: {
  opportunityId: string;
  actor?: Actor;
  reason?: string;
}): Promise<{ moved: boolean; stage?: OpportunityStage; reason?: string }> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!opportunity) return { moved: false, reason: "Opportunity not found" };

  const current = opportunity.stages.find((s) => s.id === opportunity.currentStageId);
  const next = opportunity.stages.find(
    (s) => s.status !== "SKIPPED" && (current ? s.position > current.position : true),
  );
  if (!next) return { moved: false, reason: "Already at the final stage" };

  return moveToStage({
    opportunityId: params.opportunityId,
    target: { stageId: next.id },
    actor: params.actor,
    reason: params.reason,
  });
}

export async function completeCurrentStage(params: {
  opportunityId: string;
  actor?: Actor;
  reason?: string;
}): Promise<boolean> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { currentStage: true, company: true },
  });
  if (!opportunity?.currentStage) return false;
  if (opportunity.currentStage.status === "COMPLETED") return false;

  await prisma.opportunityStage.update({
    where: { id: opportunity.currentStage.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STAGE_COMPLETED",
    title: `${opportunity.currentStage.name} done at ${opportunity.company.name}`,
    body: params.reason ?? null,
    actorType: actor.type,
  });

  return true;
}

export async function setOpportunityStatus(params: {
  opportunityId: string;
  status: "ACTIVE" | "ON_HOLD" | "OFFER" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | "GHOSTED";
  actor?: Actor;
  reason?: string;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const closed = ["ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED"].includes(params.status);

  const opportunity = await prisma.opportunity.update({
    where: { id: params.opportunityId },
    data: {
      status: params.status,
      closeReason: closed ? params.reason ?? null : null,
      closedAt: closed ? new Date() : null,
      lastActivityAt: new Date(),
    },
    include: { company: true },
  });

  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STATUS_CHANGED",
    title: `${opportunity.company.name} marked ${params.status.toLowerCase().replace("_", " ")}`,
    body: params.reason ?? null,
    actorType: actor.type,
  });
}

/** Sets the "what do I owe them next" prompt shown on the dashboard. */
export async function setNextAction(params: {
  opportunityId: string;
  action: string | null;
  dueAt?: Date | null;
  actor?: Actor;
}): Promise<void> {
  await prisma.opportunity.update({
    where: { id: params.opportunityId },
    data: { nextAction: params.action, nextActionAt: params.dueAt ?? null },
  });
}

// ---------------------------------------------------------------------------
// Progressive personalization
//
// These operate purely on OpportunityStage rows, never on the template. Any of
// them flips the opportunity to PERSONALIZED so the UI can show that this
// company's process has diverged from your standard flow.
// ---------------------------------------------------------------------------

async function markPersonalized(opportunityId: string) {
  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { flowMode: "PERSONALIZED", lastActivityAt: new Date() },
  });
}

function slugifyKey(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "stage"
  );
}

/** Inserts a stage that exists only for this company's process. */
export async function addCustomStage(params: {
  opportunityId: string;
  name: string;
  type?: StageType;
  /** Insert after this stage; defaults to before the terminal stages. */
  afterStageId?: string | null;
  chaseAfterDays?: number | null;
  actor?: Actor;
}): Promise<OpportunityStage> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!opportunity) throw new Error("Opportunity not found");

  const after = params.afterStageId
    ? opportunity.stages.find((s) => s.id === params.afterStageId)
    : null;

  // Default placement is *before* the terminal stages — a new step in the
  // process never belongs after "Accepted"/"Rejected".
  const firstTerminal = opportunity.stages.find(
    (s) => s.type === "ACCEPTED" || s.type === "REJECTED",
  );
  const insertAt = after
    ? after.position + 1
    : firstTerminal
      ? firstTerminal.position
      : (opportunity.stages.at(-1)?.position ?? -1) + 1;

  // Keys are unique per opportunity; de-duplicate by suffixing.
  const base = slugifyKey(params.name);
  const taken = new Set(opportunity.stages.map((s) => s.key));
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;

  const stage = await prisma.$transaction(async (tx) => {
    // Shift later stages down, descending so positions never collide.
    const toShift = opportunity.stages
      .filter((s) => s.position >= insertAt)
      .sort((a, b) => b.position - a.position);
    for (const s of toShift) {
      await tx.opportunityStage.update({
        where: { id: s.id },
        data: { position: s.position + 1 },
      });
    }

    return tx.opportunityStage.create({
      data: {
        opportunityId: params.opportunityId,
        name: params.name,
        key,
        type: params.type ?? "CUSTOM",
        position: insertAt,
        chaseAfterDays: params.chaseAfterDays ?? null,
        isCustom: true,
        status: "PENDING",
      },
    });
  });

  await markPersonalized(params.opportunityId);
  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STAGE_CHANGED",
    title: `Added "${params.name}" to this process`,
    body: "This flow now differs from your standard template.",
    actorType: actor.type,
  });

  return stage;
}

/**
 * Skips a stage for this process. Skipping is preferred over deleting: the
 * stage stays visible in the tracker, greyed out, so the history stays honest.
 */
export async function skipStage(params: {
  opportunityId: string;
  stageId: string;
  actor?: Actor;
  reason?: string;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!opportunity) throw new Error("Opportunity not found");

  const stage = opportunity.stages.find((s) => s.id === params.stageId);
  if (!stage) throw new Error("Stage not found");

  await prisma.opportunityStage.update({
    where: { id: stage.id },
    data: { status: "SKIPPED", notes: params.reason ?? stage.notes },
  });

  // If we just skipped the stage you were sitting on, move along.
  if (opportunity.currentStageId === stage.id) {
    const next = opportunity.stages.find(
      (s) => s.position > stage.position && s.status !== "SKIPPED",
    );
    if (next) {
      await moveToStage({
        opportunityId: opportunity.id,
        target: { stageId: next.id },
        actor,
        reason: `Skipped ${stage.name}`,
      });
    }
  }

  await markPersonalized(params.opportunityId);
  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STAGE_CHANGED",
    title: `Skipped "${stage.name}"`,
    body: params.reason ?? null,
    actorType: actor.type,
  });
}

/** Un-skips a previously skipped stage. */
export async function restoreStage(params: {
  opportunityId: string;
  stageId: string;
  actor?: Actor;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const stage = await prisma.opportunityStage.findFirst({
    where: { id: params.stageId, opportunityId: params.opportunityId },
    include: { opportunity: true },
  });
  if (!stage) throw new Error("Stage not found");

  await prisma.opportunityStage.update({
    where: { id: stage.id },
    data: { status: "PENDING", notes: null },
  });

  await logActivity({
    userId: stage.opportunity.userId,
    opportunityId: stage.opportunityId,
    type: "STAGE_CHANGED",
    title: `Restored "${stage.name}"`,
    actorType: actor.type,
  });
}

/** Applies a new explicit ordering of stage ids. */
export async function reorderStages(params: {
  opportunityId: string;
  orderedStageIds: string[];
  actor?: Actor;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: params.opportunityId },
    include: { stages: true },
  });
  if (!opportunity) throw new Error("Opportunity not found");

  const known = new Set(opportunity.stages.map((s) => s.id));
  const ordered = params.orderedStageIds.filter((id) => known.has(id));
  // Anything the caller omitted keeps its relative order at the end.
  const missing = opportunity.stages
    .filter((s) => !ordered.includes(s.id))
    .sort((a, b) => a.position - b.position)
    .map((s) => s.id);
  const finalOrder = [...ordered, ...missing];

  await prisma.$transaction(
    finalOrder.map((id, index) =>
      prisma.opportunityStage.update({ where: { id }, data: { position: index } }),
    ),
  );

  await markPersonalized(params.opportunityId);
  await logActivity({
    userId: opportunity.userId,
    opportunityId: opportunity.id,
    type: "STAGE_CHANGED",
    title: "Reordered this process",
    actorType: actor.type,
  });
}
