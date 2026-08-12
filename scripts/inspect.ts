/**
 * Dev utility: prints the current state of every application, its stage flow
 * and its timeline counts. Handy for checking what the sync/automation engine
 * actually did. Run with: npx tsx scripts/inspect.ts
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
  const applications = await prisma.application.findMany({
    include: {
      candidate: true,
      job: true,
      currentStage: true,
      stages: { orderBy: { position: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const app of applications) {
    console.log(
      `\n${app.candidate.fullName} -> ${app.job.title}  [${app.flowMode}] ${app.status}`,
    );
    console.log(`  current: ${app.currentStage?.name ?? "(none)"}`);
    console.log(
      "  flow:    " +
        app.stages
          .map((s) => `${STATUS_MARK[s.status] ?? "?"}${s.key}${s.isCustom ? "*" : ""}`)
          .join(" "),
    );
  }

  const [transitions, activities, rules, emails, events, files] = await Promise.all([
    prisma.stageTransition.count(),
    prisma.activity.count(),
    prisma.automationRule.count(),
    prisma.emailMessage.count(),
    prisma.calendarEvent.count(),
    prisma.driveFile.count(),
  ]);

  console.log(
    `\nlegend: x=completed >=active .=pending -=skipped *=custom stage\n` +
      `transitions=${transitions} activities=${activities} rules=${rules} ` +
      `emails=${emails} events=${events} files=${files}`,
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
