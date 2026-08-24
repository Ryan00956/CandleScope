import {
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import BacktestEquityCurve from "../BacktestEquityCurve.js";
import { t } from "../../../i18n/index.js";
import type {
  RecentRunCompareV1,
  TradeExplanationV1,
} from "../backtestTypes.js";
import type { ChartStrategyResultBundle } from "./chartStrategyResultCache.js";
import {
  CHART_STRATEGY_TRADE_ROW_HEIGHT,
  chartStrategyMaxDrawdown,
  chartStrategyMetricValue,
  chartStrategyTradeFocusTimeMs,
  chartStrategyVirtualTradeWindow,
} from "./chartStrategyResultModel.js";

function dateTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function signedClass(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? (number > 0 ? "positive" : number < 0 ? "negative" : "flat") : "flat";
}

function fidelityLabel(value: string): string {
  if (value === "BAR_APPROX") return t("chartTester.result.fidelityFast");
  if (value === "AGG_TRADE_EXECUTION") return t("chartTester.result.fidelityPrecise");
  return value;
}

export interface TradeExplanationSelection {
  id: string;
  title: string;
  items: Array<{ label: string; explanation: TradeExplanationV1 }>;
}

function explanationVariable(value: TradeExplanationV1["variables"][string]): string {
  if (value.kind === "null") return "—";
  if (value.kind === "boolean") return value.value ? t("chartTester.explain.true") : t("chartTester.explain.false");
  return value.value;
}

export function TradeExplanationPopover({
  selection,
  onClose,
}: {
  selection: TradeExplanationSelection;
  onClose(): void;
}) {
  return (
    <div className="chart-strategy-explain-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="chart-strategy-explain-popover"
        role="dialog"
        aria-modal="true"
        aria-label={t("chartTester.explain.title")}
        data-testid="trade-explanation-popover"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>{t("chartTester.explain.eyebrow")}</small><strong>{selection.title}</strong></div>
          <button type="button" onClick={onClose}>{t("chartTester.close")}</button>
        </header>
        <div className="chart-strategy-explain-scroll">
          {selection.items.map(({ label, explanation }) => (
            <article key={`${selection.id}:${label}:${explanation.evidenceHash}`}>
              <div className="chart-strategy-explain-summary">
                <strong>{label}</strong>
                <span className={`state-${explanation.completeness.toLowerCase()}`}>
                  {explanation.completeness}
                </span>
              </div>
              {explanation.completeness === "UNAVAILABLE" ? (
                <p className="chart-strategy-explain-unavailable">
                  {t("chartTester.explain.unavailable")}
                </p>
              ) : (
                <>
                  <dl className="chart-strategy-explain-facts">
                    <div><dt>{t("chartTester.explain.strategyReason")}</dt><dd>{explanation.reasonLabel ?? explanation.reasonCode ?? "—"}</dd></div>
                    <div><dt>{t("chartTester.explain.source")}</dt><dd>{explanation.source.line == null ? "—" : t("chartTester.explain.line", { line: explanation.source.line })}</dd></div>
                    <div><dt>{t("chartTester.explain.hostResult")}</dt><dd>{explanation.execution.state}</dd></div>
                    <div><dt>{t("chartTester.explain.hostReason")}</dt><dd>{explanation.execution.reasonCode ?? "—"}</dd></div>
                  </dl>
                  {explanation.conditions.length > 0 && (
                    <div className="chart-strategy-explain-block">
                      <strong>{t("chartTester.explain.conditions")}</strong>
                      {explanation.conditions.map((condition) => (
                        <div key={condition.id}>
                          <code>{condition.label}</code>
                          <span>{condition.result === null ? "—" : condition.result ? t("chartTester.explain.true") : t("chartTester.explain.false")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {Object.keys(explanation.variables).length > 0 && (
                    <div className="chart-strategy-explain-block variables">
                      <strong>{t("chartTester.explain.variables")}</strong>
                      {Object.entries(explanation.variables).map(([name, value]) => (
                        <div key={name}><code>{name}</code><span>{explanationVariable(value)}</span></div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <details className="chart-strategy-explain-technical">
                <summary>{t("chartTester.explain.technical")}</summary>
                <dl>
                  <div><dt>{t("chartTester.explain.decisionId")}</dt><dd>{explanation.decisionId}</dd></div>
                  <div><dt>{t("chartTester.explain.orderId")}</dt><dd>{explanation.orderId ?? "—"}</dd></div>
                  <div><dt>{t("chartTester.explain.fillId")}</dt><dd>{explanation.fillId ?? "—"}</dd></div>
                  <div><dt>{t("chartTester.explain.evidenceHash")}</dt><dd>{explanation.evidenceHash}</dd></div>
                </dl>
              </details>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ChartStrategyResultContextBar({
  result,
  locale,
  stale,
}: {
  result: ChartStrategyResultBundle;
  locale: string;
  stale: boolean;
}) {
  const { config, chart, run } = result;
  const rangeLabel = config.chart_range_mode === "ALL_AVAILABLE"
    ? t("chartTester.settings.allAvailable")
    : t("chartTester.settings.selectedRange");
  const rangeBounds = t("chartTester.settings.dateAbsolute", {
    start: dateTime(config.start_time_ms, locale),
    end: dateTime(config.end_time_ms, locale),
  });
  const fee = t("chartTester.result.feeValue", {
    source: String(config.fee_source ?? "—"),
    taker: String(config.taker_fee_bps ?? "—"),
    maker: String(config.maker_fee_bps ?? "—"),
    slippage: String(config.slippage_bps ?? "—"),
  });
  return (
    <div
      className={stale ? "chart-strategy-result-context stale" : "chart-strategy-result-context"}
      data-testid="chart-strategy-result-context"
      data-result-run-id={run.run_id}
      data-result-cache-key={result.cacheKey}
    >
      <strong>{stale ? t("chartTester.result.stale") : t("chartTester.result.completed")}</strong>
      <span>{chart.symbol} · {chart.interval}</span>
      <span title={rangeBounds}>{rangeLabel} · {rangeBounds}</span>
      <span>{fidelityLabel(run.fidelity_mode)}</span>
      <span title={fee}>{fee}</span>
      <a href={`/backtest.html?run=${encodeURIComponent(run.run_id)}`}>
        {t("chartTester.result.credibility")}
      </a>
    </div>
  );
}

function ResultMetric({ label, value, detail = "" }: { label: string; value: string; detail?: string }) {
  return (
    <div className="chart-strategy-result-metric">
      <span>{label}</span>
      <strong className={signedClass(value)}>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function ChartStrategyResultOverview({
  result,
  stale,
  comparison,
  onOpenTrades,
}: {
  result: ChartStrategyResultBundle;
  stale: boolean;
  comparison?: RecentRunCompareV1 | null;
  onOpenTrades(): void;
}) {
  const { report, chart, run } = result;
  const trades = report.trades ?? [];
  const latest = trades.at(-1) ?? null;
  const equity = report.performance?.equity_daily ?? chart.equity_curve;
  const drawdown = report.performance?.drawdown_daily ?? [];
  const credibility = report.credibility;
  const directComparison = comparison?.comparison?.directComparisonAllowed
    ? comparison.comparison
    : null;
  const netPnlDelta = directComparison?.tradeDiff.netPnl?.delta ?? null;
  const maxDrawdownDelta = directComparison?.tradeDiff.maxDrawdown?.delta ?? null;
  const tradeCountDelta = directComparison?.tradeDiff.tradeCount?.delta ?? null;
  const advancedHref = comparison?.baselineRunId
    ? `/backtest.html?run=${encodeURIComponent(run.run_id)}&compare=${encodeURIComponent(comparison.baselineRunId)}`
    : `/backtest.html?run=${encodeURIComponent(run.run_id)}`;
  return (
    <div className="chart-strategy-result-overview" data-testid="chart-strategy-result-overview">
      {stale && (
        <div className="chart-strategy-stale-guidance">
          <strong>{t("chartTester.result.staleGuidanceTitle")}</strong>
          <span>{t("chartTester.result.staleGuidance")}</span>
        </div>
      )}
      <div className="chart-strategy-result-metrics">
        <ResultMetric
          label={t("chartTester.result.netPnl")}
          value={`${report.metrics.realized_net_pnl ?? "—"} USDT`}
          detail={report.report_label}
        />
        <ResultMetric
          label={t("chartTester.result.maxDrawdown")}
          value={chartStrategyMaxDrawdown(report)}
          detail={t("chartTester.result.closedBasis")}
        />
        <ResultMetric
          label={t("chartTester.result.trades")}
          value={String(report.metrics.trade_count ?? trades.length)}
          detail={t("chartTester.result.fills", { count: report.metrics.fill_count ?? chart.fills.length })}
        />
        <ResultMetric
          label={t("chartTester.result.winRate")}
          value={chartStrategyMetricValue(report.metrics.win_rate)}
          detail={t("chartTester.result.runShort", { run: run.run_id.slice(-8) })}
        />
      </div>
      {comparison && (
        <section className="chart-strategy-run-comparison" data-testid="chart-strategy-run-comparison">
          <div className="chart-strategy-run-comparison-head">
            <div>
              <strong>{t("chartTester.compare.title")}</strong>
              <span>{comparison.baselineRunId
                ? directComparison
                  ? t("chartTester.compare.compatible")
                  : t("chartTester.compare.incompatible")
                : t("chartTester.compare.noBaseline")}</span>
            </div>
            <a href={advancedHref}>{t("chartTester.compare.full")}</a>
          </div>
          {directComparison && (
            <div className="chart-strategy-run-comparison-grid">
              <ResultMetric label={t("chartTester.compare.netPnlDelta")} value={netPnlDelta ?? "—"} />
              <ResultMetric label={t("chartTester.compare.drawdownDelta")} value={maxDrawdownDelta ?? "—"} />
              <ResultMetric label={t("chartTester.compare.tradeCountDelta")} value={tradeCountDelta ?? "—"} />
              <ResultMetric
                label={t("chartTester.compare.tradeChanges")}
                value={directComparison.fingerprintDiff.available
                  ? t("chartTester.compare.addRemove", {
                    added: directComparison.fingerprintDiff.addedCount ?? 0,
                    removed: directComparison.fingerprintDiff.removedCount ?? 0,
                  })
                  : t("chartTester.compare.alignmentUnavailable")}
              />
            </div>
          )}
        </section>
      )}
      <div className="chart-strategy-result-lower">
        <section className="chart-strategy-equity-card">
          <div>
            <strong>{t("chartTester.result.equity")}</strong>
            <span>{t("chartTester.result.equityDetail")}</span>
          </div>
          <BacktestEquityCurve data={equity} drawdown={drawdown} compact />
        </section>
        <aside className="chart-strategy-latest-trade">
          <strong>{latest ? t("chartTester.result.latestTrade", {
            side: latest.side ?? "—",
            price: latest.exit_price ?? latest.entry_price ?? "—",
          }) : t("chartTester.result.zeroTrades")}</strong>
          <span>{latest
            ? t("chartTester.result.latestTradeDetail")
            : t("chartTester.result.zeroTradesDetail")}</span>
          <button type="button" onClick={onOpenTrades} disabled={trades.length === 0}>
            {t("chartTester.result.openTrades")}
          </button>
        </aside>
      </div>
      <details className="chart-strategy-credibility-details">
        <summary>{t("chartTester.result.credibilityDetails")}</summary>
        <dl>
          <div><dt>{t("chartTester.result.credibilityLevel")}</dt><dd>{credibility?.level ?? "—"}</dd></div>
          <div><dt>{t("chartTester.result.sampleRole")}</dt><dd>{credibility?.sample_role ?? report.identity?.sample_role ?? "—"}</dd></div>
          <div><dt>{t("chartTester.result.profitGuarantee")}</dt><dd>{credibility?.profit_guarantee === false ? t("chartTester.result.no") : "—"}</dd></div>
          <div><dt>{t("chartTester.result.reportHash")}</dt><dd title={result.reportHash}>{result.reportHash.slice(0, 18)}…</dd></div>
        </dl>
        <a href={advancedHref}>{t("chartTester.openAdvanced")}</a>
      </details>
    </div>
  );
}

export function ChartStrategyTradeList({
  result,
  locale,
  onLocateTrade,
  onSelectExplanation,
}: {
  result: ChartStrategyResultBundle;
  locale: string;
  onLocateTrade(timeMs: number): void;
  onSelectExplanation?(selection: TradeExplanationSelection): void;
}) {
  const trades = result.report.trades ?? [];
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(224);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const window = useMemo(() => chartStrategyVirtualTradeWindow({
    count: trades.length,
    scrollTop,
    viewportHeight,
  }), [scrollTop, trades.length, viewportHeight]);
  const visible = trades.slice(window.start, window.end);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
  };
  if (trades.length === 0) {
    return (
      <div className="chart-strategy-result-empty" data-testid="chart-strategy-zero-trades">
        <strong>{t("chartTester.result.zeroTrades")}</strong>
        <span>{t("chartTester.result.zeroTradesDetail")}</span>
      </div>
    );
  }
  return (
    <div className="chart-strategy-trades" data-testid="chart-strategy-trades" data-trade-count={trades.length}>
      <div className="chart-strategy-trade-head" aria-hidden="true">
        <span>{t("chartTester.result.trade")}</span><span>{t("chartTester.result.side")}</span>
        <span>{t("chartTester.result.entry")}</span><span>{t("chartTester.result.exit")}</span>
        <span>{t("chartTester.result.netPnl")}</span><span>{t("chartTester.result.fees")}</span>
      </div>
      <div
        ref={viewportRef}
        className="chart-strategy-trade-viewport"
        role="grid"
        aria-rowcount={trades.length}
        onScroll={onScroll}
      >
        <div className="chart-strategy-trade-spacer" style={{ height: `${window.totalHeight}px` }}>
          <div style={{ transform: `translateY(${window.offsetTop}px)` }}>
            {visible.map((trade, offset) => {
              const absoluteIndex = window.start + offset;
              const tradeId = trade.trade_id ?? `trade-${absoluteIndex + 1}`;
              const focusTime = chartStrategyTradeFocusTimeMs(trade);
              const entryTime = Number(trade.entry_time_ms);
              return (
                <button
                  key={`${tradeId}:${absoluteIndex}`}
                  type="button"
                  role="row"
                  aria-rowindex={absoluteIndex + 1}
                  className={selectedTradeId === tradeId ? "chart-strategy-trade-row selected" : "chart-strategy-trade-row"}
                  style={{ height: `${CHART_STRATEGY_TRADE_ROW_HEIGHT}px` }}
                  onClick={() => {
                    setSelectedTradeId(tradeId);
                    if (focusTime !== null) onLocateTrade(focusTime);
                    const items = [
                      ...(trade.entry_explanation
                        ? [{ label: t("chartTester.explain.entry"), explanation: trade.entry_explanation }]
                        : []),
                      ...(trade.exit_explanation
                        ? [{ label: t("chartTester.explain.exit"), explanation: trade.exit_explanation }]
                        : []),
                    ];
                    if (items.length > 0) {
                      onSelectExplanation?.({
                        id: tradeId,
                        title: t("chartTester.explain.tradeTitle", { trade: tradeId }),
                        items,
                      });
                    }
                  }}
                >
                  <span>{tradeId}</span>
                  <span>{trade.side ?? "—"}</span>
                  <span title={Number.isFinite(entryTime) ? dateTime(entryTime, locale) : "—"}>{trade.entry_price ?? "—"}</span>
                  <span>{trade.exit_price ?? "—"}</span>
                  <span className={signedClass(trade.net_pnl ?? "")}>{trade.net_pnl ?? "—"}</span>
                  <span>{trade.fees ?? "—"}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
