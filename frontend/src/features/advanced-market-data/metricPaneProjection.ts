import type {
  IndicatorPaneLegendItem,
  IndicatorPanePointMetadata,
  IndicatorSubPane,
} from "../indicators/indicatorPaneProjection.js";
import type {
  IndicatorColorPoint,
  IndicatorLine,
  IndicatorValuePoint,
} from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type {
  AdvancedMarketMetricsSnapshot,
  MarketStateRecord,
} from "./advancedMarketDataTypes.js";
import type { MarketStateMetricChannel } from "./marketMetricSelectionTypes.js";
import {
  fundingRateProvenance,
  fundingRateQuality,
  fundingRateSampleTimeMs,
  fundingRateTargetTimeMs,
  isFundingRateHistory,
  isFundingRateRealtimeUsable,
} from "./fundingRateSemantics.js";

const OPEN_INTEREST_PERIODS = [
  { period: "5m", seconds: 300 },
  { period: "15m", seconds: 900 },
  { period: "30m", seconds: 1800 },
  { period: "1h", seconds: 3600 },
  { period: "2h", seconds: 7200 },
  { period: "4h", seconds: 14_400 },
  { period: "6h", seconds: 21_600 },
  { period: "12h", seconds: 43_200 },
  { period: "1d", seconds: 86_400 },
] as const;

interface MetricProjectionOptions {
  valueField: "funding_rate" | "open_interest";
  transform?: (value: number) => number;
  finalWins?: boolean;
}

interface ProjectedCandidate {
  point: IndicatorValuePoint;
  record: MarketStateRecord;
  sampleTimeMs: number;
}

interface FundingProjectionCandidate {
  record: MarketStateRecord;
  sampleTimeMs: number;
  carried: boolean;
  stale: boolean;
}

type FundingMetricsInput = Pick<
  AdvancedMarketMetricsSnapshot,
  "fundingHistory" | "fundingRealtimeHistory" | "fundingPreview"
>;

type OpenInterestMetricsInput = Pick<
  AdvancedMarketMetricsSnapshot,
  "openInterestHistory"
>;

const FUNDING_REALTIME_STALE_AFTER_MS = 15_000;

const FUNDING_RATE_LEGEND: readonly IndicatorPaneLegendItem[] = Object.freeze([
  {
    id: "exchange-settlement",
    label: "交易所结算",
    appearance: "solid",
    description: "交易所公布的最终结算资金费率",
  },
  {
    id: "derived-history",
    label: "历史估算",
    appearance: "estimated",
    description: "仅使用当时已有数据计算的无前视历史估算",
  },
  {
    id: "exchange-realtime",
    label: "交易所实时",
    appearance: "realtime",
    description: "交易所实时推送的下一周期资金费率",
  },
  {
    id: "realtime-carried",
    label: "实时沿用",
    appearance: "carried",
    description: "同一资金周期内沿用最近一次交易所实时值",
  },
]);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortedIfNeeded<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): readonly T[] {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && compare(previous, current) > 0) {
      return [...values].sort(compare);
    }
  }
  return values;
}

function fundingHistoryRecords(
  records: readonly MarketStateRecord[],
): readonly MarketStateRecord[] {
  return records.every(isFundingRateHistory)
    ? records
    : records.filter(isFundingRateHistory);
}

function isFinal(record: MarketStateRecord): boolean {
  return record.data.is_final === true || record.data.sample_kind === "settlement";
}

export function marketMetricSampleTimeMs(record: MarketStateRecord): number {
  if (record.channel === "funding_rate") {
    return fundingRateSampleTimeMs(record);
  }
  return record.event_time_ms;
}

function fundingPrecedence(record: MarketStateRecord): number {
  const provenance = fundingRateProvenance(record);
  if (provenance === "exchange_settlement") return 2;
  if (provenance === "derived_history") return 1;
  return 0;
}

function fundingAppearance(
  record: MarketStateRecord,
  carried: boolean,
  stale = false,
): IndicatorPaneLegendItem["appearance"] {
  const provenance = fundingRateProvenance(record);
  if (provenance === "exchange_settlement") return "solid";
  if (provenance === "derived_history") return "estimated";
  const quality = fundingRateQuality(record);
  return carried || stale || quality === "carried" || quality === "stale" ? "carried" : "realtime";
}

function fundingColor(
  record: MarketStateRecord,
  value: number,
  carried: boolean,
  stale: boolean,
): string {
  const positive = value >= 0;
  const appearance = fundingAppearance(record, carried, stale);
  if (appearance === "estimated") {
    return positive ? "rgba(34, 197, 94, 0.42)" : "rgba(239, 68, 68, 0.42)";
  }
  if (appearance === "realtime") return positive ? "#4ade80" : "#fb7185";
  if (appearance === "carried") {
    const isStale = stale || fundingRateQuality(record) === "stale" || record.data.stale === true;
    const opacity = isStale ? 0.34 : 0.58;
    return positive
      ? `rgba(74, 222, 128, ${opacity})`
      : `rgba(251, 113, 133, ${opacity})`;
  }
  return positive ? "#22c55e" : "#ef4444";
}

function formatFundingValue(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function formatFundingTime(value: unknown): string | null {
  const timeMs = finiteNumber(value);
  if (timeMs === null) return null;
  return new Date(timeMs).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function fundingPointMetadata(
  record: MarketStateRecord,
  time: number,
  value: number,
  carried: boolean,
  stale: boolean,
): IndicatorPanePointMetadata {
  const provenance = fundingRateProvenance(record);
  const baseQuality = fundingRateQuality(record);
  const effectiveQuality = provenance === "exchange_realtime" && stale
    ? "stale"
    : provenance === "exchange_realtime"
    && carried
    && baseQuality !== "stale"
    ? "carried"
    : baseQuality;
  const sourceLabel = {
    exchange_settlement: "交易所历史结算",
    derived_history: "模型历史估算",
    exchange_realtime: "交易所实时预估",
  }[provenance];
  const qualityLabel = {
    final: "最终值",
    estimated: "估算值",
    live: "实时",
    carried: "同周期沿用",
    stale: "实时已过期",
  }[effectiveQuality];
  const details = [`来源：${sourceLabel}`, `状态：${qualityLabel}`];
  if (provenance === "exchange_settlement") {
    const fundingTime = formatFundingTime(record.data.funding_time_ms);
    if (fundingTime) details.push(`结算时间：${fundingTime}`);
  } else if (provenance === "derived_history") {
    const cutoff = formatFundingTime(record.data.sample_time_ms);
    const target = formatFundingTime(fundingRateTargetTimeMs(record));
    if (cutoff) details.push(`观测截止：${cutoff}`);
    if (target) details.push(`目标结算：${target}`);
    if (typeof record.data.formula_version === "string") {
      details.push(`公式：${record.data.formula_version}`);
    }
    if (typeof record.data.input_resolution === "string") {
      details.push(`输入粒度：${record.data.input_resolution}`);
    }
    const inputCoverage = finiteNumber(record.data.input_coverage);
    if (inputCoverage !== null) details.push(`输入覆盖：${Math.round(inputCoverage * 100)}%`);
  } else {
    const observedAt = formatFundingTime(
      finiteNumber(record.data.observed_at_ms) ?? record.received_at_ms,
    );
    const target = formatFundingTime(fundingRateTargetTimeMs(record));
    if (observedAt) details.push(`观测时间：${observedAt}`);
    if (target) details.push(`目标结算：${target}`);
  }
  const valueLabel = formatFundingValue(value);
  return {
    time,
    value,
    valueLabel,
    sourceLabel,
    qualityLabel,
    appearance: fundingAppearance(record, carried, stale),
    accessibilityLabel: `资金费率 ${valueLabel}，${details.join("，")}`,
  };
}

function lowerBoundFundingObservation(
  records: readonly MarketStateRecord[],
  targetMs: number,
): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const record = records[middle];
    if (record && fundingRateSampleTimeMs(record) < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export interface FundingRateHistoryProjection {
  bars: readonly KlineBar[];
  intervalSeconds: number;
  points: Array<IndicatorValuePoint & IndicatorColorPoint>;
  metadata: IndicatorPanePointMetadata[];
  settlementTimes: ReadonlySet<number>;
}

interface FundingProjectedPoint {
  point: IndicatorValuePoint & IndicatorColorPoint;
  metadata: IndicatorPanePointMetadata;
}

function projectFundingCandidate(
  time: number,
  candidate: FundingProjectionCandidate,
): FundingProjectedPoint | null {
  const rawValue = finiteNumber(candidate.record.data.funding_rate);
  if (rawValue === null) return null;
  const value = rawValue * 100;
  return {
    point: {
      time,
      value,
      color: fundingColor(candidate.record, value, candidate.carried, candidate.stale),
    },
    metadata: fundingPointMetadata(
      candidate.record,
      time,
      value,
      candidate.carried,
      candidate.stale,
    ),
  };
}

export function buildFundingRateHistoryProjection(
  fundingHistory: readonly MarketStateRecord[],
  bars: readonly KlineBar[],
  interval: unknown,
): FundingRateHistoryProjection {
  const sortedBars = sortedIfNeeded(bars, (left, right) => left.time - right.time);
  const inferredIntervalSeconds = sortedBars.length > 1
    ? Math.max(1, sortedBars[sortedBars.length - 1]!.time - sortedBars[sortedBars.length - 2]!.time)
    : 1;
  const intervalSeconds = parseIntervalSeconds(interval) ?? inferredIntervalSeconds;
  if (sortedBars.length === 0) {
    return {
      bars: sortedBars,
      intervalSeconds,
      points: [],
      metadata: [],
      settlementTimes: new Set(),
    };
  }
  const candidates = new Map<number, FundingProjectionCandidate>();
  const historicalRecords = sortedIfNeeded(
    fundingHistoryRecords(fundingHistory),
    (left, right) => (
      fundingRateSampleTimeMs(left) - fundingRateSampleTimeMs(right)
      || fundingPrecedence(left) - fundingPrecedence(right)
      || left.received_at_ms - right.received_at_ms
      || left.revision - right.revision
    ),
  );
  let historyBarIndex = 0;
  for (const record of historicalRecords) {
    if (finiteNumber(record.data.funding_rate) === null) continue;
    const sampleTimeMs = fundingRateSampleTimeMs(record);
    const sampleTime = sampleTimeMs / 1000;
    while (historyBarIndex < sortedBars.length && sortedBars[historyBarIndex]!.time < sampleTime) {
      historyBarIndex += 1;
    }
    const bar = sortedBars[historyBarIndex];
    if (!bar) continue;
    const previous = candidates.get(bar.time);
    if (!previous
      || fundingPrecedence(record) > fundingPrecedence(previous.record)
      || (fundingPrecedence(record) === fundingPrecedence(previous.record)
        && sampleTimeMs >= previous.sampleTimeMs)) {
      candidates.set(bar.time, { record, sampleTimeMs, carried: false, stale: false });
    }
  }

  const points: Array<IndicatorValuePoint & IndicatorColorPoint> = [];
  const metadata: IndicatorPanePointMetadata[] = [];
  const settlementTimes = new Set<number>();
  for (const [time, candidate] of [...candidates.entries()].sort(([left], [right]) => left - right)) {
    const projected = projectFundingCandidate(time, candidate);
    if (!projected) continue;
    points.push(projected.point);
    metadata.push(projected.metadata);
    if (fundingRateProvenance(candidate.record) === "exchange_settlement") {
      settlementTimes.add(time);
    }
  }
  return { bars: sortedBars, intervalSeconds, points, metadata, settlementTimes };
}

function mergeFundingProjection(
  history: FundingRateHistoryProjection,
  metrics: Pick<FundingMetricsInput, "fundingRealtimeHistory" | "fundingPreview">,
  nowMs: number,
): {
  points: Array<IndicatorValuePoint & IndicatorColorPoint>;
  metadata: IndicatorPanePointMetadata[];
} {
  const sortedBars = history.bars;
  if (sortedBars.length === 0) return { points: history.points, metadata: history.metadata };
  const realtimeTimeline = metrics.fundingRealtimeHistory || [];
  if (realtimeTimeline.length === 0 && !metrics.fundingPreview) {
    return { points: history.points, metadata: history.metadata };
  }

  const visibleStartMs = sortedBars[0]!.time * 1000;
  const visibleEndMs = Math.min(
    (sortedBars.at(-1)!.time + history.intervalSeconds) * 1000,
    nowMs,
  );
  const firstVisibleObservation = lowerBoundFundingObservation(realtimeTimeline, visibleStartMs);
  const afterVisibleObservation = lowerBoundFundingObservation(realtimeTimeline, visibleEndMs);
  const realtimeRecords = realtimeTimeline.slice(
    Math.max(0, firstVisibleObservation - 1),
    afterVisibleObservation,
  );
  if (metrics.fundingPreview) {
    const previewTimeMs = fundingRateSampleTimeMs(metrics.fundingPreview);
    if (previewTimeMs < visibleEndMs
      && (previewTimeMs >= visibleStartMs || realtimeRecords.length === 0)) {
      const existingIndex = realtimeRecords.findIndex((record) => (
        fundingRateSampleTimeMs(record) === previewTimeMs
      ));
      if (existingIndex >= 0) realtimeRecords[existingIndex] = metrics.fundingPreview;
      else realtimeRecords.push(metrics.fundingPreview);
      realtimeRecords.sort((left, right) => (
        fundingRateSampleTimeMs(left) - fundingRateSampleTimeMs(right)
        || left.received_at_ms - right.received_at_ms
      ));
    }
  }
  let realtimeIndex = 0;
  let latestRealtime: MarketStateRecord | null = null;
  const overrides = new Map<number, FundingProjectedPoint>();
  for (const [index, bar] of sortedBars.entries()) {
    const nominalBarCloseMs = (
      sortedBars[index + 1]?.time ?? (bar.time + history.intervalSeconds)
    ) * 1000;
    const observationCutoffMs = Math.min(nominalBarCloseMs, nowMs);
    while (realtimeIndex < realtimeRecords.length) {
      const record = realtimeRecords[realtimeIndex];
      if (!record || fundingRateSampleTimeMs(record) >= observationCutoffMs) break;
      latestRealtime = record;
      realtimeIndex += 1;
    }
    if (!latestRealtime || finiteNumber(latestRealtime.data.funding_rate) === null) continue;
    if (!isFundingRateRealtimeUsable(latestRealtime, bar.time * 1000, observationCutoffMs)) continue;
    const observedAtMs = fundingRateSampleTimeMs(latestRealtime);
    if (observedAtMs >= observationCutoffMs) continue;
    const carried = latestRealtime.data.carried === true || observedAtMs < bar.time * 1000;
    const stale = latestRealtime.data.stale === true
      || observationCutoffMs - observedAtMs > FUNDING_REALTIME_STALE_AFTER_MS;
    if (history.settlementTimes.has(bar.time)) continue;
    const projected = projectFundingCandidate(bar.time, {
      record: latestRealtime,
      sampleTimeMs: observedAtMs,
      carried,
      stale,
    });
    if (projected) overrides.set(bar.time, projected);
  }

  if (overrides.size === 0) return { points: history.points, metadata: history.metadata };
  const realtime = [...overrides.entries()].sort(([left], [right]) => left - right);
  const points: Array<IndicatorValuePoint & IndicatorColorPoint> = [];
  const metadata: IndicatorPanePointMetadata[] = [];
  let historyIndex = 0;
  let realtimeIndexForMerge = 0;
  while (historyIndex < history.points.length || realtimeIndexForMerge < realtime.length) {
    const historyPoint = history.points[historyIndex];
    const realtimeEntry = realtime[realtimeIndexForMerge];
    if (realtimeEntry && (!historyPoint || realtimeEntry[0] <= historyPoint.time)) {
      points.push(realtimeEntry[1].point);
      metadata.push(realtimeEntry[1].metadata);
      realtimeIndexForMerge += 1;
      if (historyPoint && historyPoint.time === realtimeEntry[0]) historyIndex += 1;
      continue;
    }
    if (historyPoint) {
      points.push(historyPoint);
      const historyMetadata = history.metadata[historyIndex];
      if (historyMetadata) metadata.push(historyMetadata);
      historyIndex += 1;
    }
  }
  return { points, metadata };
}

export function resolveOpenInterestPeriod(interval: unknown): string {
  const intervalSeconds = parseIntervalSeconds(interval) ?? OPEN_INTEREST_PERIODS[0].seconds;
  let selected: (typeof OPEN_INTEREST_PERIODS)[number] = OPEN_INTEREST_PERIODS[0];
  for (const candidate of OPEN_INTEREST_PERIODS) {
    if (candidate.seconds > intervalSeconds) break;
    selected = candidate;
  }
  return selected.period;
}

export function projectMetricRecordsToCandles(
  records: readonly MarketStateRecord[],
  bars: readonly KlineBar[],
  {
    valueField,
    transform = (value) => value,
    finalWins = false,
  }: MetricProjectionOptions,
): IndicatorValuePoint[] {
  if (records.length === 0 || bars.length === 0) return [];
  const sortedBars = sortedIfNeeded(bars, (a, b) => a.time - b.time);
  const sortedRecords = sortedIfNeeded(records, (a, b) => (
    marketMetricSampleTimeMs(a) - marketMetricSampleTimeMs(b)
    || a.received_at_ms - b.received_at_ms
    || a.revision - b.revision
  ));
  const candidates = new Map<number, ProjectedCandidate>();
  let barIndex = 0;

  for (const record of sortedRecords) {
    const value = finiteNumber(record.data[valueField]);
    if (value === null) continue;
    const sampleTimeMs = marketMetricSampleTimeMs(record);
    const sampleTime = sampleTimeMs / 1000;
    // Render samples as-of the chart axis. A sample observed at 00:05 must
    // first appear on a 3m chart at 00:06, never retroactively at 00:03.
    while (barIndex < sortedBars.length && sortedBars[barIndex]!.time < sampleTime) {
      barIndex += 1;
    }
    const bar = sortedBars[barIndex];
    if (!bar) continue;

    const previous = candidates.get(bar.time);
    if (previous && finalWins) {
      if (isFinal(previous.record) && !isFinal(record)) continue;
      if (!isFinal(previous.record) && isFinal(record)) {
        candidates.set(bar.time, {
          point: { time: bar.time, value: transform(value) },
          record,
          sampleTimeMs,
        });
        continue;
      }
    }
    if (!previous || sampleTimeMs >= previous.sampleTimeMs) {
      candidates.set(bar.time, {
        point: { time: bar.time, value: transform(value) },
        record,
        sampleTimeMs,
      });
    }
  }

  // Records and the bar cursor both move monotonically, so Map insertion order
  // is already chart-time order.  Returning the unique candidates avoids both
  // the old O(k log k) sort and duplicate output when an upstream bar array
  // contains a repeated timestamp.
  return Array.from(candidates.values(), ({ point }) => point);
}

export function buildFundingRatePane(
  metrics: FundingMetricsInput,
  bars: readonly KlineBar[],
  interval: unknown = null,
  nowMs: number = Date.now(),
): IndicatorSubPane {
  return buildFundingRatePaneFromHistoryProjection(
    buildFundingRateHistoryProjection(metrics.fundingHistory, bars, interval),
    metrics,
    nowMs,
  );
}

export function buildFundingRatePaneFromHistoryProjection(
  history: FundingRateHistoryProjection,
  metrics: Pick<FundingMetricsInput, "fundingRealtimeHistory" | "fundingPreview">,
  nowMs: number = Date.now(),
): IndicatorSubPane {
  const fundingProjection = mergeFundingProjection(history, metrics, nowMs);
  const fundingLine: IndicatorLine = {
    id: "advanced-funding-rate-line",
    indicatorId: "advanced-market-data",
    name: "资金费率 (%)",
    pane: "advanced-funding",
    type: "histogram",
    color: "#22c55e",
    data: fundingProjection.points,
    colorData: fundingProjection.points,
  };
  return {
    id: "advanced-funding",
    label: "资金费率 (%)",
    lines: [fundingLine],
    owner: { kind: "market-study", id: "market:funding-rate" },
    dataMarketPane: "funding-rate",
    legendItems: FUNDING_RATE_LEGEND,
    pointMetadata: fundingProjection.metadata,
  };
}

export function buildOpenInterestPane(
  metrics: OpenInterestMetricsInput,
  bars: readonly KlineBar[],
): IndicatorSubPane {
  const sortedBars = sortedIfNeeded(bars, (left, right) => left.time - right.time);
  const tailBar = sortedBars.at(-1);
  const openInterestLine: IndicatorLine = {
    id: "advanced-open-interest-line",
    indicatorId: "advanced-market-data",
    name: "Open Interest",
    pane: "advanced-open-interest",
    type: "line",
    color: "#60a5fa",
    lineWidth: 2,
    data: projectMetricRecordsToCandles(metrics.openInterestHistory, sortedBars, {
      valueField: "open_interest",
      finalWins: true,
    }),
  };
  let latestProvisionalOpenInterest: MarketStateRecord | undefined;
  for (let index = metrics.openInterestHistory.length - 1; index >= 0; index -= 1) {
    const record = metrics.openInterestHistory[index];
    if (record && (record.data.is_final === false || record.data.sample_kind === "provisional")) {
      latestProvisionalOpenInterest = record;
      break;
    }
  }
  const provisionalOpenInterestValue = finiteNumber(
    latestProvisionalOpenInterest?.data.open_interest,
  );
  if (provisionalOpenInterestValue !== null && tailBar) {
    const existingIndex = openInterestLine.data.findIndex((point) => point.time === tailBar.time);
    const previewPoint = { time: tailBar.time, value: provisionalOpenInterestValue };
    if (existingIndex >= 0) openInterestLine.data[existingIndex] = previewPoint;
    else openInterestLine.data.push(previewPoint);
  }
  return {
    id: "advanced-open-interest",
    label: "Open Interest",
    lines: [openInterestLine],
    owner: { kind: "market-study", id: "market:open-interest" },
    dataMarketPane: "open-interest",
  };
}

export function buildAdvancedMarketPanes(
  metrics: AdvancedMarketMetricsSnapshot,
  bars: readonly KlineBar[],
  channels: readonly MarketStateMetricChannel[] = ["funding_rate", "open_interest"],
  interval: unknown = null,
  nowMs: number = Date.now(),
): IndicatorSubPane[] {
  const requestedChannels = new Set(channels);
  const panes: IndicatorSubPane[] = [];
  if (requestedChannels.has("funding_rate")) {
    panes.push(buildFundingRatePane(metrics, bars, interval, nowMs));
  }
  if (requestedChannels.has("open_interest")) {
    panes.push(buildOpenInterestPane(metrics, bars));
  }
  return panes;
}
