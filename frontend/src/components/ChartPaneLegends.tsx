import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { formatIndicatorNotional } from "../chart-adapter/seriesLifecycle.js";
import type { IndicatorLine, MainSeriesCrosshairValue } from "../chart-adapter/chartAdapterTypes.js";
import type { IndicatorSubPane } from "../features/indicators/indicatorPaneProjection.js";
import {
  buildMarketSummary,
  formatPrice,
  formatPriceDiff,
  formatVolume,
} from "../features/market-data/marketDataView.js";
import type { KlineBar } from "../features/market-data/marketDataTypes.js";
import type { SeriesWindowStore } from "../features/market-data/window/seriesWindowStore.js";
import type { PaneCrosshairStore } from "./paneCrosshairStore.js";
import {
  groupChartPaneLegendValues,
  resolveChartPaneLegendValues,
  type ChartPaneLegendValue,
} from "./chartPaneLegendModel.js";

interface MainChartLegendProps {
  allowSourceCrosshairFallback: boolean;
  crosshair: MainSeriesCrosshairValue | null;
  crosshairStore: PaneCrosshairStore;
  lines: readonly IndicatorLine[];
  seriesStore: SeriesWindowStore | null;
}

interface IndicatorPaneLabelsProps {
  collapsedPaneIds: readonly string[];
  crosshairStore: PaneCrosshairStore;
  linesByPaneId: ReadonlyMap<string, readonly IndicatorLine[]>;
  panes: readonly IndicatorSubPane[];
}

interface MainLegendData {
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number | null;
}

function completeMainLegendData(
  value: MainSeriesCrosshairValue | KlineBar | null | undefined,
): MainLegendData | null {
  if (!value
    || typeof value.open !== "number" || !Number.isFinite(value.open)
    || typeof value.high !== "number" || !Number.isFinite(value.high)
    || typeof value.low !== "number" || !Number.isFinite(value.low)
    || typeof value.close !== "number" || !Number.isFinite(value.close)) {
    return null;
  }
  return {
    close: value.close,
    high: value.high,
    low: value.low,
    open: value.open,
    volume: typeof value.volume === "number" && Number.isFinite(value.volume) ? value.volume : null,
  };
}

function trimTrailingZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function formatGenericIndicatorValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${trimTrailingZeros((value / 1_000_000_000).toFixed(2))}B`;
  if (absolute >= 1_000_000) return `${trimTrailingZeros((value / 1_000_000).toFixed(2))}M`;
  if (absolute >= 1_000) return `${trimTrailingZeros((value / 1_000).toFixed(2))}K`;
  if (absolute >= 1) return trimTrailingZeros(value.toFixed(4));
  return trimTrailingZeros(value.toFixed(6));
}

function formatLegendValue(item: ChartPaneLegendValue): string {
  if (item.value === null) return "—";
  if (item.valueFormat === "notional") return formatIndicatorNotional(item.value);
  if (item.pane === "volume") return formatVolume(item.value);
  if (item.overlay) return formatPrice(item.value);
  return formatGenericIndicatorValue(item.value);
}

function useSeriesStoreVersion(seriesStore: SeriesWindowStore | null): number {
  const subscribe = useCallback((listener: () => void) => {
    if (!seriesStore) return () => undefined;
    return seriesStore.subscribe(() => listener());
  }, [seriesStore]);
  const getSnapshot = useCallback(() => Number(seriesStore?.version ?? 0), [seriesStore]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

function LegendValues({
  entries,
  showLineNames,
}: {
  entries: readonly ChartPaneLegendValue[];
  showLineNames: boolean;
}) {
  return (
    <span className="chart-legend-values">
      {entries.map((entry) => (
        <span className="chart-legend-value" key={entry.id}>
          {entry.color && <span className="chart-legend-swatch" style={{ backgroundColor: entry.color }} />}
          {showLineNames && <span className="chart-legend-line-name">{entry.label}</span>}
          <span className="chart-legend-number">{formatLegendValue(entry)}</span>
        </span>
      ))}
    </span>
  );
}

export const MainChartLegend = memo(function MainChartLegend({
  allowSourceCrosshairFallback,
  crosshair,
  crosshairStore,
  lines,
  seriesStore,
}: MainChartLegendProps) {
  const storeVersion = useSeriesStoreVersion(seriesStore);
  const crosshairTime = useSyncExternalStore(
    crosshairStore.subscribe,
    crosshairStore.getSnapshot,
    crosshairStore.getSnapshot,
  );
  const latestBar = useMemo(() => {
    void storeVersion;
    return seriesStore?.last() ?? null;
  }, [seriesStore, storeVersion]);
  const exactCrosshair = crosshairTime !== null
    && typeof crosshair?.time === "number"
    && crosshair.time === crosshairTime
    ? crosshair
    : null;
  const sourceCrosshairBar = useMemo(() => {
    if (crosshairTime === null || !allowSourceCrosshairFallback) return null;
    return seriesStore?.getByTime(crosshairTime) ?? null;
  }, [allowSourceCrosshairFallback, crosshairTime, seriesStore]);
  const mainData = completeMainLegendData(
    crosshairTime === null ? latestBar : (exactCrosshair || sourceCrosshairBar),
  );
  const marketSummary = mainData
    ? buildMarketSummary({
      close: mainData.close,
      high: mainData.high,
      low: mainData.low,
      open: mainData.open,
      ...(mainData.volume === null ? {} : { volume: mainData.volume }),
    })
    : null;
  const indicatorEntries = useMemo(
    () => resolveChartPaneLegendValues(lines, crosshairTime, { overlay: true }),
    [crosshairTime, lines],
  );
  const indicatorRows = useMemo(
    () => groupChartPaneLegendValues(indicatorEntries),
    [indicatorEntries],
  );

  if (!mainData && indicatorEntries.length === 0) return null;
  const isUp = marketSummary?.isUp ?? true;
  const ariaLabel = mainData && marketSummary
    ? `主图信息：开盘 ${formatPrice(mainData.open)}，最高 ${formatPrice(mainData.high)}，最低 ${formatPrice(mainData.low)}，收盘 ${formatPrice(mainData.close)}，成交量 ${formatVolume(mainData.volume)}，涨跌 ${formatPriceDiff(mainData.close - mainData.open)}，涨跌幅 ${marketSummary.priceChange.toFixed(2)}%，振幅 ${marketSummary.amplitude}%`
    : "主图指标信息";

  return (
    <div className="chart-main-legend pane-overlay-anchor" data-pane-id="main" role="group" aria-label={ariaLabel}>
      {mainData && (
        <span className="chart-main-ohlcv">
          <span><span className="chart-legend-key">O</span>{formatPrice(mainData.open)}</span>
          <span><span className="chart-legend-key">H</span><strong className="chart-legend-high">{formatPrice(mainData.high)}</strong></span>
          <span><span className="chart-legend-key">L</span><strong className="chart-legend-low">{formatPrice(mainData.low)}</strong></span>
          <span><span className="chart-legend-key">C</span><strong className={isUp ? "price-up" : "price-down"}>{formatPrice(mainData.close)}</strong></span>
          <span><span className="chart-legend-key">Vol</span>{formatVolume(mainData.volume)}</span>
          {marketSummary && (
            <span>
              <span className="chart-legend-key">涨跌</span>
              <strong className={isUp ? "price-up" : "price-down"}>
                {isUp ? "+" : "-"}{formatPriceDiff(mainData.close - mainData.open)} / {isUp ? "+" : ""}{marketSummary.priceChange.toFixed(2)}%
              </strong>
            </span>
          )}
          {marketSummary && (
            <span><span className="chart-legend-key">振幅</span>{marketSummary.amplitude}%</span>
          )}
        </span>
      )}
      {indicatorRows.map((row) => (
        <div className="chart-main-indicator-row" key={row.id}>
          <LegendValues entries={row.entries} showLineNames />
        </div>
      ))}
    </div>
  );
});

const IndicatorPaneLabel = memo(function IndicatorPaneLabel({
  collapsed,
  crosshairTime,
  lines,
  pane,
}: {
  collapsed: boolean;
  crosshairTime: number | null;
  lines: readonly IndicatorLine[];
  pane: IndicatorSubPane;
}) {
  const entries = useMemo(
    () => resolveChartPaneLegendValues(lines, crosshairTime),
    [crosshairTime, lines],
  );
  const noHistoricalData = crosshairTime !== null
    && entries.length > 0
    && entries.every((entry) => entry.value === null);
  const ariaLabel = entries.length > 0
    ? `${pane.label}：${entries.map((entry) => `${entry.label} ${formatLegendValue(entry)}`).join("，")}`
    : pane.label;

  return (
    <div
      className="chart-pane-label indicator-pane-label pane-overlay-anchor"
      data-pane-collapsed={collapsed ? "true" : "false"}
      data-pane-id={pane.id}
      role="group"
      aria-label={ariaLabel}
    >
      <span className="chart-pane-label-heading">{pane.label}</span>
      {entries.length > 0 && <LegendValues entries={entries} showLineNames={entries.length > 1} />}
      {noHistoricalData && <span className="chart-pane-label-status">该 K 线无数据</span>}
    </div>
  );
});

export const IndicatorPaneLabels = memo(function IndicatorPaneLabels({
  collapsedPaneIds,
  crosshairStore,
  linesByPaneId,
  panes,
}: IndicatorPaneLabelsProps) {
  const crosshairTime = useSyncExternalStore(
    crosshairStore.subscribe,
    crosshairStore.getSnapshot,
    crosshairStore.getSnapshot,
  );
  const collapsedIds = useMemo(() => new Set(collapsedPaneIds), [collapsedPaneIds]);

  return panes
    .filter((pane) => !pane.dataMarketPane)
    .map((pane) => (
      <IndicatorPaneLabel
        collapsed={collapsedIds.has(pane.id)}
        crosshairTime={crosshairTime}
        key={pane.id}
        lines={linesByPaneId.get(pane.id) || []}
        pane={pane}
      />
    ));
});
