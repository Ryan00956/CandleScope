import { createIntervalTimeline, type IntervalTimeline } from "../../utils/intervalTimeline.js";
import type {
  IndicatorPaneLegendItem,
  IndicatorPanePointMetadata,
  IndicatorSubPane,
} from "../indicators/indicatorPaneProjection.js";
import type { IndicatorLine, IndicatorValuePoint } from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  LiquidationEvent,
  LiquidationRollup,
  LiquidationRuntimeView,
  LiquidationSnapshot,
} from "./liquidationTypes.js";

export const LIQUIDATION_LONG_COLOR = "#ef4444";
export const LIQUIDATION_SHORT_COLOR = "#22c55e";

const LIQUIDATION_LEGEND: readonly IndicatorPaneLegendItem[] = Object.freeze([
  {
    id: "liquidated-long",
    label: "多头爆仓",
    appearance: "solid",
    description: "被强制卖出的多头仓位观测名义金额",
    color: LIQUIDATION_LONG_COLOR,
  },
  {
    id: "liquidated-short",
    label: "空头爆仓",
    appearance: "solid",
    description: "被强制买回的空头仓位观测名义金额",
    color: LIQUIDATION_SHORT_COLOR,
  },
]);

interface ProjectedBucket {
  time: number;
  longNotional: number | null;
  shortNotional: number | null;
  hasLiveEvents: boolean;
  allRowsFinal: boolean;
}

interface MutableProjectedBucket {
  time: number;
  longNotional: number | null;
  shortNotional: number | null;
  hasLiveEvents: boolean;
  allRowsFinal: boolean;
  rowCount: number;
}

function formatNotional(value: number): string {
  const absolute = Math.abs(value);
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ] as const;
  const unit = units.find((candidate) => absolute >= candidate.threshold);
  if (!unit) return `$${absolute.toFixed(absolute >= 100 ? 0 : 2).replace(/\.00$/, "")}`;
  const scaled = absolute / unit.threshold;
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `$${scaled.toFixed(precision).replace(/\.0+$/, "")}${unit.suffix}`;
}

function barIndexAt(
  bars: readonly KlineBar[],
  sampleTimeSeconds: number,
  timeline: IntervalTimeline,
): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const bar = bars[middle];
    if (bar && bar.time <= sampleTimeSeconds) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  const bar = bars[index];
  if (!bar) return -1;
  const nextTime = timeline.end(bar.time);
  if (nextTime === null) return -1;
  return sampleTimeSeconds < nextTime ? index : -1;
}

function addNotional(
  bucket: MutableProjectedBucket,
  side: "long" | "short",
  notional: number,
): void {
  if (side === "long") bucket.longNotional = (bucket.longNotional ?? 0) + notional;
  else bucket.shortNotional = (bucket.shortNotional ?? 0) + notional;
}

function sortedBy<T>(
  values: readonly T[],
  timeOf: (value: T) => number,
): readonly T[] {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous && current && timeOf(previous) > timeOf(current)) {
      return [...values].sort((left, right) => timeOf(left) - timeOf(right));
    }
  }
  return values;
}

function lowerBoundBy<T>(
  values: readonly T[],
  target: number,
  timeOf: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value && timeOf(value) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function projectLiquidationsToCandles(
  rollups: readonly LiquidationRollup[],
  liveEvents: readonly LiquidationEvent[],
  bars: readonly KlineBar[],
  interval: unknown,
  { inputsSorted = false }: { inputsSorted?: boolean } = {},
): ProjectedBucket[] {
  if (bars.length === 0) return [];
  const sortedBars = inputsSorted ? bars : sortedBy(bars, (bar) => bar.time);
  const sortedRollups = inputsSorted
    ? rollups
    : sortedBy(rollups, (row) => row.bucketStartMs);
  const sortedEvents = inputsSorted
    ? liveEvents
    : sortedBy(liveEvents, (event) => event.tradeTimeMs);
  const timeline = createIntervalTimeline(interval) ?? createIntervalTimeline("1m")!;
  const visibleStartMs = sortedBars[0]!.time * 1000;
  const visibleEndMs = (timeline.end(sortedBars.at(-1)!.time) ?? sortedBars.at(-1)!.time) * 1000;
  const buckets = new Map<number, MutableProjectedBucket>();
  const getBucket = (sampleTimeMs: number): MutableProjectedBucket | null => {
    const index = barIndexAt(sortedBars, sampleTimeMs / 1000, timeline);
    const bar = sortedBars[index];
    if (!bar) return null;
    let bucket = buckets.get(bar.time);
    if (!bucket) {
      bucket = {
        time: bar.time,
        longNotional: null,
        shortNotional: null,
        hasLiveEvents: false,
        allRowsFinal: true,
        rowCount: 0,
      };
      buckets.set(bar.time, bucket);
    }
    return bucket;
  };

  const rollupStart = lowerBoundBy(sortedRollups, visibleStartMs, (row) => row.bucketStartMs);
  const rollupEnd = lowerBoundBy(sortedRollups, visibleEndMs, (row) => row.bucketStartMs);
  for (let index = rollupStart; index < rollupEnd; index += 1) {
    const row = sortedRollups[index];
    if (!row) continue;
    const bucket = getBucket(row.bucketStartMs);
    if (!bucket) continue;
    addNotional(bucket, row.positionSide, row.filledNotional);
    bucket.rowCount += 1;
    bucket.allRowsFinal = bucket.allRowsFinal && row.isFinal;
  }
  const eventStart = lowerBoundBy(sortedEvents, visibleStartMs, (event) => event.tradeTimeMs);
  const eventEnd = lowerBoundBy(sortedEvents, visibleEndMs, (event) => event.tradeTimeMs);
  for (let index = eventStart; index < eventEnd; index += 1) {
    const event = sortedEvents[index];
    if (!event) continue;
    const bucket = getBucket(event.tradeTimeMs);
    if (!bucket) continue;
    addNotional(bucket, event.positionSide, event.executedNotional);
    bucket.hasLiveEvents = true;
  }
  return sortedBars.flatMap((bar) => {
    const bucket = buckets.get(bar.time);
    if (!bucket) return [];
    const { rowCount, ...projected } = bucket;
    return [{
      ...projected,
      allRowsFinal: rowCount > 0 && bucket.allRowsFinal && !bucket.hasLiveEvents,
    }];
  });
}

function metadataForBucket(bucket: ProjectedBucket): IndicatorPanePointMetadata {
  const longLabel = bucket.longNotional === null ? "—" : formatNotional(bucket.longNotional);
  const shortLabel = bucket.shortNotional === null ? "—" : formatNotional(bucket.shortNotional);
  const qualityLabel = bucket.hasLiveEvents
    ? "实时观测"
    : bucket.allRowsFinal
      ? "已落库"
      : "分钟桶更新中";
  const valueLabel = `多 ${longLabel} · 空 ${shortLabel}`;
  return {
    time: bucket.time,
    value: (bucket.longNotional ?? 0) - (bucket.shortNotional ?? 0),
    valueLabel,
    sourceLabel: "公开采样",
    qualityLabel,
    appearance: bucket.hasLiveEvents ? "realtime" : "solid",
    accessibilityLabel: `观测爆仓额，${valueLabel}，公开采样，${qualityLabel}；未观测方向不等于零`,
  };
}

function statusText(view: LiquidationRuntimeView): string | null {
  if (view.error || view.historyError) return `爆仓数据暂不可用：${view.error || view.historyError}`;
  if (view.connectionStatus === "connecting") return "正在订阅公开爆仓流…";
  if (view.connectionStatus === "reconnecting") return "爆仓流重连中，正在重载本地分钟历史…";
  if (view.connectionStatus === "disconnected") return "爆仓流已断开";
  if (view.connectionStatus === "live") return "暂无本地爆仓观测；已开始采集（空白不等于 0）";
  return null;
}

export function buildLiquidationPane(
  snapshot: LiquidationSnapshot,
  bars: readonly KlineBar[],
  interval: unknown,
  view: LiquidationRuntimeView,
): IndicatorSubPane {
  const projected = projectLiquidationsToCandles(
    snapshot.rollups,
    snapshot.liveEvents,
    bars,
    interval,
    { inputsSorted: true },
  );
  const longData: IndicatorValuePoint[] = projected.flatMap((bucket) => (
    bucket.longNotional === null ? [] : [{ time: bucket.time, value: bucket.longNotional }]
  ));
  const shortData: IndicatorValuePoint[] = projected.flatMap((bucket) => (
    bucket.shortNotional === null ? [] : [{ time: bucket.time, value: -bucket.shortNotional }]
  ));
  const line = (
    id: string,
    name: string,
    color: string,
    data: IndicatorValuePoint[],
  ): IndicatorLine => ({
    id,
    indicatorId: "advanced-market-data",
    name,
    pane: "advanced-liquidations",
    type: "histogram",
    color,
    data,
    scale: "symmetric-zero",
    valueFormat: "notional",
  });
  return {
    id: "advanced-liquidations",
    label: "观测爆仓额",
    lines: [
      line("advanced-liquidation-long", "多头爆仓", LIQUIDATION_LONG_COLOR, longData),
      line("advanced-liquidation-short", "空头爆仓", LIQUIDATION_SHORT_COLOR, shortData),
    ],
    owner: { kind: "market-study", id: "market:liquidations" },
    dataMarketPane: "liquidations",
    legendItems: LIQUIDATION_LEGEND,
    pointMetadata: projected.map(metadataForBucket),
    pointMetadataFallback: "none",
    missingPointText: "该 K 线无爆仓观测（不等于 0）",
    statusText: projected.length === 0 ? statusText(view) : null,
  };
}
