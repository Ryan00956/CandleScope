import { asSeriesKey, toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { WindowDelta } from "../market-data/klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../market-data/window/windowDeltas.js";
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
  const volume = rows.reduce((total, row) => total + finiteNumber(row, "volume"), 0);
  const quoteVolume = nullableSum(rows, "quoteVolume");
  const takerBuyBase = nullableSum(rows, "takerBuyBase");
  const takerBuyQuote = nullableSum(rows, "takerBuyQuote");
  return {
    time,
    open: finiteNumber(first, "open"),
    high: rows.reduce((maximum, row) => Math.max(maximum, finiteNumber(row, "high")), -Infinity),
    low: rows.reduce((minimum, row) => Math.min(minimum, finiteNumber(row, "low")), Infinity),
    close: finiteNumber(last, "close"),
    volume,
    quote_volume: quoteVolume,
    quoteVolume,
    trades: nullableSum(rows, "trades"),
    taker_buy_base: takerBuyBase,
    taker_buy_quote: takerBuyQuote,
    takerBuyBase,
    takerBuyQuote,
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

function sameProjectedRow(
  left: Readonly<Record<string, unknown>> | null | undefined,
  right: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => (
    Object.hasOwn(right, key) && Object.is(left[key], right[key])
  ));
}

function sameProjectedRows(
  left: readonly KlineBar[],
  right: readonly KlineBar[],
): boolean {
  return left.length === right.length
    && left.every((row, index) => sameProjectedRow(
      row as Readonly<Record<string, unknown>>,
      right[index] as Readonly<Record<string, unknown>> | undefined,
    ));
}

function firstDifferentRow(
  previous: readonly KlineBar[],
  next: readonly KlineBar[],
): number {
  const sharedLength = Math.min(previous.length, next.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!sameProjectedRow(
      previous[index] as Readonly<Record<string, unknown>>,
      next[index] as Readonly<Record<string, unknown>>,
    )) return index;
  }
  return previous.length === next.length ? -1 : sharedLength;
}

/**
 * Reprojects a source-store delta without publishing a replacement snapshot.
 *
 * Lightweight Charts has no historical `prepend()` API, so the shared chart
 * adapter still performs one atomic setData commit for structural prepends.
 * Keeping PREPEND / APPEND / TICK semantics here is what lets that adapter
 * retain the existing chart instance and compensate the viewport exactly like
 * the live-history path instead of treating every page as a new dataset.
 */
export function applyReplayViewerSeriesDelta(
  target: SeriesWindowStore,
  source: SeriesWindowStore,
  baseInterval: string,
  displayInterval: string,
  sourceDelta: WindowDelta,
): WindowDelta {
  const rows = aggregateReplayBaseBars(
    source.snapshot({ force: true }),
    baseInterval,
    displayInterval,
  );
  const displaySeconds = fixedSeconds(displayInterval, "display interval");
  const sourceDeltaType = sourceDelta.type;
  const meta = {
    source: `replay-viewer-${sourceDeltaType}`,
    sourceDeltaType,
    baseInterval,
    displayInterval,
  };
  target.intervalSeconds = displaySeconds;
  target.seriesKey = asSeriesKey(
    `${String(source.seriesKey ?? "replay-base")}|viewer:${displayInterval}`,
  );

  if (rows.length === 0 || sourceDeltaType === WINDOW_DELTA_TYPES.CLEAR) {
    return target.clear(meta);
  }
  if (target.isEmpty() || sourceDeltaType === WINDOW_DELTA_TYPES.REPLACE) {
    return target.replace(rows, meta);
  }

  const previous = target.snapshot().slice();
  const previousBudget = target.maxBars;
  // The source window is authoritative. Temporarily matching its projected
  // size lets applyRange evict a stale opposite edge when the bounded source
  // window moves left/right, including derived 5m/15m/1h projections whose
  // row count is far below the generic 10k chart budget.
  target.maxBars = Math.max(1, rows.length);
  try {
    const trimmedLeft = Number(sourceDelta.trimmedLeft) || 0;
    const trimmedRight = Number(sourceDelta.trimmedRight) || 0;
    const tailOnlySourceDelta = (
      sourceDeltaType === WINDOW_DELTA_TYPES.TICK
      || sourceDeltaType === WINDOW_DELTA_TYPES.APPEND
    ) && trimmedLeft === 0 && trimmedRight === 0;
    const firstDifference = tailOnlySourceDelta
      ? firstDifferentRow(previous, rows)
      : 0;
    let result: WindowDelta | null = null;

    if (sourceDeltaType === WINDOW_DELTA_TYPES.PREPEND) {
      const previousFirstTime = previous[0]?.time;
      const prepended = previousFirstTime === undefined
        ? rows
        : rows.filter((row) => row.time < previousFirstTime);
      if (prepended.length > 0) {
        // Commit the new left segment first so SeriesWindowStore applies its
        // oldest-side retention policy before any boundary bucket correction
        // turns the follow-up reconciliation into a mid-merge.
        result = target.applyRange(prepended, meta);
      }
      const reconciled = target.applyRange(rows, meta);
      if (reconciled.changed) result = reconciled;
    }

    if (tailOnlySourceDelta
      && rows.length >= previous.length
      && firstDifference >= Math.max(0, previous.length - 1)) {
      const previousTail = previous.at(-1);
      const nextExistingTail = rows[previous.length - 1];
      if (previousTail
        && nextExistingTail
        && previousTail.time === nextExistingTail.time
        && !sameProjectedRow(
          previousTail as Readonly<Record<string, unknown>>,
          nextExistingTail as Readonly<Record<string, unknown>>,
        )) {
        result = target.applyTick(nextExistingTail, meta);
      }
      const appended = rows.slice(previous.length);
      if (appended.length > 0) {
        result = target.applyRange(appended, meta);
      }
    }

    if (result === null) {
      result = target.applyRange(rows, meta);
    }
    if (sameProjectedRows(target.snapshot({ force: true }), rows)) return result;

    // Fail closed on an unexpected projection shape. Normal prepend/append
    // paths never reach this replacement; the fallback prevents stale rows
    // from surviving a future aggregation-contract change.
    return target.replace(rows, {
      ...meta,
      source: "replay-viewer-reconcile-fallback",
    });
  } finally {
    target.maxBars = previousBudget;
  }
}
