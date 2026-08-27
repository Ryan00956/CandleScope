/** Plan-first download form model. Public input never includes end_ms. */

export interface ManualHistoryFormState {
  exchange: string;
  marketType: string;
  symbols: string[];
  intervals: string[];
  startMs: number | null;
}

export type ManualHistoryParentState =
  | "QUEUED"
  | "RUNNING"
  | "SEALING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "BLOCKED_STORAGE"
  | "CANCELLING"
  | "CANCELLED";

export function createEmptyManualHistoryForm(): ManualHistoryFormState {
  return {
    exchange: "binance",
    marketType: "spot",
    symbols: [],
    intervals: [],
    startMs: null,
  };
}

export function formHasEndTime(form: object): boolean {
  return Object.prototype.hasOwnProperty.call(form, "endMs")
    || Object.prototype.hasOwnProperty.call(form, "end_ms");
}

export const MANUAL_HISTORY_INTERVAL_CHOICES = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "45m",
  "89m",
] as const;

export function parseSymbolList(raw: string): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const symbol = part.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

export function toggleInterval(current: string[], interval: string): string[] {
  return current.includes(interval)
    ? current.filter((item) => item !== interval)
    : [...current, interval];
}

export function isPlanFirstReady(form: ManualHistoryFormState): boolean {
  return form.symbols.length > 0 && form.intervals.length > 0 && form.startMs != null && form.startMs >= 0;
}

export function canStartDownload(plan: { can_start?: boolean; canStart?: boolean } | null): boolean {
  if (!plan) return false;
  return plan.can_start === true || plan.canStart === true;
}

export function isGreenCompleteState(state: string | undefined): boolean {
  return state === "SUCCEEDED";
}

export function parentStateTone(state: string | undefined): "success" | "warning" | "danger" | "neutral" {
  if (state === "SUCCEEDED") return "success";
  if (state === "PARTIAL" || state === "BLOCKED_STORAGE" || state === "CANCELLING") return "warning";
  if (state === "FAILED" || state === "CANCELLED") return "danger";
  return "neutral";
}
