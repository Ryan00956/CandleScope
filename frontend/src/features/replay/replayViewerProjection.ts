import { asSeriesKey, toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";


export class ReplayViewerProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayViewerProjectionError";
  }
}

function fixedSeconds(interval: string, fieldName: string): number {
  if (interval.endsWith("M")) {
    throw new ReplayViewerProjectionError(`${fieldName} calendar intervals are unsupported`);
  }
  const seconds = parseIntervalSeconds(interval);
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ReplayViewerProjectionError(`${fieldName} must be a fixed-duration interval`);
  }
  return seconds;
}

function nullableSum(rows: readonly KlineBar[], key: "quoteVolume" | "trades" | "takerBuyBase" | "takerBuyQuote"): number | null {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || typeof value !== "number" || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

function finiteNumber(row: KlineBar, key: "open" | "high" | "low" | "close" | "volume"): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReplayViewerProjectionError(`base prefix contains an invalid ${key}`);
  }
  return value;
}

function aggregateBucket(
  rows: readonly KlineBar[],
  options: {
    readonly bucketStart: number;
    readonly baseSeconds: number;
    readonly displaySeconds: number;
  },
): KlineBar {
  const { bucketStart, baseSeconds, displaySeconds } = options;
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) throw new ReplayViewerProjectionError("viewer bucket cannot be empty");
  const expected = displaySeconds / baseSeconds;
  const lastBaseOpenMs = Number(last.time) * 1_000;
  const bucketEndSeconds = bucketStart + displaySeconds;
  // The adapter always publishes one row per BaseInterval. In AGG_TRADE mode
  // a row's replayComponentCount counts trades, not base bars, so display
  // completeness must be based on the number of revealed base rows.
  const componentCount = rows.length;
  const closed = componentCount === expected
    && Number(first.time) === bucketStart
    && Number(last.time) + baseSeconds === bucketEndSeconds
    && rows.every((row) => row.replayClosed === true);
  const time = toEpochSeconds(bucketStart);
  if (time === null) throw new ReplayViewerProjectionError("viewer bucket time is invalid");
  return {
    time,
    open: finiteNumber(first, "open"),
    high: rows.reduce((maximum, row) => Math.max(maximum, finiteNumber(row, "high")), -Infinity),
    low: rows.reduce((minimum, row) => Math.min(minimum, finiteNumber(row, "low")), Infinity),
    close: finiteNumber(last, "close"),
    volume: rows.reduce((total, row) => total + finiteNumber(row, "volume"), 0),
    quoteVolume: nullableSum(rows, "quoteVolume"),
    trades: nullableSum(rows, "trades"),
    takerBuyBase: nullableSum(rows, "takerBuyBase"),
    takerBuyQuote: nullableSum(rows, "takerBuyQuote"),
    replayCloseTimeMs: bucketEndSeconds * 1_000 - 1,
    replayLastBaseOpenMs: last.replayLastBaseOpenMs ?? lastBaseOpenMs,
    replayComponentCount: componentCount,
    replayExpectedComponents: expected,
    replayClosed: closed,
    replaySynthetic: rows.some((row) => row.replaySynthetic === true),
  };
}

export function aggregateReplayBaseBars(
  rows: readonly KlineBar[],
  baseInterval: string,
  displayInterval: string,
): readonly KlineBar[] {
  const baseSeconds = fixedSeconds(baseInterval, "base interval");
  const displaySeconds = fixedSeconds(displayInterval, "display interval");
  if (displaySeconds < baseSeconds || displaySeconds % baseSeconds !== 0) {
    throw new ReplayViewerProjectionError(
      "display interval must be an integer multiple of the base interval",
    );
  }
  if (displaySeconds === baseSeconds) return rows.map((row) => ({ ...row }));
  const output: KlineBar[] = [];
  let bucketStart: number | null = null;
  let bucket: KlineBar[] = [];
  let previousTime: number | null = null;
  const flush = () => {
    if (bucketStart === null || bucket.length === 0) return;
    output.push(aggregateBucket(bucket, { bucketStart, baseSeconds, displaySeconds }));
  };
  for (const row of rows) {
    const time = Number(row.time);
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new ReplayViewerProjectionError("base prefix contains an invalid time");
    }
    if (time % baseSeconds !== 0) {
      throw new ReplayViewerProjectionError("base prefix is not aligned to the base interval");
    }
    if (previousTime !== null && time <= previousTime) {
      throw new ReplayViewerProjectionError("base prefix must be strictly increasing");
    }
    const nextBucketStart = Math.floor(time / displaySeconds) * displaySeconds;
    if (bucketStart !== null && nextBucketStart !== bucketStart) {
      flush();
      bucket = [];
    }
    bucketStart = nextBucketStart;
    bucket.push(row);
    previousTime = time;
  }
  flush();
  return output;
}

export function rebuildReplayViewerSeries(
  target: SeriesWindowStore,
  source: SeriesWindowStore,
  baseInterval: string,
  displayInterval: string,
): void {
  const rows = aggregateReplayBaseBars(
    source.snapshot({ force: true }),
    baseInterval,
    displayInterval,
  );
  const displaySeconds = fixedSeconds(displayInterval, "display interval");
  target.intervalSeconds = displaySeconds;
  target.seriesKey = asSeriesKey(`${String(source.seriesKey ?? "replay-base")}|viewer:${displayInterval}`);
  target.replace(rows, {
    source: "replay-viewer-rebuild",
    baseInterval,
    displayInterval,
  });
}
