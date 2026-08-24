import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { MarketChartSourceMode } from "../../market-chart-platform/marketChartSourceRuntime.js";
import type {
  BacktestReport,
  BacktestChartData,
  BacktestResearchLaunchContext,
  BacktestRunRecord,
  BacktestStudyRecord,
} from "../backtestTypes.js";
import type {
  BacktestDataset,
  StrategyRevisionRecord,
} from "../backtestApi.js";
import type { StrategyDraftRecord } from "../chart-tester/StrategyDraftStore.js";

export const BACKTEST_RESEARCH_TASKS = [
  "PRECISE_EXECUTION",
  "PARAMETER_ROBUSTNESS",
  "PYTHON_MODEL",
  "MULTI_MARKET",
  "REPLAY_REVIEW",
] as const;

export type BacktestResearchTask = typeof BACKTEST_RESEARCH_TASKS[number];
export type BacktestResearchPanel =
  | "STRATEGY"
  | "DATA"
  | "EXECUTION"
  | "RUN"
  | "STUDY"
  | "RESULTS";

export interface BacktestResearchRuntimeView {
  phase: "LOADING" | "READY" | "ERROR";
  error: string | null;
  runtimeMode: "LIVE" | "LOCAL_OFFLINE" | null;
  selectedTask: BacktestResearchTask | null;
  sourceMode: MarketChartSourceMode;
  launchContext: BacktestResearchLaunchContext | null;
  draft: StrategyDraftRecord | null;
  revisions: StrategyRevisionRecord[];
  datasets: BacktestDataset[];
  runs: BacktestRunRecord[];
  studies: BacktestStudyRecord[];
  activeRun: BacktestRunRecord | null;
  report: BacktestReport | null;
  chart: BacktestChartData | null;
  activeStudy: BacktestStudyRecord | null;
  session: ChartSession;
  returnHref: string;
}

export interface BacktestResearchRuntime {
  view: BacktestResearchRuntimeView;
  actions: {
    selectTask(task: BacktestResearchTask | null): void;
    selectSourceMode(mode: MarketChartSourceMode): void;
    openRun(runId: string): Promise<void>;
    openStudy(studyId: string): Promise<void>;
    refresh(): void;
  };
}
