export type StrategyResearchLegacyStatus = "migrated" | "deferred";

export type StrategyResearchLegacyEntry = {
  id: string;
  capability: string;
  legacy: string;
  unified: string;
  status: StrategyResearchLegacyStatus;
  followUp: string | null;
};

export const STRATEGY_RESEARCH_LEGACY_MAP: readonly StrategyResearchLegacyEntry[] = [
  {
    id: "csv-import-poll",
    capability: "CSV import job polling",
    legacy: "LocalApp via useResearchDataLibrary",
    unified: "pollResearchImportJob in useResearchDataLibrary",
    status: "migrated",
    followUp: null,
  },
  {
    id: "dataset-selection",
    capability: "Imported dataset selection",
    legacy: "LocalApp selectedId / BacktestApp datasetId",
    unified: "ResearchDataDrawer + StrategyResearchRuntime source slice",
    status: "migrated",
    followUp: null,
  },
  {
    id: "imported-chart-analysis",
    capability: "Imported chart, drawings, events, indicators, export",
    legacy: "LocalApp assembly",
    unified: "StrategyResearchImportedWorkspace",
    status: "migrated",
    followUp: null,
  },
  {
    id: "project-package",
    capability: ".csproject import/export, events, drawings, indicators",
    legacy: "ResearchDatasetManagement used by LocalApp",
    unified: "ResearchDatasetManagement in the unified drawer",
    status: "migrated",
    followUp: null,
  },
  {
    id: "script-drafts",
    capability: "Strategy script drafts",
    legacy: "candlescope-strategy-drafts-v1",
    unified: "StrategyDraftStore shared by chart-first and research",
    status: "migrated",
    followUp: null,
  },
  {
    id: "python-studio",
    capability: "Python strategy studio",
    legacy: "BacktestApp PythonStudioPanel",
    unified: "ResearchStrategyPanel PYTHON_MODEL",
    status: "migrated",
    followUp: null,
  },
  {
    id: "revision-compile-smoke",
    capability: "Immutable revision compile, smoke, copy, archive",
    legacy: "BacktestApp revision workspace",
    unified: "ResearchStrategyPanel",
    status: "migrated",
    followUp: null,
  },
  {
    id: "run-poll",
    capability: "Backtest Run polling",
    legacy: "BacktestApp window.setInterval refreshWorkspace",
    unified: "pollBacktestRunToTerminal and useBacktestResearchRuntime",
    status: "migrated",
    followUp: null,
  },
  {
    id: "clone-run",
    capability: "Clone a completed Run",
    legacy: "BacktestApp newImmutable",
    unified: "ResearchRunPanel cloneRun",
    status: "migrated",
    followUp: null,
  },
  {
    id: "compare-trade-diff",
    capability: "Trade/cost comparison deltas",
    legacy: "BacktestApp compare tab",
    unified: "ChartStrategyResultViews and research RESULTS",
    status: "migrated",
    followUp: null,
  },
  {
    id: "replay-review-reveal",
    capability: "Replay review bridge create/reveal",
    legacy: "BacktestApp revealCompare",
    unified: "ResearchReplayPanel",
    status: "migrated",
    followUp: null,
  },
  {
    id: "rsi-trace-pane",
    capability: "Legacy M9 RSI trace pane in the form workbench",
    legacy: "BacktestApp rsi-trace-pane",
    unified: "not ported; PYTHON_MODEL uses PythonStudioPanel diagnostics",
    status: "deferred",
    followUp: "Later research-results work can port the M9 RSI trace pane; do not treat absence as a deleted product contract.",
  },
  {
    id: "decision-fill-hash-row",
    capability: "Legacy decision/fill hash comparison row",
    legacy: "BacktestApp backtest.decisionFillHashes",
    unified: "Run identity hashes remain on FrozenResearchContext and report hashes",
    status: "deferred",
    followUp: "Surface the same hashes in research RESULTS if a later UX pass needs the M9 row.",
  },
  {
    id: "bounded-fill-table",
    capability: "Legacy bounded fill/order HTML table",
    legacy: "BacktestApp boundedRows(report.fills)",
    unified: "Chart-first result projections already bound long curves/tables",
    status: "deferred",
    followUp: "Keep using chart-first bounded projections; do not revive the M9 DOM table.",
  },
];
