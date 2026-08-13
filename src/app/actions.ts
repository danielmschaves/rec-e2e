"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/server/activity";
import {
  createOpportunity,
  moveToStage,
  advanceStage,
  addCustomStage,
  skipStage,
  restoreStage,
  reorderStages,
  setOpportunityStatus,
  setNextAction,
} from "@/server/opportunities";
import { enqueueAccountSync } from "@/server/queue";
import { syncAccount } from "@/server/sync";
import { sendDraft } from "@/server/sync/gmail";
import { sendMessage } from "@/server/ai/agent";
import type { StageType } from "@prisma/client";

/** Confirms the record is yours before mutating it. */
async function ownedOpportunity(opportunityId: string) {
  const user = await requireUser();
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, userId: user.id },
  });
  if (!opportunity) throw new Error("Process not found");
  return { user, opportunity };
}

function refresh(opportunityId?: string) {
  if (opportunityId) revalidatePath(`/processes/${opportunityId}`);
  revalidatePath("/processes");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Stage movement
// ---------------------------------------------------------------------------

export async function moveStageAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const stageId = String(formData.get("stageId"));
  await ownedOpportunity(opportunityId);

  await moveToStage({
    opportunityId,
    target: { stageId },
    actor: { type: "USER" },
    reason: "Moved manually",
  });
  refresh(opportunityId);
}

export async function advanceStageAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  await ownedOpportunity(opportunityId);

  await advanceStage({
    opportunityId,
    actor: { type: "USER" },
    reason: "Advanced manually",
  });
  refresh(opportunityId);
}

export async function setStatusAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const status = z
    .enum(["ACTIVE", "ON_HOLD", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "GHOSTED"])
    .parse(formData.get("status"));
  const reason = String(formData.get("reason") ?? "") || undefined;

  await ownedOpportunity(opportunityId);
  await setOpportunityStatus({
    opportunityId,
    status,
    actor: { type: "USER" },
    reason,
  });
  refresh(opportunityId);
}

export async function setNextActionAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const action = String(formData.get("action") ?? "").trim();
  const dueRaw = String(formData.get("dueAt") ?? "").trim();

  await ownedOpportunity(opportunityId);
  await setNextAction({
    opportunityId,
    action: action || null,
    dueAt: dueRaw ? new Date(dueRaw) : null,
    actor: { type: "USER" },
  });
  refresh(opportunityId);
}

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

export async function addStageAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const type = (String(formData.get("type") ?? "CUSTOM") || "CUSTOM") as StageType;
  const afterStageId = String(formData.get("afterStageId") ?? "") || null;

  await ownedOpportunity(opportunityId);
  await addCustomStage({
    opportunityId,
    name,
    type,
    afterStageId,
    actor: { type: "USER" },
  });
  refresh(opportunityId);
}

export async function skipStageAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const stageId = String(formData.get("stageId"));
  const reason = String(formData.get("reason") ?? "") || undefined;

  await ownedOpportunity(opportunityId);
  await skipStage({ opportunityId, stageId, reason, actor: { type: "USER" } });
  refresh(opportunityId);
}

export async function restoreStageAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const stageId = String(formData.get("stageId"));

  await ownedOpportunity(opportunityId);
  await restoreStage({ opportunityId, stageId, actor: { type: "USER" } });
  refresh(opportunityId);
}

/** Moves one stage up or down by swapping it with its neighbour. */
export async function moveStageOrderAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const stageId = String(formData.get("stageId"));
  const direction = String(formData.get("direction")) === "up" ? -1 : 1;

  await ownedOpportunity(opportunityId);
  const stages = await prisma.opportunityStage.findMany({
    where: { opportunityId },
    orderBy: { position: "asc" },
  });

  const index = stages.findIndex((s) => s.id === stageId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= stages.length) return;

  const reordered = [...stages];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await reorderStages({
    opportunityId,
    orderedStageIds: reordered.map((s) => s.id),
    actor: { type: "USER" },
  });
  refresh(opportunityId);
}

// ---------------------------------------------------------------------------
// Creating records
// ---------------------------------------------------------------------------

export async function createProcessAction(formData: FormData) {
  const user = await requireUser();
  const companyName = String(formData.get("companyName") ?? "").trim();
  const roleTitle = String(formData.get("roleTitle") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "");
  if (!companyName || !roleTitle || !templateId) return;

  const template = await prisma.processTemplate.findFirst({
    where: { id: templateId, userId: user.id },
  });
  if (!template) throw new Error("Flow not found");

  const domainRaw = String(formData.get("companyDomain") ?? "").trim().toLowerCase();
  const domains = domainRaw
    ? domainRaw.split(/[,\s]+/).map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    : [];

  const company = await prisma.company.upsert({
    where: { userId_name: { userId: user.id, name: companyName } },
    create: { userId: user.id, name: companyName, domains },
    update: domains.length > 0 ? { domains } : {},
  });

  const opportunity = await createOpportunity({
    userId: user.id,
    companyId: company.id,
    templateId,
    roleTitle,
    actor: { type: "USER" },
    details: {
      location: String(formData.get("location") ?? "") || null,
      jobPostUrl: String(formData.get("jobPostUrl") ?? "") || null,
      source: String(formData.get("source") ?? "") || null,
      priority: (String(formData.get("priority") ?? "MEDIUM") || "MEDIUM") as
        | "DREAM"
        | "HIGH"
        | "MEDIUM"
        | "LOW",
    },
  });

  revalidatePath("/processes");
  redirect(`/processes/${opportunity.id}`);
}

export async function addContactAction(formData: FormData) {
  const user = await requireUser();
  const opportunityId = String(formData.get("opportunityId"));
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!name || !email) return;

  const { opportunity } = await ownedOpportunity(opportunityId);

  await prisma.contact.upsert({
    where: { userId_email: { userId: user.id, email } },
    create: {
      userId: user.id,
      companyId: opportunity.companyId,
      name,
      email,
      role: (String(formData.get("role") ?? "RECRUITER") || "RECRUITER") as
        | "RECRUITER"
        | "HIRING_MANAGER"
        | "INTERVIEWER"
        | "REFERRAL"
        | "OTHER",
      title: String(formData.get("title") ?? "") || null,
    },
    update: { companyId: opportunity.companyId, name },
  });

  refresh(opportunityId);
}

export async function addNoteAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  const { user } = await ownedOpportunity(opportunityId);
  await prisma.note.create({ data: { userId: user.id, opportunityId, body } });
  await logActivity({
    userId: user.id,
    opportunityId,
    type: "NOTE_ADDED",
    title: "You added a note",
    body: body.slice(0, 300),
    actorType: "USER",
  });
  refresh(opportunityId);
}

// ---------------------------------------------------------------------------
// Auto-detected processes
//
// A detected row is live immediately — the point is that applying is the only
// manual step. These two actions just clear the "is this right?" banner, or
// remove a bad guess.
// ---------------------------------------------------------------------------

export async function confirmDetectionAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const roleTitle = String(formData.get("roleTitle") ?? "").trim();
  const { opportunity } = await ownedOpportunity(opportunityId);

  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: {
      confirmedAt: new Date(),
      roleTitle: roleTitle || undefined,
      // Clear the "check the role title" prompt the detector may have left.
      nextAction:
        opportunity.nextAction?.startsWith("Check the role title") ?? false
          ? null
          : undefined,
    },
  });

  refresh(opportunityId);
}

export async function dismissDetectionAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const { opportunity } = await ownedOpportunity(opportunityId);

  // Only ever removes something the scanner created, never something you typed.
  if (!opportunity.autoDetected || opportunity.confirmedAt) return;
  await prisma.opportunity.delete({ where: { id: opportunity.id } });

  revalidatePath("/processes");
  revalidatePath("/");
  redirect("/processes");
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export async function createChallengeAction(formData: FormData) {
  const opportunityId = String(formData.get("opportunityId"));
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;

  const { user, opportunity } = await ownedOpportunity(opportunityId);
  const deadlineRaw = String(formData.get("deadline") ?? "").trim();

  const challenge = await prisma.challenge.create({
    data: {
      userId: user.id,
      opportunityId,
      stageId: opportunity.currentStageId,
      title,
      brief: String(formData.get("brief") ?? "") || null,
      briefSource: String(formData.get("briefSource") ?? "") || null,
      deadline: deadlineRaw ? new Date(deadlineRaw) : null,
    },
  });

  await logActivity({
    userId: user.id,
    opportunityId,
    type: "CHALLENGE_CREATED",
    title: `Challenge added: ${title}`,
    actorType: "USER",
  });

  revalidatePath("/challenges");
  redirect(`/challenges/${challenge.id}`);
}

async function ownedChallenge(challengeId: string) {
  const user = await requireUser();
  const challenge = await prisma.challenge.findFirst({
    where: { id: challengeId, userId: user.id },
  });
  if (!challenge) throw new Error("Challenge not found");
  return { user, challenge };
}

export async function updateChallengeAction(formData: FormData) {
  const challengeId = String(formData.get("challengeId"));
  const { challenge } = await ownedChallenge(challengeId);

  const deadlineRaw = String(formData.get("deadline") ?? "").trim();
  const statusRaw = String(formData.get("status") ?? "");

  await prisma.challenge.update({
    where: { id: challenge.id },
    data: {
      brief: formData.has("brief") ? String(formData.get("brief") ?? "") || null : undefined,
      plan: formData.has("plan") ? String(formData.get("plan") ?? "") || null : undefined,
      notes: formData.has("notes") ? String(formData.get("notes") ?? "") || null : undefined,
      repoUrl: formData.has("repoUrl") ? String(formData.get("repoUrl") ?? "") || null : undefined,
      submissionUrl: formData.has("submissionUrl")
        ? String(formData.get("submissionUrl") ?? "") || null
        : undefined,
      deadline: formData.has("deadline") ? (deadlineRaw ? new Date(deadlineRaw) : null) : undefined,
      status: statusRaw
        ? (statusRaw as
            | "NOT_STARTED"
            | "PLANNING"
            | "IN_PROGRESS"
            | "READY_FOR_REVIEW"
            | "SUBMITTED"
            | "PASSED"
            | "FAILED")
        : undefined,
      submittedAt: statusRaw === "SUBMITTED" ? new Date() : undefined,
    },
  });

  revalidatePath(`/challenges/${challenge.id}`);
  revalidatePath("/challenges");
}

export async function toggleRequirementAction(formData: FormData) {
  const requirementId = String(formData.get("requirementId"));
  const user = await requireUser();

  const requirement = await prisma.challengeRequirement.findFirst({
    where: { id: requirementId, challenge: { userId: user.id } },
  });
  if (!requirement) return;

  await prisma.challengeRequirement.update({
    where: { id: requirement.id },
    data: { done: !requirement.done },
  });
  revalidatePath(`/challenges/${requirement.challengeId}`);
}

export async function addRequirementAction(formData: FormData) {
  const challengeId = String(formData.get("challengeId"));
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;

  const { challenge } = await ownedChallenge(challengeId);
  const last = await prisma.challengeRequirement.findFirst({
    where: { challengeId: challenge.id },
    orderBy: { position: "desc" },
  });

  await prisma.challengeRequirement.create({
    data: {
      challengeId: challenge.id,
      text,
      position: (last?.position ?? -1) + 1,
      fromBrief: false,
    },
  });
  revalidatePath(`/challenges/${challenge.id}`);
}

// ---------------------------------------------------------------------------
// Email drafts — approve and send is always a human action
// ---------------------------------------------------------------------------

export async function updateDraftAction(formData: FormData) {
  const draftId = String(formData.get("draftId"));
  const user = await requireUser();

  const draft = await prisma.emailDraft.findFirst({
    where: { id: draftId, userId: user.id, status: "DRAFT" },
  });
  if (!draft) return;

  await prisma.emailDraft.update({
    where: { id: draft.id },
    data: {
      subject: String(formData.get("subject") ?? draft.subject),
      body: String(formData.get("body") ?? draft.body),
      toEmail: String(formData.get("toEmail") ?? draft.toEmail),
    },
  });
  revalidatePath("/drafts");
}

export async function sendDraftAction(formData: FormData) {
  const draftId = String(formData.get("draftId"));
  const user = await requireUser();

  const draft = await prisma.emailDraft.findFirst({
    where: { id: draftId, userId: user.id },
  });
  if (!draft) return;

  const account = await prisma.googleAccount.findUnique({ where: { userId: user.id } });
  if (!account) throw new Error("Connect Google before sending");

  await sendDraft({ account, userId: user.id, draftId: draft.id });

  revalidatePath("/drafts");
  refresh(draft.opportunityId ?? undefined);
}

export async function discardDraftAction(formData: FormData) {
  const draftId = String(formData.get("draftId"));
  const user = await requireUser();

  await prisma.emailDraft.updateMany({
    where: { id: draftId, userId: user.id, status: "DRAFT" },
    data: { status: "DISCARDED" },
  });
  revalidatePath("/drafts");
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

export type AssistantState = { error?: string; ok?: boolean };

/**
 * Sends one message to the assistant. Bound with useActionState so the panel
 * can show a pending state while the tool loop runs.
 */
export async function askAssistantAction(
  _prev: AssistantState,
  formData: FormData,
): Promise<AssistantState> {
  const user = await requireUser();
  const message = String(formData.get("message") ?? "").trim();
  if (!message) return {};

  const opportunityId = String(formData.get("opportunityId") ?? "") || null;
  const challengeId = String(formData.get("challengeId") ?? "") || null;

  // One thread per opportunity / challenge keeps the context tight.
  let thread = await prisma.assistantThread.findFirst({
    where: { userId: user.id, opportunityId, challengeId },
    orderBy: { updatedAt: "desc" },
  });
  if (!thread) {
    thread = await prisma.assistantThread.create({
      data: { userId: user.id, opportunityId, challengeId },
    });
  }

  try {
    await sendMessage({ threadId: thread.id, userId: user.id, message });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The assistant failed" };
  }

  if (opportunityId) revalidatePath(`/processes/${opportunityId}`);
  if (challengeId) revalidatePath(`/challenges/${challengeId}`);
  revalidatePath("/drafts");
  revalidatePath("/");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Flows & automations
// ---------------------------------------------------------------------------

export async function createFlowAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const stageNames = String(formData.get("stages") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stageNames.length === 0) return;

  const template = await prisma.processTemplate.create({
    data: {
      userId: user.id,
      name,
      description: String(formData.get("description") ?? "") || null,
    },
  });

  await prisma.templateStage.createMany({
    data: stageNames.map((stageName, index) => ({
      templateId: template.id,
      name: stageName,
      key:
        stageName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || `stage_${index}`,
      // The last step of a hand-written flow is the acceptance; everything
      // before it is a generic step you can retype later.
      type: index === stageNames.length - 1 ? "ACCEPTED" : "CUSTOM",
      position: index,
    })),
  });

  revalidatePath("/flows");
}

export async function toggleRuleAction(formData: FormData) {
  const user = await requireUser();
  const ruleId = String(formData.get("ruleId"));

  const rule = await prisma.automationRule.findFirst({
    where: { id: ruleId, userId: user.id },
  });
  if (!rule) return;

  await prisma.automationRule.update({
    where: { id: rule.id },
    data: { enabled: !rule.enabled },
  });
  revalidatePath("/automations");
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncNowAction() {
  const user = await requireUser();
  const account = await prisma.googleAccount.findUnique({ where: { userId: user.id } });
  if (!account) return;

  try {
    await enqueueAccountSync(user.id);
  } catch {
    // Redis unavailable — run it inline so the button still does something.
    await syncAccount(user.id);
  }

  revalidatePath("/integrations");
  revalidatePath("/");
}

export async function toggleSyncAction() {
  const user = await requireUser();
  const account = await prisma.googleAccount.findUnique({ where: { userId: user.id } });
  if (!account) return;

  await prisma.googleAccount.update({
    where: { id: account.id },
    data: { syncEnabled: !account.syncEnabled },
  });
  revalidatePath("/integrations");
}

export async function updateProfileAction(formData: FormData) {
  const user = await requireUser();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      profile: String(formData.get("profile") ?? "") || null,
      headline: String(formData.get("headline") ?? "") || null,
    },
  });
  revalidatePath("/integrations");
}
