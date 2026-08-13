import type { StageStatus, StageType, ApplicationStatus } from "@prisma/client";

/**
 * Shared visual vocabulary. Stage status colour is the single most repeated
 * signal in the UI, so it is defined once and imported rather than re-picked
 * per component.
 */

export const STAGE_STATUS_STYLE: Record<
  StageStatus,
  { dot: string; chip: string; label: string }
> = {
  PENDING: {
    dot: "bg-slate-300",
    chip: "bg-slate-100 text-slate-600 ring-slate-200",
    label: "Pending",
  },
  ACTIVE: {
    dot: "bg-indigo-500",
    chip: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    label: "In progress",
  },
  COMPLETED: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    label: "Completed",
  },
  SKIPPED: {
    dot: "bg-slate-200",
    chip: "bg-slate-50 text-slate-400 ring-slate-200",
    label: "Skipped",
  },
  FAILED: {
    dot: "bg-rose-500",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
    label: "Failed",
  },
};

export const APPLICATION_STATUS_STYLE: Record<ApplicationStatus, string> = {
  ACTIVE: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  ON_HOLD: "bg-amber-50 text-amber-700 ring-amber-200",
  HIRED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  WITHDRAWN: "bg-slate-100 text-slate-600 ring-slate-200",
};

export const STAGE_TYPE_LABEL: Record<StageType, string> = {
  SOURCED: "Sourced",
  APPLIED: "Applied",
  SCREENING: "Screening",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview",
  REFERENCE_CHECK: "Reference check",
  OFFER: "Offer",
  HIRED: "Hired",
  REJECTED: "Rejected",
  CUSTOM: "Custom",
};

/** Initials for the avatar chip, e.g. "Marina Duarte" -> "MD". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Deterministic avatar tint so the same person keeps the same colour. */
export function avatarTint(seed: string): string {
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
