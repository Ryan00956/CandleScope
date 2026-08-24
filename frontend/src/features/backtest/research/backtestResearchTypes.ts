import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { MarketChartSourceMode } from "../../market-chart-platform/marketChartSourceRuntime.js";
import type {
  BacktestStudyComparison,
  BacktestReport,
  BacktestChartData,
  BacktestResearchLaunchContext,
  RunCompareV3,
  SignalTraceItem,
  BacktestRunRecord,
  BacktestStudyRecord,
} from "../backtestTypes.js";
import type {
  BacktestCapabilities,
  BacktestDataset,
  BacktestSnapshot,
  StrategyRevisionRecord,
} from "../backtestApi.js";
import type { StrategyDraftRecord } from "../chart-tester/StrategyDraftStore.js";
import type { PythonStudioGate } from "../pythonStudio.js";

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
  | "REPLAY"
  | "RESULTS";

export interface BacktestResearchRuntimeView {
  phase: "LOADING" | "READY" | "ERROR";
  error: string | null;
  advancedEnabled: boolean;
  capabilities: BacktestCapabilities | null;
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
  busy: boolean;
  notice: string | null;
  operationError: string | null;
  selectedDatasetId: string;
  selectedRevisionId: string;
  startTimeMs: number;
  endTimeMs: number;
  snapshot: BacktestSnapshot | null;
  runDraftText: string;
  studyDraftText: string;
  runComparison: RunCompareV3 | null;
  studyComparison: BacktestStudyComparison | null;
  signalTrace: SignalTraceItem[];
  reviewBridge: Record<string, unknown> | null;
  pythonGate: PythonStudioGate | null;
}

export interface BacktestResearchRuntime {
  view: BacktestResearchRuntimeView;
  actions: {
    selectTask(task: BacktestResearchTask | null): void;
    selectSourceMode(mode: MarketChartSourceMode): void;
    openRun(runId: string): Promise<void>;
    openStudy(studyId: string): Promise<void>;
    refresh(): void;
    selectDataset(datasetId: string): void;
    selectRevision(revisionId: string): void;
    setRange(startTimeMs: number, endTimeMs: number): void;
    setRunDraftText(text: string): void;
    resetRunDraft(): void;
    setStudyDraftText(text: string): void;
    resetStudyDraft(): void;
    createStrategyRevision(body: Record<string, unknown>): Promise<void>;
    copyStrategyRevision(): Promise<void>;
    archiveStrategyRevision(): Promise<void>;
    smokeStrategyRevision(): Promise<void>;
    createRun(): Promise<void>;
    cancelRun(): Promise<void>;
    resumeRun(): Promise<void>;
    cloneRun(parameter: string, value: unknown): Promise<void>;
    compareRun(otherRunId: string): Promise<void>;
    exportRun(): Promise<void>;
    loadSignalTrace(): Promise<void>;
    createStudy(): Promise<void>;
    startStudy(): Promise<void>;
    cancelStudy(): Promise<void>;
    revealStudyHoldout(): Promise<void>;
    compareStudy(): Promise<void>;
    createReviewBridge(): Promise<void>;
    revealReviewBridge(): Promise<void>;
    setBusy(busy: boolean): void;
    setNotice(notice: string | null): void;
    setOperationError(error: string | null): void;
    acceptStrategyRevision(revision: StrategyRevisionRecord): void;
    setPythonGate(gate: PythonStudioGate): void;
  };
}
