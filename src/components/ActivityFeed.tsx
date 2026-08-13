import Link from "next/link";
import {
  Mail,
  MailOpen,
  PenLine,
  CalendarPlus,
  CalendarCheck,
  CalendarX,
  FileText,
  MessageSquare,
  Code2,
  Flag,
  GitCommitHorizontal,
  Rocket,
  RefreshCw,
  CircleCheck,
  ToggleRight,
  Sparkles,
} from "lucide-react";
import type { Activity, ActivityType, ActorType } from "@prisma/client";
import { relativeTime } from "@/lib/ui";

const ICONS: Record<ActivityType, typeof Mail> = {
  OPPORTUNITY_CREATED: Rocket,
  STAGE_CHANGED: GitCommitHorizontal,
  STAGE_COMPLETED: CircleCheck,
  EMAIL_RECEIVED: MailOpen,
  EMAIL_SENT: Mail,
  DRAFT_CREATED: PenLine,
  INTERVIEW_SCHEDULED: CalendarPlus,
  INTERVIEW_COMPLETED: CalendarCheck,
  INTERVIEW_CANCELLED: CalendarX,
  FILE_ATTACHED: FileText,
  NOTE_ADDED: MessageSquare,
  CHALLENGE_CREATED: Code2,
  CHALLENGE_UPDATED: Code2,
  STATUS_CHANGED: ToggleRight,
  FLAGGED: Flag,
  ASSISTANT: Sparkles,
  SYNC: RefreshCw,
};

const TONES: Partial<Record<ActivityType, string>> = {
  FLAGGED: "bg-amber-50 text-amber-600",
  INTERVIEW_CANCELLED: "bg-rose-50 text-rose-600",
  STAGE_COMPLETED: "bg-emerald-50 text-emerald-600",
  INTERVIEW_COMPLETED: "bg-emerald-50 text-emerald-600",
  OPPORTUNITY_CREATED: "bg-indigo-50 text-indigo-600",
  DRAFT_CREATED: "bg-violet-50 text-violet-600",
};

const ACTOR_LABEL: Record<ActorType, string | null> = {
  USER: null,
  ASSISTANT: "Assistant",
  AUTOMATION: "Automation",
  SYNC: "Synced",
  SYSTEM: null,
};

type FeedItem = Activity & {
  opportunity?: { id: string; roleTitle: string; company: { name: string } } | null;
};

export function ActivityFeed({
  activities,
  showLinks = false,
  emptyMessage = "Nothing has happened yet.",
}: {
  activities: FeedItem[];
  showLinks?: boolean;
  emptyMessage?: string;
}) {
  if (activities.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ol className="relative space-y-4">
      <span
        className="absolute top-3 bottom-3 left-[15px] w-px bg-slate-200"
        aria-hidden="true"
      />
      {activities.map((activity) => {
        const Icon = ICONS[activity.type] ?? RefreshCw;
        const tone = TONES[activity.type] ?? "bg-slate-100 text-slate-500";
        const actorLabel = ACTOR_LABEL[activity.actorType];

        const content = (
          <div className="flex gap-3">
            <div
              className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-white ${tone}`}
            >
              <Icon className="h-4 w-4" strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm text-slate-900">{activity.title}</span>
                {actorLabel && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                    {actorLabel}
                  </span>
                )}
              </div>
              {activity.body && (
                <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{activity.body}</p>
              )}
              <div className="mt-0.5 text-xs text-slate-400">
                {relativeTime(activity.occurredAt)}
                {showLinks && activity.opportunity && (
                  <> · {activity.opportunity.company.name}</>
                )}
              </div>
            </div>
          </div>
        );

        return (
          <li key={activity.id}>
            {showLinks && activity.opportunityId ? (
              <Link
                href={`/processes/${activity.opportunityId}`}
                className="-mx-2 block rounded-lg px-2 py-1 transition-colors hover:bg-slate-50"
              >
                {content}
              </Link>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ol>
  );
}
