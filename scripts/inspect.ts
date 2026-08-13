/**
 * Dev utility: prints the state of every process you're tracking, its stage
 * flow and the counts around it. Handy for checking what the sync and
 * automation engines actually did. Run with: npx tsx scripts/inspect.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STATUS_MARK: Record<string, string> = {
  COMPLETED: "x",
  ACTIVE: ">",
  PENDING: ".",
  SKIPPED: "-",
  FAILED: "!",
};

async function main() {
  const opportunities = await prisma.opportunity.findMany({
    include: {
      company: true,
      currentStage: true,
      stages: { orderBy: { position: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const o of opportunities) {
    console.log(
      `\n${o.company.name} — ${o.roleTitle}  [${o.flowMode}] ${o.status}`,
    );
    console.log(`  stage:  ${o.currentStage?.name ?? "(none)"}`);
    console.log(
      "  flow:   " +
        o.stages
          .map((s) => `${STATUS_MARK[s.status] ?? "?"}${s.key}${s.isCustom ? "*" : ""}`)
          .join(" "),
    );
    if (o.nextAction) console.log(`  next:   ${o.nextAction}`);
  }

  const [transitions, activities, rules, emails, events, files, drafts, challenges] =
    await Promise.all([
      prisma.stageTransition.count(),
      prisma.activity.count(),
      prisma.automationRule.count(),
      prisma.emailMessage.count(),
      prisma.calendarEvent.count(),
      prisma.driveFile.count(),
      prisma.emailDraft.count({ where: { status: "DRAFT" } }),
      prisma.challenge.count(),
    ]);

  console.log(
    `\nlegend: x=done >=here .=upcoming -=skipped *=their extra step\n` +
      `transitions=${transitions} activities=${activities} rules=${rules} ` +
      `emails=${emails} events=${events} files=${files} drafts=${drafts} challenges=${challenges}`,
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
