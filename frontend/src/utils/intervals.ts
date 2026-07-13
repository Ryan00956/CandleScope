// Shared interval parsing and display helpers.
export const CUSTOM_INTERVAL_RE = /^(\d+)([smhdwM])$/;

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

export interface IntervalParts {
  amount: number;
  unit: IntervalUnit;
}

export interface IntervalUnitOption {
  value: IntervalUnit;
  label: string;
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
  { value: "s", label: "秒", shortLabel: "s" },
  { value: "m", label: "分钟", shortLabel: "m" },
  { value: "h", label: "小时", shortLabel: "h" },
  { value: "d", label: "天", shortLabel: "d" },
  { value: "w", label: "周", shortLabel: "w" },
  { value: "M", label: "月", shortLabel: "M" },
] as const satisfies readonly IntervalUnitOption[];

function isIntervalUnit(value: string): value is IntervalUnit {
  return Object.prototype.hasOwnProperty.call(INTERVAL_UNIT_SECONDS, value);
}

export function parseIntervalParts(interval: unknown): IntervalParts | null {
  const match = CUSTOM_INTERVAL_RE.exec(String(interval || "").trim());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0 || !isIntervalUnit(unit)) return null;
  return { amount, unit };
}

export function parseIntervalSeconds(interval: unknown): number | null {
  const parts = parseIntervalParts(interval);
  if (!parts) return null;
  return parts.amount * INTERVAL_UNIT_SECONDS[parts.unit];
}

export function normalizeIntervalValue(interval: unknown): IntervalString | "" {
  const trimmed = String(interval || "").trim();
  const parts = parseIntervalParts(trimmed);
  if (!parts) return "";
  return `${parts.amount}${parts.unit}`;
}

export function getIntervalGroupLabel(seconds: number): string {
  if (seconds < 60) return "Seconds";
  if (seconds < 3600) return "Minutes";
  if (seconds < 86400) return "Hours";
  return "Days";
}

export function getIntervalGroupLabelZh(seconds: number): string {
  if (seconds < 60) return "秒级";
  if (seconds < 3600) return "分钟级";
  if (seconds < 86400) return "小时级";
  return "日线+";
}

export function formatIntervalDescription(interval: unknown): string {
  const parts = parseIntervalParts(interval);
  if (!parts) return "格式无效";
  const unit = INTERVAL_UNITS.find((item) => item.value === parts.unit);
  return `${parts.amount} ${unit?.label || parts.unit}`;
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
    { label: "Seconds", labelZh: "秒级", items: seconds },
    { label: "Minutes", labelZh: "分钟级", items: minutes },
    { label: "Hours", labelZh: "小时级", items: hours },
    { label: "Days", labelZh: "日线+", items: days },
  ].filter((group) => group.items.length > 0);
}
