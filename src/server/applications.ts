import { prisma } from "@/lib/prisma";
import { logActivity } from "@/server/activity";
import type {
  ActorType,
  Application,
  ApplicationStage,
  StageType,
} from "@prisma/client";

export type Actor = {
  type: ActorType;
  id?: string | null;
  ruleId?: string | null;
};

const SYSTEM_ACTOR: Actor = { type: "SYSTEM" };

/** Days added to `dueAt` when a stage carries an SLA. */
function dueDateFrom(from: Date, slaDays: number | null | undefined): Date | null {
  if (!slaDays) return null;
  const due = new Date(from);
  due.setDate(due.getDate() + slaDays);
  return due;
}

/**
 * Creates an application and materialises the job's pipeline template into
 * per-application stages. The first stage is activated immediately.
 */
export async function createApplication(params: {
  orgId: string;
  jobId: string;
  candidateId: string;
  actor?: Actor;
}): Promise<Application> {
  const { orgId, jobId, candidateId } = params;
  const actor = params.actor ?? SYSTEM_ACTOR;

  const job = await prisma.job.findFirst({
    where: { id: jobId, orgId },
    include: { pipeline: { include: { stages: { orderBy: { position: "asc" } } } } },
  });
  if (!job) throw new Error("Job not found");
  if (job.pipeline.stages.length === 0) {
    throw new Error("Pipeline has no stages — add stages before applying candidates");
  }

  const existing = await prisma.application.findUnique({
    where: { jobId_candidateId: { jobId, candidateId } },
  });
  if (existing) return existing;

  const now = new Date();

  const application = await prisma.$transaction(async (tx) => {
    const app = await tx.application.create({
      data: { orgId, jobId, candidateId, appliedAt: now, lastActivityAt: now },
    });

    await tx.applicationStage.createMany({
      data: job.pipeline.stages.map((stage, index) => ({
        applicationId: app.id,
        templateId: stage.id,
        name: stage.name,
        key: stage.key,
        type: stage.type,
        position: index,
        slaDays: stage.slaDays,
        status: index === 0 ? ("ACTIVE" as const) : ("PENDING" as const),
        enteredAt: index === 0 ? now : null,
        dueAt: index === 0 ? dueDateFrom(now, stage.slaDays) : null,
      })),
    });

    const first = await tx.applicationStage.findFirst({
      where: { applicationId: app.id },
      orderBy: { position: "asc" },
    });

    const withStage = await tx.application.update({
      where: { id: app.id },
      data: { currentStageId: first?.id ?? null },
    });

    if (first) {
      await tx.stageTransition.create({
        data: {
          applicationId: app.id,
          fromStageId: null,
          toStageId: first.id,
          actorType: actor.type,
          actorId: actor.id ?? null,
          ruleId: actor.ruleId ?? null,
          reason: "Application created",
        },
      });
    }

    return withStage;
  });

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });

  await logActivity({
    orgId,
    applicationId: application.id,
    candidateId,
    type: "APPLICATION_CREATED",
    title: `${candidate?.fullName ?? "Candidate"} applied to ${job.title}`,
    body: `Flow "${job.pipeline.name}" applied with ${job.pipeline.stages.length} stages.`,
    actorType: actor.type,
    actorId: actor.id ?? null,
  });

  return application;
}

export type StageRef = { stageId?: string; stageKey?: string; stageType?: StageType };

async function resolveStage(
  applicationId: string,
  ref: StageRef,
): Promise<ApplicationStage | null> {
  if (ref.stageId) {
    return prisma.applicationStage.findFirst({
      where: { id: ref.stageId, applicationId },
    });
  }
  if (ref.stageKey) {
    return prisma.applicationStage.findUnique({
      where: { applicationId_key: { applicationId, key: ref.stageKey } },
    });
  }
  if (ref.stageType) {
    return prisma.applicationStage.findFirst({
      where: { applicationId, type: ref.stageType },
      orderBy: { position: "asc" },
    });
  }
  return null;
}

/**
 * Moves an application to a specific stage.
 *
 * Every stage before the target that is still PENDING/ACTIVE is marked
 * COMPLETED when moving forward, and reset to PENDING when moving backward, so
 * the tracker always reads coherently regardless of how the jump happened.
 */
export async function moveToStage(params: {
  applicationId: string;
  target: StageRef;
  actor?: Actor;
  reason?: string;
}): Promise<{ moved: boolean; stage?: ApplicationStage; reason?: string }> {
  const actor = params.actor ?? SYSTEM_ACTOR;

  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { stages: { orderBy: { position: "asc" } }, candidate: true },
  });
  if (!application) return { moved: false, reason: "Application not found" };
  if (application.status !== "ACTIVE") {
    return { moved: false, reason: `Application is ${application.status}` };
  }

  const target = await resolveStage(application.id, params.target);
  if (!target) return { moved: false, reason: "Target stage not found" };
  if (target.status === "SKIPPED") {
    return { moved: false, reason: "Target stage was skipped for this candidate" };
  }
  if (application.currentStageId === target.id) {
    return { moved: false, reason: "Already on that stage" };
  }

  const from = application.stages.find((s) => s.id === application.currentStageId);
  const movingForward = !from || target.position > from.position;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (movingForward) {
      // Close out everything we are jumping over, leaving SKIPPED as-is.
      await tx.applicationStage.updateMany({
        where: {
          applicationId: application.id,
          position: { lt: target.position },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: { status: "COMPLETED", completedAt: now },
      });
    } else {
      // Rewinding: reopen anything after the target.
      await tx.applicationStage.updateMany({
        where: {
          applicationId: application.id,
          position: { gt: target.position },
          status: { in: ["COMPLETED", "ACTIVE"] },
        },
        data: { status: "PENDING", completedAt: null, enteredAt: null },
      });
    }

    await tx.applicationStage.update({
      where: { id: target.id },
      data: {
        status: "ACTIVE",
        enteredAt: now,
        completedAt: null,
        dueAt: dueDateFrom(now, target.slaDays),
      },
    });

    await tx.application.update({
      where: { id: application.id },
      data: { currentStageId: target.id, lastActivityAt: now },
    });

    await tx.stageTransition.create({
      data: {
        applicationId: application.id,
        fromStageId: from?.id ?? null,
        toStageId: target.id,
        actorType: actor.type,
        actorId: actor.id ?? null,
        ruleId: actor.ruleId ?? null,
        reason: params.reason ?? null,
      },
    });
  });

  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STAGE_CHANGED",
    title: from
      ? `Moved from ${from.name} to ${target.name}`
      : `Moved to ${target.name}`,
    body: params.reason ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
    meta: { fromStage: from?.key ?? null, toStage: target.key },
  });

  // Reaching a terminal stage settles the application itself.
  if (target.type === "HIRED") {
    await setApplicationStatus({
      applicationId: application.id,
      status: "HIRED",
      actor,
    });
  } else if (target.type === "REJECTED") {
    await setApplicationStatus({
      applicationId: application.id,
      status: "REJECTED",
      actor,
      reason: params.reason,
    });
  }

  const updated = await prisma.applicationStage.findUnique({ where: { id: target.id } });
  return { moved: true, stage: updated ?? target };
}

/** Completes the current stage and activates the next non-skipped one. */
export async function advanceStage(params: {
  applicationId: string;
  actor?: Actor;
  reason?: string;
}): Promise<{ moved: boolean; stage?: ApplicationStage; reason?: string }> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!application) return { moved: false, reason: "Application not found" };

  const current = application.stages.find((s) => s.id === application.currentStageId);
  const next = application.stages.find(
    (s) =>
      s.status !== "SKIPPED" &&
      (current ? s.position > current.position : true),
  );
  if (!next) return { moved: false, reason: "Already at the final stage" };

  return moveToStage({
    applicationId: params.applicationId,
    target: { stageId: next.id },
    actor: params.actor,
    reason: params.reason,
  });
}

export async function completeCurrentStage(params: {
  applicationId: string;
  actor?: Actor;
  reason?: string;
}): Promise<boolean> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { currentStage: true },
  });
  if (!application?.currentStage) return false;
  if (application.currentStage.status === "COMPLETED") return false;

  await prisma.applicationStage.update({
    where: { id: application.currentStage.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STAGE_COMPLETED",
    title: `${application.currentStage.name} completed`,
    body: params.reason ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
  });

  return true;
}

export async function setApplicationStatus(params: {
  applicationId: string;
  status: "ACTIVE" | "ON_HOLD" | "HIRED" | "REJECTED" | "WITHDRAWN";
  actor?: Actor;
  reason?: string;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const application = await prisma.application.update({
    where: { id: params.applicationId },
    data: {
      status: params.status,
      rejectReason: params.status === "REJECTED" ? params.reason ?? null : null,
      lastActivityAt: new Date(),
    },
  });

  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STATUS_CHANGED",
    title: `Application marked ${params.status.toLowerCase().replace("_", " ")}`,
    body: params.reason ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
  });
}

// ---------------------------------------------------------------------------
// Progressive personalization
//
// These operate purely on ApplicationStage rows, never on the template. Any of
// them flips the application to PERSONALIZED so the UI can show that it has
// diverged from the standard flow.
// ---------------------------------------------------------------------------

async function markPersonalized(applicationId: string) {
  await prisma.application.update({
    where: { id: applicationId },
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

/** Inserts a stage that exists only for this candidate. */
export async function addCustomStage(params: {
  applicationId: string;
  name: string;
  type?: StageType;
  /** Insert after this stage; defaults to the end of the flow. */
  afterStageId?: string | null;
  slaDays?: number | null;
  actor?: Actor;
}): Promise<ApplicationStage> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!application) throw new Error("Application not found");

  const after = params.afterStageId
    ? application.stages.find((s) => s.id === params.afterStageId)
    : null;

  // Default placement is *before* the terminal stages — a new step in the
  // process never belongs after "Hired"/"Rejected".
  const firstTerminal = application.stages.find(
    (s) => s.type === "HIRED" || s.type === "REJECTED",
  );
  const insertAt = after
    ? after.position + 1
    : firstTerminal
      ? firstTerminal.position
      : (application.stages.at(-1)?.position ?? -1) + 1;

  // Keys are unique per application; de-duplicate by suffixing.
  const base = slugifyKey(params.name);
  const taken = new Set(application.stages.map((s) => s.key));
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;

  const stage = await prisma.$transaction(async (tx) => {
    // Shift later stages down. Descending order avoids transient unique
    // collisions on (applicationId, position) style ordering.
    const toShift = application.stages
      .filter((s) => s.position >= insertAt)
      .sort((a, b) => b.position - a.position);
    for (const s of toShift) {
      await tx.applicationStage.update({
        where: { id: s.id },
        data: { position: s.position + 1 },
      });
    }

    return tx.applicationStage.create({
      data: {
        applicationId: params.applicationId,
        name: params.name,
        key,
        type: params.type ?? "CUSTOM",
        position: insertAt,
        slaDays: params.slaDays ?? null,
        isCustom: true,
        status: "PENDING",
      },
    });
  });

  await markPersonalized(params.applicationId);
  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STAGE_CHANGED",
    title: `Added custom stage "${params.name}"`,
    body: "This flow now differs from its pipeline template.",
    actorType: actor.type,
    actorId: actor.id ?? null,
  });

  return stage;
}

/**
 * Skips a stage for this candidate. Skipping is preferred over deleting: the
 * stage stays visible in the tracker, greyed out, so the history stays honest.
 */
export async function skipStage(params: {
  applicationId: string;
  stageId: string;
  actor?: Actor;
  reason?: string;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!application) throw new Error("Application not found");

  const stage = application.stages.find((s) => s.id === params.stageId);
  if (!stage) throw new Error("Stage not found");

  await prisma.applicationStage.update({
    where: { id: stage.id },
    data: { status: "SKIPPED", notes: params.reason ?? stage.notes },
  });

  // If we just skipped the stage they were sitting on, move them along.
  if (application.currentStageId === stage.id) {
    const next = application.stages.find(
      (s) => s.position > stage.position && s.status !== "SKIPPED",
    );
    if (next) {
      await moveToStage({
        applicationId: application.id,
        target: { stageId: next.id },
        actor,
        reason: `Skipped ${stage.name}`,
      });
    }
  }

  await markPersonalized(params.applicationId);
  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STAGE_CHANGED",
    title: `Skipped stage "${stage.name}"`,
    body: params.reason ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
  });
}

/** Un-skips a previously skipped stage. */
export async function restoreStage(params: {
  applicationId: string;
  stageId: string;
  actor?: Actor;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const stage = await prisma.applicationStage.findFirst({
    where: { id: params.stageId, applicationId: params.applicationId },
    include: { application: true },
  });
  if (!stage) throw new Error("Stage not found");

  await prisma.applicationStage.update({
    where: { id: stage.id },
    data: { status: "PENDING", notes: null },
  });

  await logActivity({
    orgId: stage.application.orgId,
    applicationId: stage.applicationId,
    candidateId: stage.application.candidateId,
    type: "STAGE_CHANGED",
    title: `Restored stage "${stage.name}"`,
    actorType: actor.type,
    actorId: actor.id ?? null,
  });
}

/** Applies a new explicit ordering of stage ids. */
export async function reorderStages(params: {
  applicationId: string;
  orderedStageIds: string[];
  actor?: Actor;
}): Promise<void> {
  const actor = params.actor ?? SYSTEM_ACTOR;
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { stages: true },
  });
  if (!application) throw new Error("Application not found");

  const known = new Set(application.stages.map((s) => s.id));
  const ordered = params.orderedStageIds.filter((id) => known.has(id));
  // Anything the caller omitted keeps its relative order at the end.
  const missing = application.stages
    .filter((s) => !ordered.includes(s.id))
    .sort((a, b) => a.position - b.position)
    .map((s) => s.id);
  const finalOrder = [...ordered, ...missing];

  await prisma.$transaction(
    finalOrder.map((id, index) =>
      prisma.applicationStage.update({
        where: { id },
        data: { position: index },
      }),
    ),
  );

  await markPersonalized(params.applicationId);
  await logActivity({
    orgId: application.orgId,
    applicationId: application.id,
    candidateId: application.candidateId,
    type: "STAGE_CHANGED",
    title: "Reordered the interview flow",
    actorType: actor.type,
    actorId: actor.id ?? null,
  });
}
