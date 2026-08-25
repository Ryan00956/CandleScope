import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { BacktestDataset, BacktestSnapshot } from "../backtestApi.js";
import type {
  BacktestChartData,
  BacktestResearchDatasetIdentity,
  BacktestResearchLaunchContext,
  BacktestReport,
  BacktestRunRecord,
} from "../backtestTypes.js";
import type {
  BacktestResearchPanel,
  BacktestResearchTask,
} from "./backtestResearchTypes.js";
import type { MarketChartSourceMode } from "../../market-chart-platform/marketChartSourceRuntime.js";

const TASK_PANELS: Readonly<Record<BacktestResearchTask, readonly BacktestResearchPanel[]>> = {
  PRECISE_EXECUTION: ["STRATEGY", "DATA", "EXECUTION", "RUN", "RESULTS"],
  PARAMETER_ROBUSTNESS: ["STRATEGY", "DATA", "STUDY", "RESULTS"],
  PYTHON_MODEL: ["STRATEGY", "EXECUTION", "RUN", "RESULTS"],
  MULTI_MARKET: ["STRATEGY", "DATA", "RUN", "RESULTS"],
  REPLAY_REVIEW: ["RUN", "REPLAY", "RESULTS"],
};

export function backtestResearchPanels(task: BacktestResearchTask): readonly BacktestResearchPanel[] {
  return TASK_PANELS[task];
}

export function backtestResearchHasPanel(
  task: BacktestResearchTask,
  panel: BacktestResearchPanel,
): boolean {
  return TASK_PANELS[task].includes(panel);
}

function parseRunConfig(run: BacktestRunRecord | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(run?.config_json ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function researchSessionFromAuthority(input: {
  context: BacktestResearchLaunchContext | null;
  run: BacktestRunRecord | null;
  chart: BacktestChartData | null;
  fallback?: ChartSession;
}): ChartSession {
  if (input.run) {
    const config = parseRunConfig(input.run);
    return {
      exchange: String(config.exchange ?? input.fallback?.exchange ?? "binance"),
      marketType: String(config.market_type ?? input.fallback?.marketType ?? "usdm"),
      symbol: String(input.chart?.symbol ?? config.symbol ?? input.fallback?.symbol ?? "BTCUSDT"),
      interval: String(input.chart?.interval ?? config.interval ?? input.fallback?.interval ?? "15m"),
    } as ChartSession;
  }
  if (input.context) {
    return {
      exchange: input.context.chart_session.exchange,
      marketType: input.context.chart_session.market_type,
      symbol: input.context.chart_session.symbol,
      interval: input.context.chart_session.interval,
    };
  }
  return {
    exchange: input.fallback?.exchange ?? "binance",
    marketType: input.fallback?.marketType ?? "usdm",
    symbol: input.chart?.symbol ?? input.fallback?.symbol ?? "BTCUSDT",
    interval: input.chart?.interval ?? input.fallback?.interval ?? "15m",
  } as ChartSession;
}

function safeId(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
}

export function researchReturnHref(context: BacktestResearchLaunchContext | null): string {
  const workspace = safeId(context?.source_workspace_id ?? null);
  const cell = safeId(context?.source_cell_id ?? null);
  if (workspace === "strategy-research") {
    return cell === "imported" ? "/strategy.html?source=imported" : "/strategy.html";
  }
  if (!workspace || !cell) return "/";
  const query = new URLSearchParams({ workspace, cell, source: "backtest-research" });
  return `/?${query.toString()}`;
}

export function researchRunIdentityReady(input: {
  run: BacktestRunRecord | null;
  report: BacktestReport | null;
  chart: BacktestChartData | null;
}): boolean {
  const reportHash = input.report?.hashes?.report ?? input.run?.result?.report_hash;
  return Boolean(
    input.run?.run_id
    && input.run.config_hash
    && reportHash
    && input.chart?.chart_hash
    && input.chart.run_id === input.run.run_id,
  );
}

export function researchFrozenSnapshotIdentity(input: {
  dataset: BacktestDataset | null;
  snapshot: BacktestSnapshot | null;
  run: BacktestRunRecord | null;
  report: BacktestReport | null;
  chart: BacktestChartData | null;
}): BacktestResearchDatasetIdentity | null {
  const { dataset, snapshot, run, report, chart } = input;
  if (!dataset || !snapshot || !run || !chart) return null;
  if (!researchRunIdentityReady({ run, report, chart })) return null;
  if (
    run.dataset_id !== dataset.dataset_id
    || run.data_epoch !== snapshot.data_epoch
    || run.snapshot_hash !== snapshot.snapshot_hash
    || chart.symbol !== dataset.symbol
    || chart.interval !== dataset.interval
  ) return null;
  return {
    dataset_id: dataset.dataset_id,
    data_epoch: snapshot.data_epoch,
    snapshot_hash: snapshot.snapshot_hash,
  };
}

export function shouldEnableBacktestResearchLiveSource(
  runtimeMode: "LIVE" | "LOCAL_OFFLINE" | null,
  sourceMode: MarketChartSourceMode,
): boolean {
  return runtimeMode !== "LOCAL_OFFLINE" && sourceMode === "LIVE_REFERENCE";
}
