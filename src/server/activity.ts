import { prisma } from "@/lib/prisma";
import type { ActivityType, ActorType, Prisma } from "@prisma/client";

export type LogActivityInput = {
  orgId: string;
  applicationId?: string | null;
  candidateId?: string | null;
  type: ActivityType;
  title: string;
  body?: string | null;
  actorType?: ActorType;
  actorId?: string | null;
  externalId?: string | null;
  occurredAt?: Date;
  meta?: Prisma.InputJsonValue;
};

/**
 * Appends to the timeline and bumps the application's activity clock, which is
 * what the "stalled applications" views sort on.
 */
export async function logActivity(input: LogActivityInput) {
  const occurredAt = input.occurredAt ?? new Date();

  const activity = await prisma.activity.create({
    data: {
      orgId: input.orgId,
      applicationId: input.applicationId ?? null,
      candidateId: input.candidateId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      actorType: input.actorType ?? "SYSTEM",
      actorId: input.actorId ?? null,
      externalId: input.externalId ?? null,
      occurredAt,
      meta: input.meta ?? {},
    },
  });

  if (input.applicationId) {
    await prisma.application.update({
      where: { id: input.applicationId },
      data: { lastActivityAt: occurredAt },
    });
  }

  return activity;
}
