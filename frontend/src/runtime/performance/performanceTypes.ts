export type KnownPerformanceMarkName =
  | "app.boot.start"
  | "app.root.render.requested"
  | "chart.initialLoad.start"
  | "chart.initialLoad.latest.request"
  | "chart.initialLoad.latest.response"
  | "chart.initialLoad.latest.commit"
  | "chart.initialLoad.history.request"
  | "chart.initialLoad.history.response"
  | "chart.initialLoad.history.commit"
  | "chart.firstBars"
  | "chart.ready"
  | "ws.kline.open"
  | "ws.kline.live"
  | "ws.kline.firstTick"
  | "indicator.compute.start"
  | "indicator.compute.end"
  | "indicator.ws.open"
  | "indicator.ws.snapshot"
  | "lazy.settings.open.start"
  | "lazy.settings.ready"
  | "lazy.symbolSearch.open.start"
  | "lazy.symbolSearch.ready"
  | "lazy.watchlist.ready"
  | "lazy.drawingToolbar.ready";

export type PerformanceMarkName = KnownPerformanceMarkName | (string & {});

export interface PerformanceEntryRecord {
  name: PerformanceMarkName;
  at: number;
  sinceStoreMs: number;
  detail: unknown;
}

export interface PerformanceStore {
  createdAt: number;
  marks: Record<string, PerformanceEntryRecord>;
  events: PerformanceEntryRecord[];
  mark(name: PerformanceMarkName, detail?: unknown): PerformanceEntryRecord | null;
  markOnce(name: PerformanceMarkName, detail?: unknown): PerformanceEntryRecord | null;
  event(name: PerformanceMarkName, detail?: unknown): PerformanceEntryRecord | null;
  measure(name: string, startName: PerformanceMarkName, endName: PerformanceMarkName): number | null;
  report(): PerformanceReport | null;
}

export interface PerformanceReport {
  namespace: string;
  createdAtMs: number;
  timings: Record<string, number | null>;
  marks: Record<string, {
    atMs: number;
    sinceStoreMs: number;
    detail: unknown;
  }>;
  events: Array<{
    name: PerformanceMarkName;
    atMs: number;
    sinceStoreMs: number;
    detail: unknown;
  }>;
}

export interface WindowBudgetInput extends Record<string, unknown> {
  bars?: unknown;
  maxBars?: unknown;
}

export interface WindowBudgetResult extends WindowBudgetInput {
  type: "window-budget";
  level: "ok" | "error";
  atMs: number;
  bars: number;
  maxBars: number;
  overBy: number;
}

export interface WindowBudgetAssertOptions {
  enabled?: boolean;
  globalRef?: Record<string, unknown> | null;
  env?: Record<string, unknown>;
  console?: Pick<Console, "error">;
}
