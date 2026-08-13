import type {
  StageStatus,
  StageType,
  OpportunityStatus,
  Priority,
  ChallengeStatus,
} from "@prisma/client";

/**
 * Shared visual vocabulary. Stage status is the most repeated signal in the UI,
 * so it is defined once and imported rather than re-picked per component.
 */

export const STAGE_STATUS_STYLE: Record<
  StageStatus,
  { dot: string; chip: string; label: string }
> = {
  PENDING: { dot: "bg-slate-300", chip: "bg-slate-100 text-slate-600 ring-slate-200", label: "Upcoming" },
  ACTIVE: { dot: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", label: "You are here" },
  COMPLETED: { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Done" },
  SKIPPED: { dot: "bg-slate-200", chip: "bg-slate-50 text-slate-400 ring-slate-200", label: "Skipped" },
  FAILED: { dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200", label: "Didn't pass" },
};

export const OPPORTUNITY_STATUS_STYLE: Record<OpportunityStatus, string> = {
  ACTIVE: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  ON_HOLD: "bg-amber-50 text-amber-700 ring-amber-200",
  OFFER: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ACCEPTED: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  WITHDRAWN: "bg-slate-100 text-slate-600 ring-slate-200",
  GHOSTED: "bg-slate-100 text-slate-500 ring-slate-200",
};

export const PRIORITY_STYLE: Record<Priority, string> = {
  DREAM: "bg-violet-50 text-violet-700 ring-violet-200",
  HIGH: "bg-sky-50 text-sky-700 ring-sky-200",
  MEDIUM: "bg-slate-100 text-slate-600 ring-slate-200",
  LOW: "bg-slate-50 text-slate-400 ring-slate-200",
};

export const CHALLENGE_STATUS_STYLE: Record<ChallengeStatus, string> = {
  NOT_STARTED: "bg-slate-100 text-slate-600 ring-slate-200",
  PLANNING: "bg-sky-50 text-sky-700 ring-sky-200",
  IN_PROGRESS: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  READY_FOR_REVIEW: "bg-amber-50 text-amber-700 ring-amber-200",
  SUBMITTED: "bg-violet-50 text-violet-700 ring-violet-200",
  PASSED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
};

export const STAGE_TYPE_LABEL: Record<StageType, string> = {
  RESEARCHING: "Researching",
  APPLIED: "Applied",
  RECRUITER_SCREEN: "Recruiter screen",
  TAKE_HOME: "Take-home",
  TECHNICAL_INTERVIEW: "Technical interview",
  BEHAVIOURAL_INTERVIEW: "Behavioural",
  ONSITE: "Onsite",
  SYSTEM_DESIGN: "System design",
  REFERENCE_CHECK: "References",
  OFFER: "Offer",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  CUSTOM: "Custom",
};

/** Title-cases an enum value for display: ON_HOLD → "on hold". */
export function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

/** Initials for the avatar chip, e.g. "Nimbus Data" -> "ND". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Deterministic tint so the same company keeps the same colour. */
export function tint(seed: string): string {
  const palette = [
    "bg-indigo-100 text-indigo-700",
    "bg-emerald-100 text-emerald-700",
    "bg-amber-100 text-amber-700",
    "bg-sky-100 text-sky-700",
    "bg-rose-100 text-rose-700",
    "bg-violet-100 text-violet-700",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

/** "3 days ago" / "in 2 hours" without pulling a whole i18n stack. */
export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const value = typeof date === "string" ? new Date(date) : date;
  const diffMs = value.getTime() - Date.now();
  const abs = Math.abs(diffMs);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 3600_000],
    ["month", 30 * 24 * 3600_000],
    ["day", 24 * 3600_000],
    ["hour", 3600_000],
    ["minute", 60_000],
  ];

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return formatter.format(Math.round(diffMs / ms), unit);
  }
  return "just now";
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(value);
}

export const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none";
