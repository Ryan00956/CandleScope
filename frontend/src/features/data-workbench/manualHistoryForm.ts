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
