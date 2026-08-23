import { t, type MessageKey } from "../i18n/index.js";

// Shared interval parsing and display helpers.
export const CUSTOM_INTERVAL_RE = /^(\d+)([smhdwM])$/;
export const MAX_CALENDAR_MONTH_INTERVAL = 12_000;

export const INTERVAL_UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  M: 2592000,
} as const;

export type IntervalUnit = keyof typeof INTERVAL_UNIT_SECONDS;
export type IntervalString = string;
export type IntervalAlignment = "fixed-epoch" | "weekly-monday" | "calendar-month";

export interface IntervalParts {
  amount: number;
  unit: IntervalUnit;
}

export interface IntervalSemanticSpec extends IntervalParts {
  alignment: IntervalAlignment;
  canonicalValue: IntervalString;
  widthSeconds: number | null;
  weekCount: number | null;
  monthCount: number | null;
}

export interface IntervalUnitOption {
  value: IntervalUnit;
  labelKey: MessageKey;
  shortLabel: IntervalUnit;
}

export interface IntervalDurationItem {
  value: unknown;
  seconds: number;
}

export interface IntervalDurationGroup<T extends IntervalDurationItem> {
  label: string;
  labelZh: string;
  items: T[];
}

export const INTERVAL_UNITS = [
  { value: "s", labelKey: "interval.unit.s", shortLabel: "s" },
  { value: "m", labelKey: "interval.unit.m", shortLabel: "m" },
  { value: "h", labelKey: "interval.unit.h", shortLabel: "h" },
  { value: "d", labelKey: "interval.unit.d", shortLabel: "d" },
  { value: "w", labelKey: "interval.unit.w", shortLabel: "w" },
  { value: "M", labelKey: "interval.unit.M", shortLabel: "M" },
] as const satisfies readonly IntervalUnitOption[];

function isIntervalUnit(value: string): value is IntervalUnit {
  return Object.prototype.hasOwnProperty.call(INTERVAL_UNIT_SECONDS, value);
}

export function parseIntervalParts(interval: unknown): IntervalParts | null {
  const match = CUSTOM_INTERVAL_RE.exec(String(interval || "").trim());
  if (!match) return null;
  const amountToken = match[1];
  const unit = match[2];
  if (!amountToken || !unit) return null;
  const amount = parseInt(amountToken, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !isIntervalUnit(unit)) return null;
  if (unit === "M" && amount > MAX_CALENDAR_MONTH_INTERVAL) return null;
  return { amount, unit };
}

export function parseIntervalSeconds(interval: unknown): number | null {
  const parts = parseIntervalParts(interval);
  if (!parts) return null;
  const seconds = parts.amount * INTERVAL_UNIT_SECONDS[parts.unit];
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function normalizeIntervalValue(interval: unknown): IntervalString | "" {
  const trimmed = String(interval || "").trim();
  const parts = parseIntervalParts(trimmed);
  if (!parts) return "";
  return `${parts.amount}${parts.unit}`;
}

function canonicalFixedInterval(widthSeconds: number): IntervalString {
  const units = [
    ["d", INTERVAL_UNIT_SECONDS.d],
    ["h", INTERVAL_UNIT_SECONDS.h],
    ["m", INTERVAL_UNIT_SECONDS.m],
    ["s", INTERVAL_UNIT_SECONDS.s],
  ] as const;
  const unit = units.find(([, seconds]) => widthSeconds % seconds === 0) ?? (["s", 1] as const);
  return `${widthSeconds / unit[1]}${unit[0]}`;
}

export function getIntervalSemanticSpec(interval: unknown): IntervalSemanticSpec | null {
  const parts = parseIntervalParts(interval);
  if (!parts) return null;

  if (parts.unit === "M") {
    return {
      ...parts,
      alignment: "calendar-month",
      canonicalValue: `${parts.amount}M`,
      widthSeconds: null,
      weekCount: null,
      monthCount: parts.amount,
    };
  }

  if (parts.unit === "w") {
    if (!Number.isSafeInteger(parts.amount * INTERVAL_UNIT_SECONDS.w)) return null;
    return {
      ...parts,
      alignment: "weekly-monday",
      canonicalValue: `${parts.amount}w`,
      widthSeconds: null,
      weekCount: parts.amount,
      monthCount: null,
    };
  }

  const widthSeconds = parts.amount * INTERVAL_UNIT_SECONDS[parts.unit];
  if (!Number.isSafeInteger(widthSeconds) || widthSeconds <= 0) return null;
  return {
    ...parts,
    alignment: "fixed-epoch",
    canonicalValue: canonicalFixedInterval(widthSeconds),
    widthSeconds,
    weekCount: null,
    monthCount: null,
  };
}

export function canonicalizeIntervalValue(interval: unknown): IntervalString | "" {
  return getIntervalSemanticSpec(interval)?.canonicalValue ?? "";
}

export function intervalSemanticSignature(interval: unknown): string {
  const spec = getIntervalSemanticSpec(interval);
  if (!spec) return "";
  if (spec.alignment === "fixed-epoch") return `${spec.alignment}:${spec.widthSeconds}`;
  if (spec.alignment === "weekly-monday") return `${spec.alignment}:${spec.weekCount}`;
  return `${spec.alignment}:${spec.monthCount}`;
}

export function intervalsSemanticallyEquivalent(left: unknown, right: unknown): boolean {
  const leftSignature = intervalSemanticSignature(left);
  return leftSignature !== "" && leftSignature === intervalSemanticSignature(right);
}

function intervalNominalSeconds(spec: IntervalSemanticSpec): number {
  if (spec.widthSeconds != null) return spec.widthSeconds;
  if (spec.weekCount != null) return spec.weekCount * INTERVAL_UNIT_SECONDS.w;
  return (spec.monthCount || 0) * INTERVAL_UNIT_SECONDS.M;
}

/**
 * Return whether complete source buckets exactly tile target boundaries.
 *
 * This mirrors the backend IntervalResolver's semantic rule: identities are
 * alignment-aware, while fixed UTC bars no wider than one day may also build
 * Monday-aligned weeks and calendar months. A syntactically valid custom
 * interval is not necessarily derivable for a venue (for example 7s from a
 * futures feed whose smallest native K-line is 1m).
 */
export function intervalTiles(source: unknown, target: unknown): boolean {
  const sourceSpec = getIntervalSemanticSpec(source);
  const targetSpec = getIntervalSemanticSpec(target);
  if (!sourceSpec || !targetSpec) return false;

  if (sourceSpec.alignment !== targetSpec.alignment) {
    return sourceSpec.alignment === "fixed-epoch"
      && (targetSpec.alignment === "weekly-monday" || targetSpec.alignment === "calendar-month")
      && sourceSpec.widthSeconds != null
      && sourceSpec.widthSeconds <= INTERVAL_UNIT_SECONDS.d
      && INTERVAL_UNIT_SECONDS.d % sourceSpec.widthSeconds === 0;
  }
  if (sourceSpec.alignment === "calendar-month") {
    return (targetSpec.monthCount || 0) % (sourceSpec.monthCount || 1) === 0;
  }
  if (sourceSpec.alignment === "weekly-monday") {
    return (targetSpec.weekCount || 0) % (sourceSpec.weekCount || 1) === 0;
  }
  return (targetSpec.widthSeconds || 0) % (sourceSpec.widthSeconds || 1) === 0;
}

/** Resolve a target from the purpose-specific native values supplied by capabilities. */
export function canResolveIntervalFromNativeValues(
  target: unknown,
  nativeValues: readonly unknown[],
): boolean {
  const targetSpec = getIntervalSemanticSpec(target);
  if (!targetSpec) return false;
  const targetNominalSeconds = intervalNominalSeconds(targetSpec);
  return nativeValues.some((nativeValue) => {
    if (intervalsSemanticallyEquivalent(nativeValue, target)) return true;
    const sourceSpec = getIntervalSemanticSpec(nativeValue);
    return sourceSpec != null
      && intervalNominalSeconds(sourceSpec) < targetNominalSeconds
      && intervalTiles(nativeValue, target);
  });
}

export function getIntervalGroupLabel(seconds: number): string {
  if (seconds < 60) return t("interval.group.seconds");
  if (seconds < 3600) return t("interval.group.minutes");
  if (seconds < 86400) return t("interval.group.hours");
  return t("interval.group.days");
}

export function getIntervalGroupLabelZh(seconds: number): string {
  return getIntervalGroupLabel(seconds);
}

export const INTERVAL_UNIT_MESSAGE_KEYS = {
  s: "interval.unit.s",
  m: "interval.unit.m",
  h: "interval.unit.h",
  d: "interval.unit.d",
  w: "interval.unit.w",
  M: "interval.unit.M",
} as const;

export function formatIntervalDescription(interval: unknown): string {
  const parts = parseIntervalParts(interval);
  if (!parts) return t("interval.invalidFormat");
  return t("interval.description", {
    amount: parts.amount,
    unit: t(INTERVAL_UNIT_MESSAGE_KEYS[parts.unit]),
  });
}

export function formatSecondsCompact(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;
  if (seconds < 2592000) return `${Math.round(seconds / 604800)}w`;
  return `≈${Math.round(seconds / 2592000)}M`;
}

export function groupIntervalsByDuration<T extends IntervalDurationItem>(
  items: readonly T[],
): IntervalDurationGroup<T>[] {
  const sorted = [...items]
    .filter((item) => Number.isFinite(item.seconds) && item.seconds > 0)
    .sort((a, b) => a.seconds - b.seconds || String(a.value).localeCompare(String(b.value)));

  const seconds = sorted.filter((item) => item.seconds < 60);
  const minutes = sorted.filter((item) => item.seconds >= 60 && item.seconds < 3600);
  const hours = sorted.filter((item) => item.seconds >= 3600 && item.seconds < 86400);
  const days = sorted.filter((item) => item.seconds >= 86400);

  return [
    { label: t("interval.group.seconds"), labelZh: t("interval.group.seconds"), items: seconds },
    { label: t("interval.group.minutes"), labelZh: t("interval.group.minutes"), items: minutes },
    { label: t("interval.group.hours"), labelZh: t("interval.group.hours"), items: hours },
    { label: t("interval.group.days"), labelZh: t("interval.group.days"), items: days },
  ].filter((group) => group.items.length > 0);
}
