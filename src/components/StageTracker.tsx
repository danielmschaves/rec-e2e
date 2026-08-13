import {
  Check,
  ChevronUp,
  ChevronDown,
  SkipForward,
  RotateCcw,
  Sparkles,
  Clock,
} from "lucide-react";
import type { OpportunityStage } from "@prisma/client";
import { STAGE_STATUS_STYLE, STAGE_TYPE_LABEL, relativeTime } from "@/lib/ui";
import {
  moveStageAction,
  skipStageAction,
  restoreStageAction,
  moveStageOrderAction,
} from "@/app/actions";

/**
 * The vertical stage tracker — the main control surface of a process.
 *
 * Every personalization affordance lives here: skip, restore, reorder, jump.
 * Skipped stages stay rendered (greyed) rather than disappearing, so the
 * history stays readable.
 */
export function StageTracker({
  opportunityId,
  stages,
  currentStageId,
  editable = true,
}: {
  opportunityId: string;
  stages: OpportunityStage[];
  currentStageId: string | null;
  editable?: boolean;
}) {
  const now = Date.now();

  return (
    <ol className="space-y-1">
      {stages.map((stage, index) => {
        const style = STAGE_STATUS_STYLE[stage.status];
        const isCurrent = stage.id === currentStageId;
        const isSkipped = stage.status === "SKIPPED";
        const isDone = stage.status === "COMPLETED";
        const quiet = isCurrent && stage.chaseAt && stage.chaseAt.getTime() < now;

        return (
          <li
            key={stage.id}
            className={`group relative rounded-lg border px-3 py-2.5 transition-colors ${
              isCurrent
                ? "border-indigo-300 bg-indigo-50/50"
                : "border-transparent hover:border-slate-200 hover:bg-slate-50"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="relative flex flex-col items-center">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${style.dot} ${
                    isSkipped ? "opacity-60" : ""
                  }`}
                >
                  {isDone && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </span>
                {index < stages.length - 1 && (
                  <span
                    className="absolute top-5 h-[calc(100%+0.25rem)] w-px bg-slate-200"
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`text-sm font-medium ${
                      isSkipped ? "text-slate-400 line-through" : "text-slate-900"
                    }`}
                  >
                    {stage.name}
                  </span>

                  {stage.isCustom && (
                    <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                      <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
                      Their extra step
                    </span>
                  )}

                  {isCurrent && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${style.chip}`}
                    >
                      {style.label}
                    </span>
                  )}

                  {quiet && (
                    <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                      Gone quiet
                    </span>
                  )}
                </div>

                <div className="mt-0.5 text-xs text-slate-500">
                  {STAGE_TYPE_LABEL[stage.type]}
                  {stage.completedAt && ` · done ${relativeTime(stage.completedAt)}`}
                  {isCurrent && stage.enteredAt && ` · since ${relativeTime(stage.enteredAt)}`}
                </div>

                {stage.notes && (
                  <p className="mt-1 text-xs text-slate-500 italic">{stage.notes}</p>
                )}
              </div>

              {editable && (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconAction
                    action={moveStageOrderAction}
                    opportunityId={opportunityId}
                    stageId={stage.id}
                    extra={{ direction: "up" }}
                    title="Move earlier"
                    disabled={index === 0}
                  >
                    <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
                  </IconAction>

                  <IconAction
                    action={moveStageOrderAction}
                    opportunityId={opportunityId}
                    stageId={stage.id}
                    extra={{ direction: "down" }}
                    title="Move later"
                    disabled={index === stages.length - 1}
                  >
                    <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                  </IconAction>

                  {isSkipped ? (
                    <IconAction
                      action={restoreStageAction}
                      opportunityId={opportunityId}
                      stageId={stage.id}
                      title="Put this step back"
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                    </IconAction>
                  ) : (
                    <IconAction
                      action={skipStageAction}
                      opportunityId={opportunityId}
                      stageId={stage.id}
                      title="They skipped this step"
                    >
                      <SkipForward className="h-3.5 w-3.5" strokeWidth={2} />
                    </IconAction>
                  )}

                  {!isCurrent && !isSkipped && (
                    <form action={moveStageAction}>
                      <input type="hidden" name="opportunityId" value={opportunityId} />
                      <input type="hidden" name="stageId" value={stage.id} />
                      <button
                        type="submit"
                        title="I'm at this stage now"
                        className="rounded px-2 py-1 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100"
                      >
                        I&apos;m here
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function IconAction({
  action,
  opportunityId,
  stageId,
  extra,
  title,
  disabled,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  opportunityId: string;
  stageId: string;
  extra?: Record<string, string>;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="stageId" value={stageId} />
      {extra &&
        Object.entries(extra).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
      <button
        type="submit"
        title={title}
        disabled={disabled}
        className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30"
      >
        {children}
      </button>
    </form>
  );
}
