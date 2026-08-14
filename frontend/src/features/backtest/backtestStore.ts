import type { BacktestReport, BacktestRunRecord } from "./backtestTypes.js";

export interface BacktestStoreState {
  selectedRunId: string | null;
  lastSequence: number;
  resyncRequired: boolean;
  runs: BacktestRunRecord[];
  report: BacktestReport | null;
}

export function createBacktestStore(
  initial: Partial<BacktestStoreState> = {},
): {
  getState(): BacktestStoreState;
  selectRun(runId: string): void;
  applyRuns(runs: BacktestRunRecord[]): void;
  applyReport(report: BacktestReport): void;
  applyStream(event: { type: string; sequence?: number }): void;
} {
  const state: BacktestStoreState = {
    selectedRunId: null,
    lastSequence: 0,
    resyncRequired: false,
    runs: [],
    report: null,
    ...initial,
  };
  return {
    getState() {
      return state;
    },
    selectRun(runId) {
      state.selectedRunId = runId;
    },
    applyRuns(runs) {
      state.runs = runs;
    },
    applyReport(report) {
      state.report = report;
    },
    applyStream(event) {
      if (event.type === "RESYNC_REQUIRED") {
        state.resyncRequired = true;
        return;
      }
      const sequence = Number(event.sequence || 0);
      if (sequence && sequence <= state.lastSequence) {
        return;
      }
      if (sequence) state.lastSequence = sequence;
      state.resyncRequired = false;
    },
  };
}

export function reportHidesApproximate(report: BacktestReport): boolean {
  return report.fidelity_mode === "BAR_APPROX" && report.report_label !== "APPROXIMATE";
}
