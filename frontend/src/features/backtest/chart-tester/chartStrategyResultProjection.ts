import type { ExternalSeriesMarker } from "../../../chart-adapter/externalMarkerSource.js";
import { floorIntervalTime } from "../../../utils/intervalTimeline.js";
import type { BacktestChartData, BacktestReport } from "../backtestTypes.js";

export interface BacktestMarkerLabels {
  actions: Readonly<Record<string, string>>;
  rejection: string;
}

export function projectBacktestResultMarkers(
  chart: BacktestChartData,
  options: {
    hasTime(time: number): boolean;
    labels: BacktestMarkerLabels;
  },
): ExternalSeriesMarker[] {
  const fillMarkers = chart.fills.flatMap((fill, index) => {
    const eventTimeMs = Number(fill.event_time_ms);
    const displayTime = floorIntervalTime(chart.interval, eventTimeMs / 1_000);
    if (displayTime === null || !options.hasTime(displayTime)) return [];
    const side = String(fill.side || "").toUpperCase();
    const action = String(fill.action || side);
    return [{
      id: `backtest:${String(fill.order_id || index)}:${index}`,
      time: displayTime,
      position: side === "BUY" ? "belowBar" : "aboveBar",
      color: side === "BUY" ? "#22c55e" : "#ef4444",
      shape: side === "BUY" ? "arrowUp" : "arrowDown",
      text: `${options.labels.actions[action] ?? action} ${String(fill.price || "")}`,
      size: 1.2,
    } satisfies ExternalSeriesMarker];
  });
  const rejectionMarkers = (chart.rejected_orders ?? []).flatMap((rejection, index) => {
    const eventTimeMs = Number(rejection.event_time_ms);
    const displayTime = floorIntervalTime(chart.interval, eventTimeMs / 1_000);
    if (displayTime === null || !options.hasTime(displayTime)) return [];
    return [{
      id: `backtest:rejected:${String(rejection.sequence ?? index)}:${index}`,
      time: displayTime,
      position: "aboveBar",
      color: "#f59e0b",
      shape: "square",
      text: options.labels.rejection,
      size: 1,
    } satisfies ExternalSeriesMarker];
  });
  // Preserve the legacy marker ordering contract: fills retain input order,
  // followed by rejections in input order. A same-time fill and rejection are
  // distinct markers and must both survive the projection.
  return [...fillMarkers, ...rejectionMarkers];
}

export function boundBacktestProjectionRows<T>(
  rows: readonly T[],
  limit = 2_000,
): readonly T[] {
  if (rows.length <= limit) return rows;
  const step = Math.ceil(rows.length / limit);
  return rows
    .filter((_item, index) => index % step === 0 || index === rows.length - 1)
    .slice(-limit);
}

export function projectEquityPolyline(
  data: readonly Record<string, string | number>[],
): string {
  const values = data
    .map((item) => Number(item.equity))
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return "";
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, Math.abs(high) * 0.0001, 1);
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * 1_000;
    const y = 190 - ((value - low) / span) * 170;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export function projectDrawdownPolyline(
  data: readonly Record<string, string | number>[],
): string {
  const values = data.map((item) => Number(item.drawdown));
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return "";
  const low = Math.min(...values, -0.000001);
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * 1_000;
    const y = 105 + (Math.abs(value) / Math.abs(low)) * 85;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export interface BacktestReportSummary {
  reportLabel: string;
  fillCount: number;
  tradeCount: number;
  finalEquity: string;
}

export function projectBacktestReportSummary(
  report: BacktestReport,
): BacktestReportSummary {
  return {
    reportLabel: report.report_label,
    fillCount: report.metrics.fill_count,
    tradeCount: report.metrics.trade_count ?? 0,
    finalEquity: String(report.account?.equity ?? "—"),
  };
}

export interface FocusedTradeViewModel {
  tradeId: string | null;
  entryPrice: string;
  exitPrice: string;
  mae: string;
  mfe: string;
  entryReason: string;
  exitReason: string;
  decisionTimeMs: number;
  acceptedTimeMs: number;
  fillTimeMs: number;
  chartFocusTimeMs: number;
  fees: string;
  funding: string;
}

export function projectFocusedTrade(
  trades: readonly Record<string, string>[],
  focusedTradeId: string | null,
): FocusedTradeViewModel | null {
  if (focusedTradeId === null) return null;
  const trade = trades.find((item) => item.trade_id === focusedTradeId);
  if (!trade) return null;
  const fillTimeMs = Number(trade.entry_time_ms);
  return {
    tradeId: trade.trade_id ?? null,
    entryPrice: trade.entry_price ?? "—",
    exitPrice: trade.exit_price ?? "—",
    mae: trade.mae || "—",
    mfe: trade.mfe || "—",
    entryReason: trade.entry_reason || "—",
    exitReason: trade.exit_reason || "—",
    decisionTimeMs: Number(trade.decision_time_ms ?? trade.entry_time_ms),
    acceptedTimeMs: Number(trade.order_accepted_time_ms ?? trade.entry_time_ms),
    fillTimeMs,
    chartFocusTimeMs: fillTimeMs,
    fees: trade.fees ?? "—",
    funding: trade.funding ?? "—",
  };
}
