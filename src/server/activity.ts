import { prisma } from "@/lib/prisma";
import type { ActivityType, ActorType, Prisma } from "@prisma/client";

export type LogActivityInput = {
  userId: string;
  opportunityId?: string | null;
  type: ActivityType;
  title: string;
  body?: string | null;
  actorType?: ActorType;
  externalId?: string | null;
  occurredAt?: Date;
  meta?: Prisma.InputJsonValue;
};

/**
 * Appends to the timeline and bumps the opportunity's activity clock, which is
 * what the "gone quiet" views sort on.
 */
export async function logActivity(input: LogActivityInput) {
  const occurredAt = input.occurredAt ?? new Date();

  const activity = await prisma.activity.create({
    data: {
      userId: input.userId,
      opportunityId: input.opportunityId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      actorType: input.actorType ?? "SYSTEM",
      externalId: input.externalId ?? null,
      occurredAt,
      meta: input.meta ?? {},
    },
  });

  if (input.opportunityId) {
    await prisma.opportunity.update({
      where: { id: input.opportunityId },
      data: { lastActivityAt: occurredAt },
    });
  }

  return activity;
}
