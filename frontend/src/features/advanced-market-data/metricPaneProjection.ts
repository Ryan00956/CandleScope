import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { IndicatorLine, IndicatorValuePoint } from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type {
  AdvancedMarketMetricsSnapshot,
  MarketStateRecord,
} from "./advancedMarketDataTypes.js";
import type { MarketMetricChannel } from "./marketMetricSelectionTypes.js";

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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFinal(record: MarketStateRecord): boolean {
  return record.data.is_final === true || record.data.sample_kind === "settlement";
}

export function marketMetricSampleTimeMs(record: MarketStateRecord): number {
  if (record.channel === "funding_rate") {
    const preview = record.data.is_final === false || record.data.sample_kind === "preview";
    if (preview) return record.received_at_ms;
    return finiteNumber(record.data.funding_time_ms) ?? record.event_time_ms;
  }
  return record.event_time_ms;
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
  const sortedBars = [...bars].sort((a, b) => a.time - b.time);
  const sortedRecords = [...records].sort((a, b) => (
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

  return Array.from(candidates.values())
    .sort((a, b) => Number(a.point.time) - Number(b.point.time))
    .map(({ point }) => point);
}

export function buildAdvancedMarketPanes(
  metrics: AdvancedMarketMetricsSnapshot,
  bars: readonly KlineBar[],
  channels: readonly MarketMetricChannel[] = ["funding_rate", "open_interest"],
): IndicatorSubPane[] {
  const requestedChannels = new Set(channels);
  const fundingPoints = projectMetricRecordsToCandles(
    metrics.fundingHistory,
    bars,
    { valueField: "funding_rate", transform: (value) => value * 100 },
  );
  const previewValue = finiteNumber(metrics.fundingPreview?.data.funding_rate);
  const tailBar = bars.at(-1);
  if (previewValue !== null && tailBar) {
    const existingIndex = fundingPoints.findIndex((point) => point.time === tailBar.time);
    const previewPoint = { time: tailBar.time, value: previewValue * 100 };
    if (existingIndex >= 0) fundingPoints[existingIndex] = previewPoint;
    else fundingPoints.push(previewPoint);
  }
  const fundingColorData = fundingPoints.map((point) => ({
    ...point,
    color: point.value >= 0 ? "#22c55e" : "#ef4444",
  }));
  const fundingLine: IndicatorLine = {
    id: "advanced-funding-rate-line",
    indicatorId: "advanced-market-data",
    name: "Funding Rate (%)",
    pane: "advanced-funding",
    type: "histogram",
    color: "#22c55e",
    data: fundingColorData,
    colorData: fundingColorData,
  };

  const openInterestLine: IndicatorLine = {
    id: "advanced-open-interest-line",
    indicatorId: "advanced-market-data",
    name: "Open Interest",
    pane: "advanced-open-interest",
    type: "line",
    color: "#60a5fa",
    lineWidth: 2,
    data: projectMetricRecordsToCandles(metrics.openInterestHistory, bars, {
      valueField: "open_interest",
      finalWins: true,
    }),
  };
  const latestProvisionalOpenInterest = [...metrics.openInterestHistory]
    .reverse()
    .find((record) => (
      record.data.is_final === false || record.data.sample_kind === "provisional"
    ));
  const provisionalOpenInterestValue = finiteNumber(
    latestProvisionalOpenInterest?.data.open_interest,
  );
  if (provisionalOpenInterestValue !== null && tailBar) {
    const existingIndex = openInterestLine.data.findIndex((point) => point.time === tailBar.time);
    const previewPoint = { time: tailBar.time, value: provisionalOpenInterestValue };
    if (existingIndex >= 0) openInterestLine.data[existingIndex] = previewPoint;
    else openInterestLine.data.push(previewPoint);
  }

  const panes: Array<IndicatorSubPane & { channel: MarketMetricChannel }> = [
    {
      channel: "funding_rate",
      id: "advanced-funding",
      label: "Funding Rate (%)",
      lines: [fundingLine],
      dataMarketPane: "funding-rate",
    },
    {
      channel: "open_interest",
      id: "advanced-open-interest",
      label: "Open Interest",
      lines: [openInterestLine],
      dataMarketPane: "open-interest",
    },
  ];
  return panes
    .filter((pane) => requestedChannels.has(pane.channel))
    .map((pane) => ({
      id: pane.id,
      label: pane.label,
      lines: pane.lines,
      ...(pane.dataMarketPane === undefined
        ? {}
        : { dataMarketPane: pane.dataMarketPane }),
    }));
}
