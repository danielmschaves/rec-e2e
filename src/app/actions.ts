"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/server/activity";
import {
  createApplication,
  moveToStage,
  advanceStage,
  addCustomStage,
  skipStage,
  restoreStage,
  reorderStages,
  setApplicationStatus,
} from "@/server/applications";
import { enqueueAccountSync } from "@/server/queue";
import { syncAccount } from "@/server/sync";
import { sendEmail } from "@/server/sync/gmail";
import { scheduleInterview } from "@/server/sync/calendar";
import type { StageType } from "@prisma/client";

/** Confirms the record belongs to the caller's org before mutating it. */
async function ownedApplication(applicationId: string) {
  const user = await requireUser();
  const application = await prisma.application.findFirst({
    where: { id: applicationId, orgId: user.orgId },
  });
  if (!application) throw new Error("Application not found");
  return { user, application };
}

function refreshApplication(applicationId: string) {
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/jobs", "layout");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Stage movement
// ---------------------------------------------------------------------------

export async function moveStageAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const stageId = String(formData.get("stageId"));
  const { user } = await ownedApplication(applicationId);

  await moveToStage({
    applicationId,
    target: { stageId },
    actor: { type: "USER", id: user.id },
    reason: "Moved manually",
  });
  refreshApplication(applicationId);
}

export async function advanceStageAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const { user } = await ownedApplication(applicationId);

  await advanceStage({
    applicationId,
    actor: { type: "USER", id: user.id },
    reason: "Advanced manually",
  });
  refreshApplication(applicationId);
}

export async function setStatusAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const status = z
    .enum(["ACTIVE", "ON_HOLD", "HIRED", "REJECTED", "WITHDRAWN"])
    .parse(formData.get("status"));
  const reason = String(formData.get("reason") ?? "") || undefined;

  const { user } = await ownedApplication(applicationId);
  await setApplicationStatus({
    applicationId,
    status,
    actor: { type: "USER", id: user.id },
    reason,
  });
  refreshApplication(applicationId);
}

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

export async function addStageAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const type = (String(formData.get("type") ?? "CUSTOM") || "CUSTOM") as StageType;
  const afterStageId = String(formData.get("afterStageId") ?? "") || null;
  const slaRaw = String(formData.get("slaDays") ?? "").trim();

  const { user } = await ownedApplication(applicationId);
  await addCustomStage({
    applicationId,
    name,
    type,
    afterStageId,
    slaDays: slaRaw ? Number(slaRaw) : null,
    actor: { type: "USER", id: user.id },
  });
  refreshApplication(applicationId);
}

export async function skipStageAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const stageId = String(formData.get("stageId"));
  const reason = String(formData.get("reason") ?? "") || undefined;

  const { user } = await ownedApplication(applicationId);
  await skipStage({
    applicationId,
    stageId,
    reason,
    actor: { type: "USER", id: user.id },
  });
  refreshApplication(applicationId);
}

export async function restoreStageAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const stageId = String(formData.get("stageId"));

  const { user } = await ownedApplication(applicationId);
  await restoreStage({
    applicationId,
    stageId,
    actor: { type: "USER", id: user.id },
  });
  refreshApplication(applicationId);
}

/** Moves one stage up or down by swapping it with its neighbour. */
export async function moveStageOrderAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const stageId = String(formData.get("stageId"));
  const direction = String(formData.get("direction")) === "up" ? -1 : 1;

  const { user } = await ownedApplication(applicationId);
  const stages = await prisma.applicationStage.findMany({
    where: { applicationId },
    orderBy: { position: "asc" },
  });

  const index = stages.findIndex((s) => s.id === stageId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= stages.length) return;

  const reordered = [...stages];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await reorderStages({
    applicationId,
    orderedStageIds: reordered.map((s) => s.id),
    actor: { type: "USER", id: user.id },
  });
  refreshApplication(applicationId);
}

// ---------------------------------------------------------------------------
// Notes & scorecards
// ---------------------------------------------------------------------------

export async function addNoteAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  const { user, application } = await ownedApplication(applicationId);
  await prisma.note.create({
    data: { applicationId, authorId: user.id, body },
  });
  await logActivity({
    orgId: user.orgId,
    applicationId,
    candidateId: application.candidateId,
    type: "NOTE_ADDED",
    title: `${user.name} added a note`,
    body: body.slice(0, 300),
    actorType: "USER",
    actorId: user.id,
  });
  refreshApplication(applicationId);
}

export async function addScorecardAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const verdict = z
    .enum(["STRONG_YES", "YES", "NEUTRAL", "NO", "STRONG_NO"])
    .parse(formData.get("verdict"));
  const strengths = String(formData.get("strengths") ?? "").trim() || null;
  const concerns = String(formData.get("concerns") ?? "").trim() || null;

  const { user, application } = await ownedApplication(applicationId);
  await prisma.scorecard.create({
    data: {
      applicationId,
      stageId: application.currentStageId,
      authorId: user.id,
      verdict,
      strengths,
      concerns,
    },
  });
  await logActivity({
    orgId: user.orgId,
    applicationId,
    candidateId: application.candidateId,
    type: "SCORECARD_ADDED",
    title: `${user.name} submitted a scorecard: ${verdict.replace("_", " ").toLowerCase()}`,
    actorType: "USER",
    actorId: user.id,
  });
  refreshApplication(applicationId);
}

// ---------------------------------------------------------------------------
// Creating records
// ---------------------------------------------------------------------------

export async function createJobAction(formData: FormData) {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  const pipelineId = String(formData.get("pipelineId") ?? "");
  if (!title || !pipelineId) return;

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: pipelineId, orgId: user.orgId },
  });
  if (!pipeline) throw new Error("Pipeline not found");

  const job = await prisma.job.create({
    data: {
      orgId: user.orgId,
      pipelineId,
      ownerId: user.id,
      title,
      department: String(formData.get("department") ?? "") || null,
      location: String(formData.get("location") ?? "") || null,
      employmentType: String(formData.get("employmentType") ?? "") || null,
      description: String(formData.get("description") ?? "") || null,
      openings: Number(formData.get("openings") ?? 1) || 1,
      status: "OPEN",
    },
  });

  revalidatePath("/jobs");
  redirect(`/jobs/${job.id}`);
}

export async function addCandidateAction(formData: FormData) {
  const user = await requireUser();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const jobId = String(formData.get("jobId") ?? "");
  if (!fullName || !email) return;

  const candidate = await prisma.candidate.upsert({
    where: { orgId_email: { orgId: user.orgId, email } },
    create: {
      orgId: user.orgId,
      fullName,
      email,
      phone: String(formData.get("phone") ?? "") || null,
      linkedinUrl: String(formData.get("linkedinUrl") ?? "") || null,
      headline: String(formData.get("headline") ?? "") || null,
      source: String(formData.get("source") ?? "") || "Manual",
    },
    update: { fullName },
  });

  if (jobId) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, orgId: user.orgId },
    });
    if (job) {
      const application = await createApplication({
        orgId: user.orgId,
        jobId,
        candidateId: candidate.id,
        actor: { type: "USER", id: user.id },
      });
      revalidatePath(`/jobs/${jobId}`);
      revalidatePath("/candidates");
      redirect(`/applications/${application.id}`);
    }
  }

  revalidatePath("/candidates");
}

// ---------------------------------------------------------------------------
// Pipelines & automations
// ---------------------------------------------------------------------------

export async function createPipelineAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const stageNames = String(formData.get("stages") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stageNames.length === 0) return;

  const pipeline = await prisma.pipeline.create({
    data: {
      orgId: user.orgId,
      name,
      description: String(formData.get("description") ?? "") || null,
    },
  });

  await prisma.pipelineStage.createMany({
    data: stageNames.map((stageName, index) => ({
      pipelineId: pipeline.id,
      name: stageName,
      key: stageName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || `stage_${index}`,
      // The last step of a hand-written flow is the hire; everything before it
      // is a generic step the recruiter can retype later.
      type: index === stageNames.length - 1 ? "HIRED" : "CUSTOM",
      position: index,
    })),
  });

  revalidatePath("/pipelines");
}

export async function toggleRuleAction(formData: FormData) {
  const user = await requireUser();
  const ruleId = String(formData.get("ruleId"));

  const rule = await prisma.automationRule.findFirst({
    where: { id: ruleId, orgId: user.orgId },
  });
  if (!rule) return;

  await prisma.automationRule.update({
    where: { id: rule.id },
    data: { enabled: !rule.enabled },
  });
  revalidatePath("/automations");
}

// ---------------------------------------------------------------------------
// Outbound Google actions
// ---------------------------------------------------------------------------

/** Fills {{candidate}}, {{job}}, {{company}} and {{recruiter}} placeholders. */
function renderTemplate(
  text: string,
  vars: { candidate: string; job: string; company: string; recruiter: string },
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in vars ? vars[key as keyof typeof vars] : match,
  );
}

export async function sendEmailAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const { user, application } = await ownedApplication(applicationId);

  const account = await prisma.googleAccount.findUnique({
    where: { userId: user.id },
  });
  if (!account) throw new Error("Connect Google before sending email");

  const full = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { candidate: true, job: true },
  });

  const vars = {
    candidate: full.candidate.fullName,
    job: full.job.title,
    company: user.org.name,
    recruiter: user.name,
  };

  let subject = String(formData.get("subject") ?? "").trim();
  let body = String(formData.get("body") ?? "").trim();

  // A chosen template supplies whatever the recruiter left blank.
  const templateId = String(formData.get("templateId") ?? "");
  if (templateId) {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: templateId, orgId: user.orgId },
    });
    if (template) {
      subject ||= renderTemplate(template.subject, vars);
      body ||= renderTemplate(template.body, vars);
    }
  }
  if (!subject || !body) return;

  await sendEmail({
    account,
    orgId: user.orgId,
    to: full.candidate.email,
    subject: renderTemplate(subject, vars),
    body: renderTemplate(body, vars),
    threadId: application.emailThreadId,
    applicationId,
    candidateId: full.candidateId,
    actorId: user.id,
  });

  refreshApplication(applicationId);
}

export async function scheduleInterviewAction(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const { user } = await ownedApplication(applicationId);

  const account = await prisma.googleAccount.findUnique({
    where: { userId: user.id },
  });
  if (!account) throw new Error("Connect Google before scheduling");

  const startsAtRaw = String(formData.get("startsAt") ?? "");
  const startsAt = new Date(startsAtRaw);
  if (Number.isNaN(startsAt.getTime())) return;

  const full = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { candidate: true, currentStage: true },
  });

  const title =
    String(formData.get("title") ?? "").trim() ||
    `${full.currentStage?.name ?? "Interview"} — ${full.candidate.fullName}`;

  await scheduleInterview({
    account,
    orgId: user.orgId,
    applicationId,
    title,
    startsAt,
    durationMinutes: Number(formData.get("durationMinutes") ?? 60) || 60,
    attendeeEmails: [full.candidate.email, user.email],
    description: String(formData.get("description") ?? "") || undefined,
    actorId: user.id,
  });

  refreshApplication(applicationId);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Triggers a sync. Prefers the worker queue; if Redis is unavailable it runs
 * inline so the button still does something useful.
 */
export async function syncNowAction() {
  const user = await requireUser();

  const account = await prisma.googleAccount.findUnique({
    where: { userId: user.id },
  });
  if (!account) return;

  try {
    await enqueueAccountSync(user.id);
  } catch {
    await syncAccount(user.id);
  }

  revalidatePath("/integrations");
  revalidatePath("/");
}

export async function toggleSyncAction() {
  const user = await requireUser();
  const account = await prisma.googleAccount.findUnique({
    where: { userId: user.id },
  });
  if (!account) return;

  await prisma.googleAccount.update({
    where: { id: account.id },
    data: { syncEnabled: !account.syncEnabled },
  });
  revalidatePath("/integrations");
}
