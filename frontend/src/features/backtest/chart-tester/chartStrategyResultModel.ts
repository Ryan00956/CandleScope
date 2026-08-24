import type { ExportScope } from "../../export/exportTypes.js";
import type { BacktestReport } from "../backtestTypes.js";

export const CHART_STRATEGY_TRADE_ROW_HEIGHT = 38;
export const CHART_STRATEGY_TRADE_OVERSCAN_ROWS = 6;

export interface VirtualTradeWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function chartStrategyVirtualTradeWindow({
  count,
  scrollTop,
  viewportHeight,
  rowHeight = CHART_STRATEGY_TRADE_ROW_HEIGHT,
  overscan = CHART_STRATEGY_TRADE_OVERSCAN_ROWS,
}: {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight?: number;
  overscan?: number;
}): VirtualTradeWindow {
  const safeCount = Math.max(0, Math.floor(count));
  const safeHeight = Math.max(1, rowHeight);
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeHeight) - overscan);
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / safeHeight);
  const end = Math.min(safeCount, first + visibleRows + overscan * 2);
  return {
    start: Math.min(first, end),
    end,
    offsetTop: Math.min(first, end) * safeHeight,
    totalHeight: safeCount * safeHeight,
  };
}

export function chartStrategyMetricValue(value: unknown, fallback = "—"): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const metric = value as { value?: unknown; reason?: unknown };
    if (metric.value !== null && metric.value !== undefined) return String(metric.value);
    if (metric.reason) return fallback;
  }
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function chartStrategyMaxDrawdown(report: BacktestReport): string {
  const risk = report.performance?.risk ?? {};
  return chartStrategyMetricValue(
    risk.max_drawdown ?? risk.max_drawdown_percent ?? risk.maximum_drawdown,
  );
}

export function chartStrategyTradeFocusTimeMs(trade: Record<string, string>): number | null {
  const value = Number(trade.entry_time_ms ?? trade.exit_time_ms);
  return Number.isFinite(value) ? value : null;
}

export function chartStrategyResultIncludedInExportScope(scope: ExportScope): boolean {
  return scope === "page";
}
