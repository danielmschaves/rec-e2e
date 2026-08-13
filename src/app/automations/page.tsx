import { redirect } from "next/navigation";
import { Zap, ArrowRight } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Shell, PageHeader } from "@/components/Shell";
import { toggleRuleAction } from "@/app/actions";
import { relativeTime } from "@/lib/ui";
import type { RuleTrigger, RuleAction } from "@prisma/client";

export const dynamic = "force-dynamic";

// Phrased to read as a sentence after "When …".
const TRIGGER_LABEL: Record<RuleTrigger, string> = {
  EMAIL_RECEIVED_FROM_CANDIDATE: "a candidate emails us",
  EMAIL_SENT_TO_CANDIDATE: "we email a candidate",
  CALENDAR_EVENT_SCHEDULED: "an event is booked",
  CALENDAR_EVENT_COMPLETED: "an event finishes",
  CALENDAR_EVENT_CANCELLED: "an event is cancelled",
  DRIVE_FILE_ADDED: "a document appears in Drive",
  STAGE_SLA_BREACHED: "a stage runs past its target",
  APPLICATION_CREATED: "an application is created",
  SCORECARD_SUBMITTED: "a scorecard is submitted",
};

const ACTION_LABEL: Record<RuleAction, string> = {
  ADVANCE_STAGE: "advance to the next stage",
  SET_STAGE: "move to a specific stage",
  COMPLETE_CURRENT_STAGE: "mark the current stage complete",
  SET_APPLICATION_STATUS: "change the application status",
  ATTACH_TO_APPLICATION: "attach it to the application",
  FLAG_FOR_REVIEW: "flag it for a human",
  LOG_ACTIVITY: "log it to the timeline",
};

export default async function AutomationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const rules = await prisma.automationRule.findMany({
    where: { orgId: user.orgId },
    orderBy: [{ trigger: "asc" }, { priority: "asc" }],
  });

  const grouped = rules.reduce<Record<string, typeof rules>>((acc, rule) => {
    (acc[rule.trigger] ??= []).push(rule);
    return acc;
  }, {});

  return (
    <Shell user={user} active="/automations">
      <PageHeader
        title="Automations"
        subtitle="What each Google signal means for your process. Rules run in priority order and the first match wins."
      />

      <div className="space-y-6 p-6">
        {Object.entries(grouped).map(([trigger, triggerRules]) => (
          <section
            key={trigger}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-5 py-3">
              <Zap className="h-4 w-4 text-amber-500" strokeWidth={2} />
              <h2 className="text-sm font-semibold text-slate-900">
                When {TRIGGER_LABEL[trigger as RuleTrigger]}
              </h2>
            </div>

            <ul className="divide-y divide-slate-100">
              {triggerRules.map((rule) => {
                const conditions = rule.conditions as Record<string, unknown>;
                const conditionChips = Object.entries(conditions)
                  .filter(([, value]) => Array.isArray(value) && value.length > 0)
                  .map(([key, value]) => `${key}: ${(value as string[]).join(", ")}`);

                return (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium ${
                            rule.enabled ? "text-slate-900" : "text-slate-400"
                          }`}
                        >
                          {rule.name}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          priority {rule.priority}
                        </span>
                      </div>

                      {rule.description && (
                        <p className="mt-1 text-sm text-slate-500">
                          {rule.description}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <ArrowRight className="h-3 w-3 text-slate-400" strokeWidth={2.5} />
                        <span className="text-slate-600">
                          {ACTION_LABEL[rule.action]}
                        </span>
                        {conditionChips.map((chip) => (
                          <span
                            key={chip}
                            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>

                      <div className="mt-1.5 text-xs text-slate-400">
                        Fired {rule.timesFired} time{rule.timesFired === 1 ? "" : "s"}
                        {rule.lastFiredAt && ` · last ${relativeTime(rule.lastFiredAt)}`}
                      </div>
                    </div>

                    <form action={toggleRuleAction} className="shrink-0">
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <button
                        type="submit"
                        role="switch"
                        aria-checked={rule.enabled}
                        aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                        className={`relative block h-5 w-9 rounded-full transition-colors ${
                          rule.enabled ? "bg-indigo-600" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
                            rule.enabled ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {rules.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
            No automation rules yet.
          </div>
        )}
      </div>
    </Shell>
  );
}
