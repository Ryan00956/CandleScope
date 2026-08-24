import type { BacktestApiClient } from "../backtestApi.js";
import type {
  BacktestChartData,
  BacktestReport,
  BacktestRunRecord,
} from "../backtestTypes.js";

export interface ChartStrategyCompletedRunConfig extends Record<string, unknown> {
  start_time_ms: number;
  end_time_ms: number;
  interval?: string;
  exchange?: string;
  market_type?: string;
  chart_range_mode?: "ALL_AVAILABLE" | "VISIBLE" | "CUSTOM";
  fee_source?: string;
  maker_fee_bps?: string;
  taker_fee_bps?: string;
  slippage_bps?: string;
  quick_preset_id?: string;
  quick_preset_revision?: string;
}

export interface ChartStrategyResultBundle {
  cacheKey: string;
  run: BacktestRunRecord;
  report: BacktestReport;
  chart: BacktestChartData;
  config: ChartStrategyCompletedRunConfig;
  reportHash: string;
  chartHash: string;
}

export class ChartStrategyResultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChartStrategyResultError";
  }
}

function requiredString(value: unknown, code: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ChartStrategyResultError(code, `${label} is missing`);
  return normalized;
}

export function parseChartStrategyCompletedRunConfig(
  run: BacktestRunRecord,
): ChartStrategyCompletedRunConfig {
  const raw = requiredString(run.config_json, "RESULT_CONFIG_MISSING", "completed Run config");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ChartStrategyResultError("RESULT_CONFIG_INVALID", "completed Run config is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChartStrategyResultError("RESULT_CONFIG_INVALID", "completed Run config is invalid");
  }
  const config = value as Record<string, unknown>;
  const startTimeMs = Number(config.start_time_ms);
  const endTimeMs = Number(config.end_time_ms);
  if (!Number.isSafeInteger(startTimeMs)
    || !Number.isSafeInteger(endTimeMs)
    || startTimeMs >= endTimeMs) {
    throw new ChartStrategyResultError(
      "RESULT_RANGE_INVALID",
      "completed Run range is missing or invalid",
    );
  }
  return {
    ...config,
    start_time_ms: startTimeMs,
    end_time_ms: endTimeMs,
  };
}

function buildBundle(
  run: BacktestRunRecord,
  report: BacktestReport,
  chart: BacktestChartData,
): ChartStrategyResultBundle {
  if (run.state !== "COMPLETED") {
    throw new ChartStrategyResultError("RESULT_NOT_COMPLETED", "Run is not completed");
  }
  if (report.runId !== run.run_id || chart.run_id !== run.run_id) {
    throw new ChartStrategyResultError(
      "RESULT_IDENTITY_MISMATCH",
      "Run, report, and chart identities do not match",
    );
  }
  const reportHash = requiredString(
    report.hashes?.report,
    "RESULT_REPORT_HASH_MISSING",
    "report hash",
  );
  const chartHash = requiredString(
    chart.chart_hash,
    "RESULT_CHART_HASH_MISSING",
    "chart hash",
  );
  return Object.freeze({
    cacheKey: `${run.run_id}|${reportHash}|${chartHash}`,
    run: Object.freeze({ ...run }),
    report,
    chart,
    config: Object.freeze(parseChartStrategyCompletedRunConfig(run)),
    reportHash,
    chartHash,
  });
}

type ResultApi = Pick<BacktestApiClient, "getRun" | "getReport" | "getChart">;

export class ChartStrategyResultCache {
  private readonly entries = new Map<string, ChartStrategyResultBundle>();

  async load(
    api: ResultApi,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ChartStrategyResultBundle> {
    const run = await api.getRun(runId, signal);
    if (run.state !== "COMPLETED") {
      throw new ChartStrategyResultError("RESULT_NOT_COMPLETED", "Run is not completed");
    }
    const cached = this.entries.get(runId);
    if (cached && cached.run.config_hash === run.config_hash) return cached;
    const [report, chart] = await Promise.all([
      api.getReport(runId, signal),
      api.getChart(runId, signal),
    ]);
    const bundle = buildBundle(run, report, chart);
    this.entries.set(runId, bundle);
    return bundle;
  }

  peek(runId: string): ChartStrategyResultBundle | null {
    return this.entries.get(runId) ?? null;
  }

  clear(runId?: string): void {
    if (runId === undefined) this.entries.clear();
    else this.entries.delete(runId);
  }

  diagnostics(): { entries: number; keys: string[] } {
    return {
      entries: this.entries.size,
      keys: [...this.entries.values()].map((entry) => entry.cacheKey).sort(),
    };
  }
}

export const chartStrategyResultCache = new ChartStrategyResultCache();
