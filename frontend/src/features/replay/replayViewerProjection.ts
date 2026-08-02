import { asSeriesKey, toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { WindowDelta } from "../market-data/klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../market-data/window/windowDeltas.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { SeriesWindowRegistry } from "../market-data/window/windowRegistry.js";
import {
  canonicalizeIntervalValue,
  intervalTiles,
  parseIntervalSeconds,
} from "../../utils/intervals.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";
import type { IntervalTimeline } from "../../utils/intervalTimeline.js";
import { replayDisplayBarToKline } from "./replaySeriesProjection.js";
import type { ReplayDisplayBar } from "./replayTypes.js";


// Bump this whenever the server-owned source-bucket/public-time mapping
// changes. The version is part of the store identity so a hot-reloaded viewer
// cannot retain history produced by an older mapping contract.
const REPLAY_VIEWER_MAPPING_SCHEMA_VERSION = "source-bucket-v3";


export class ReplayViewerProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayViewerProjectionError";
  }
}

function replayIntervalTimeline(
  interval: string,
  fieldName: string,
): IntervalTimeline {
  const timeline = createIntervalTimeline(interval);
  if (timeline === null) {
    throw new ReplayViewerProjectionError(`${fieldName} is invalid`);
  }
  return timeline;
}

export function buildReplayViewerSeriesKey(
  source: SeriesWindowStore,
  displayInterval: string,
) {
  const canonicalDisplayInterval = canonicalizeIntervalValue(displayInterval);
  if (canonicalDisplayInterval === "") {
    throw new ReplayViewerProjectionError("display interval is invalid");
  }
  return asSeriesKey(
    `${String(source.seriesKey ?? "replay-base")}|viewer:${canonicalDisplayInterval}`
      + `|mapping:${REPLAY_VIEWER_MAPPING_SCHEMA_VERSION}`,
  );
}

/**
 * Per-run display cache mirroring the live chart's per-series registry.
 * A display interval owns one immutable store identity and is synchronized
 * only when the authoritative source version actually changes.
 */
export class ReplayViewerSeriesCache {
  private readonly registry = new SeriesWindowRegistry();
  private readonly projectedAuthorities = new WeakMap<SeriesWindowStore, {
    readonly publicTimeMs: number | null;
    readonly sourceVersion: number;
  }>();

  storeFor(source: SeriesWindowStore, displayInterval: string): SeriesWindowStore {
    return this.registry.getOrCreate(
      buildReplayViewerSeriesKey(source, displayInterval),
    );
  }

  prepare(
    source: SeriesWindowStore,
    baseInterval: string,
    displayInterval: string,
    publicTimeMs: number | null,
  ): SeriesWindowStore {
    const expectedBaseSeconds = nominalSeconds(baseInterval, "base interval");
    if (!source.isEmpty()
      && source.intervalSeconds !== null
      && source.intervalSeconds !== expectedBaseSeconds) {
      throw new ReplayViewerProjectionError(
        "authoritative replay source interval does not match the base interval",
      );
    }
    const target = this.storeFor(source, displayInterval);
    this.synchronize(target, source, baseInterval, displayInterval, publicTimeMs);
    return target;
  }

  synchronize(
    target: SeriesWindowStore,
    source: SeriesWindowStore,
    baseInterval: string,
    displayInterval: string,
    publicTimeMs: number | null = null,
  ): boolean {
    const sourceVersion = Number(source.version);
    const authority = this.projectedAuthorities.get(target);
    const normalizedPublicTimeMs = Number.isSafeInteger(publicTimeMs)
      && Number(publicTimeMs) >= 0
      ? Number(publicTimeMs)
      : null;
    if (authority?.sourceVersion === sourceVersion
      && authority.publicTimeMs === normalizedPublicTimeMs) return false;
    const rewound = authority?.publicTimeMs !== null
      && authority?.publicTimeMs !== undefined
      && normalizedPublicTimeMs !== null
      && normalizedPublicTimeMs < authority.publicTimeMs;
    if (rewound || !target.rightTruncated || target.isEmpty()) {
      rebuildReplayViewerSeries(
        target,
        source,
        baseInterval,
        displayInterval,
        {
          preserveContextHistory: !rewound && !target.isEmpty(),
          publicTimeMs: normalizedPublicTimeMs,
        },
      );
    }
    this.projectedAuthorities.set(target, {
      publicTimeMs: normalizedPublicTimeMs,
      sourceVersion,
    });
    return true;
  }

  markSynchronized(
    target: SeriesWindowStore,
    source: SeriesWindowStore,
    publicTimeMs: number | null = null,
  ): void {
    this.projectedAuthorities.set(target, {
      publicTimeMs: Number.isSafeInteger(publicTimeMs) && Number(publicTimeMs) >= 0
        ? Number(publicTimeMs)
        : null,
      sourceVersion: Number(source.version),
    });
  }
}

export function isReplayContextHistoryBar(
  row: KlineBar | null | undefined,
): boolean {
  return row?.replayContextHistory === true;
}

function nominalSeconds(interval: string, fieldName: string): number {
  const seconds = parseIntervalSeconds(interval);
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ReplayViewerProjectionError(`${fieldName} is invalid`);
  }
  return seconds;
}

function timelineTime(
  value: number | null,
  fieldName: string,
): number {
  if (value === null || !Number.isSafeInteger(value)) {
    throw new ReplayViewerProjectionError(`${fieldName} is invalid`);
  }
  return value;
}

function expectedComponentCount(
  baseTimeline: IntervalTimeline,
  displayTimeline: IntervalTimeline,
  bucketStart: number,
  bucketEnd: number,
): number {
  const baseSpec = baseTimeline.spec;
  const displaySpec = displayTimeline.spec;
  if (baseSpec.alignment === "fixed-epoch") {
    return (bucketEnd - bucketStart) / (baseSpec.widthSeconds ?? 1);
  }
  if (baseSpec.alignment === "weekly-monday") {
    return (displaySpec.weekCount ?? 0) / (baseSpec.weekCount ?? 1);
  }
  return (displaySpec.monthCount ?? 0) / (baseSpec.monthCount ?? 1);
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
    readonly baseTimeline: IntervalTimeline;
    readonly displayTimeline: IntervalTimeline;
  },
): KlineBar {
  const { bucketStart, baseTimeline, displayTimeline } = options;
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) throw new ReplayViewerProjectionError("viewer bucket cannot be empty");
  const bucketEndSeconds = timelineTime(
    displayTimeline.next(bucketStart),
    "display bucket end",
  );
  const expected = expectedComponentCount(
    baseTimeline,
    displayTimeline,
    bucketStart,
    bucketEndSeconds,
  );
  const lastBaseOpenMs = Number(last.time) * 1_000;
  const sourceFromTime = Number(first.sourceFromTime ?? first.time);
  const sourceToTime = Number(last.sourceToTime ?? last.time);
  // The adapter always publishes one row per BaseInterval. In AGG_TRADE mode
  // a row's replayComponentCount counts trades, not base bars, so display
  // completeness must be based on the number of revealed base rows.
  const componentCount = rows.length;
  const closed = componentCount === expected
    && Number(first.time) === bucketStart
    && baseTimeline.next(Number(last.time)) === bucketEndSeconds
    && rows.every((row, index) => (
      index === 0
      || baseTimeline.next(Number(rows[index - 1]?.time))
        === Number(row.time)
    ))
    && rows.every((row) => row.replayClosed === true);
  const time = toEpochSeconds(bucketStart);
  if (time === null) throw new ReplayViewerProjectionError("viewer bucket time is invalid");
  const volume = rows.reduce((total, row) => total + finiteNumber(row, "volume"), 0);
  const quoteVolume = nullableSum(rows, "quoteVolume");
  const takerBuyBase = nullableSum(rows, "takerBuyBase");
  const takerBuyQuote = nullableSum(rows, "takerBuyQuote");
  return {
    time,
    sourceFromTime: Number.isFinite(sourceFromTime) ? sourceFromTime : Number(first.time),
    sourceToTime: Number.isFinite(sourceToTime) ? sourceToTime : Number(last.time),
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
    is_closed: closed,
    replaySynthetic: rows.some((row) => row.replaySynthetic === true),
  };
}

export function aggregateReplayBaseBars(
  rows: readonly KlineBar[],
  baseInterval: string,
  displayInterval: string,
): readonly KlineBar[] {
  const baseTimeline = replayIntervalTimeline(baseInterval, "base interval");
  const displayTimeline = replayIntervalTimeline(displayInterval, "display interval");
  if (!intervalTiles(baseInterval, displayInterval)) {
    throw new ReplayViewerProjectionError(
      "display interval cannot be tiled exactly by the base interval",
    );
  }
  const baseSpec = baseTimeline.spec;
  const displaySpec = displayTimeline.spec;
  if (baseSpec.alignment === displaySpec.alignment
    && baseSpec.canonicalValue === displaySpec.canonicalValue) {
    return rows.map((row) => ({ ...row }));
  }
  const output: KlineBar[] = [];
  let bucketStart: number | null = null;
  let bucket: KlineBar[] = [];
  let previousTime: number | null = null;
  const flush = () => {
    if (bucketStart === null || bucket.length === 0) return;
    output.push(aggregateBucket(bucket, {
      bucketStart,
      baseTimeline,
      displayTimeline,
    }));
  };
  for (const row of rows) {
    const time = Number(row.time);
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new ReplayViewerProjectionError("base prefix contains an invalid time");
    }
    if (baseTimeline.floor(time) !== time) {
      throw new ReplayViewerProjectionError("base prefix is not aligned to the base interval");
    }
    if (previousTime !== null && time <= previousTime) {
      throw new ReplayViewerProjectionError("base prefix must be strictly increasing");
    }
    const nextBucketStart = timelineTime(
      displayTimeline.floor(time),
      "display bucket start",
    );
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
  {
    preserveContextHistory = false,
    publicTimeMs = null,
  }: {
    readonly preserveContextHistory?: boolean;
    readonly publicTimeMs?: number | null;
  } = {},
): void {
  const projectedRows = aggregateReplayBaseBars(
    source.snapshot({ force: true }),
    baseInterval,
    displayInterval,
  );
  const previousRows = target.snapshot();
  const rows = preserveContextHistory
    ? mergeDisplayContextWithProjection(
        revealedContextRows(previousRows, publicTimeMs),
        projectedRows,
      )
    : projectedRows;
  const displaySeconds = nominalSeconds(displayInterval, "display interval");
  const seriesKey = buildReplayViewerSeriesKey(source, displayInterval);
  target.intervalSeconds = displaySeconds;
  target.seriesKey = seriesKey;
  // A historical window can converge back to the authoritative row set while
  // retaining SeriesWindowStore's right-truncated flag. Rebuilding the latest
  // window must still replace once so that flag reaches its terminal state.
  if (sameProjectedRows(previousRows, rows) && !target.rightTruncated) return;
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

export function replaceReplayViewerSeriesFromServer(
  target: SeriesWindowStore,
  source: SeriesWindowStore,
  displayInterval: string,
  bars: readonly ReplayDisplayBar[],
  publicTimeMs: number,
): WindowDelta {
  if (!Number.isSafeInteger(publicTimeMs) || publicTimeMs < 0) {
    throw new ReplayViewerProjectionError("server projection public cursor is invalid");
  }
  const projectedRows = bars.map(replayDisplayBarToKline);
  for (let index = 0; index < projectedRows.length; index += 1) {
    const row = projectedRows[index];
    const previous = projectedRows[index - 1];
    if (row === undefined
      || (previous !== undefined && row.time <= previous.time)
      || Number(row.time) * 1_000 > publicTimeMs
      || Number(row.replayLastBaseOpenMs) > publicTimeMs
      || (row.replayClosed === true && Number(row.replayCloseTimeMs) > publicTimeMs)) {
      throw new ReplayViewerProjectionError(
        "server projection contains a non-causal or unordered bar",
      );
    }
  }
  const previousRows = target.snapshot();
  const contextRows = revealedContextRows(previousRows, publicTimeMs);
  contextRows.push(...carriedRevealedProjectionRows(
    previousRows,
    projectedRows,
    publicTimeMs,
  ));
  contextRows.sort((left, right) => Number(left.time) - Number(right.time));
  const rows = mergeDisplayContextWithProjection(contextRows, projectedRows);
  target.intervalSeconds = nominalSeconds(displayInterval, "display interval");
  target.seriesKey = buildReplayViewerSeriesKey(source, displayInterval);
  return target.replace(rows, {
    source: "replay-viewer-source-bucket-projection",
    displayInterval,
    publicTimeMs,
    serverAuthoritative: true,
  });
}

function mergeDisplayContextWithProjection(
  contextRows: readonly KlineBar[],
  projectedRows: readonly KlineBar[],
): KlineBar[] {
  if (contextRows.length === 0) return [...projectedRows];
  const rows: KlineBar[] = [];
  let contextIndex = 0;
  let projectedIndex = 0;
  while (
    contextIndex < contextRows.length
    || projectedIndex < projectedRows.length
  ) {
    const context = contextRows[contextIndex];
    const projected = projectedRows[projectedIndex];
    if (context === undefined) {
      if (projected !== undefined) rows.push(projected);
      projectedIndex += 1;
      continue;
    }
    if (projected === undefined) {
      rows.push(context);
      contextIndex += 1;
      continue;
    }
    const contextTime = Number(context.time);
    const projectedTime = Number(projected.time);
    if (contextTime <= projectedTime) {
      // Server history is cursor-clamped and may repair an already revealed
      // replay bucket after the bounded execution window evicts its prefix.
      // Let that complete display candle replace an incomplete local aggregate
      // at the same time.
      rows.push(context);
      contextIndex += 1;
      if (contextTime === projectedTime) projectedIndex += 1;
    } else {
      rows.push(projected);
      projectedIndex += 1;
    }
  }
  return rows;
}

function revealedContextRows(
  rows: readonly KlineBar[],
  publicTimeMs: number | null,
): KlineBar[] {
  return rows.filter((row) => {
    if (!isReplayContextHistoryBar(row)) return false;
    if (publicTimeMs === null) return true;
    const closeTimeMs = Number(row.replayCloseTimeMs);
    const lastBaseOpenMs = Number(row.replayLastBaseOpenMs);
    return Number.isSafeInteger(closeTimeMs)
      && Number.isSafeInteger(lastBaseOpenMs)
      && closeTimeMs <= publicTimeMs
      && lastBaseOpenMs <= publicTimeMs;
  });
}

function carriedRevealedProjectionRows(
  previousRows: readonly KlineBar[],
  projectedRows: readonly KlineBar[],
  publicTimeMs: number | null,
): KlineBar[] {
  const firstProjectedTime = projectedRows[0]?.time;
  if (firstProjectedTime === undefined) return [];
  const projectedByTime = new Map(projectedRows.map((row) => [row.time, row]));
  return previousRows.flatMap((row) => {
    if (isReplayContextHistoryBar(row) || row.replayClosed !== true) return [];
    const closeTimeMs = Number(row.replayCloseTimeMs);
    const lastBaseOpenMs = Number(row.replayLastBaseOpenMs);
    if (publicTimeMs !== null && (
      !Number.isSafeInteger(closeTimeMs)
      || !Number.isSafeInteger(lastBaseOpenMs)
      || closeTimeMs > publicTimeMs
      || lastBaseOpenMs > publicTimeMs
    )) return [];
    const current = projectedByTime.get(row.time);
    const wasEvicted = row.time < firstProjectedTime;
    const replacesPartialBoundary = current !== undefined
      && current.replayClosed !== true;
    return wasEvicted || replacesPartialBoundary
      ? [{ ...row, replayContextHistory: true }]
      : [];
  });
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
  const projectedRows = aggregateReplayBaseBars(
    source.snapshot({ force: true }),
    baseInterval,
    displayInterval,
  );
  const displaySeconds = nominalSeconds(displayInterval, "display interval");
  const sourceDeltaType = sourceDelta.type;
  const meta = {
    source: `replay-viewer-${sourceDeltaType}`,
    sourceDeltaType,
    baseInterval,
    displayInterval,
  };
  target.intervalSeconds = displaySeconds;
  target.seriesKey = buildReplayViewerSeriesKey(source, displayInterval);

  if (projectedRows.length === 0 || sourceDeltaType === WINDOW_DELTA_TYPES.CLEAR) {
    return target.clear(meta);
  }
  // A bounded before-window intentionally stops following a monotonic
  // execution tail. A backward/reset snapshot is different: retaining that
  // historical window could expose bars beyond the new public cursor, so it
  // must rebuild immediately from cursor-safe rows.
  const authoritativeReset = sourceDeltaType === WINDOW_DELTA_TYPES.REPLACE
    && sourceDelta.preserveRevealedPrefix !== true;
  if (target.rightTruncated && !authoritativeReset) {
    return target.applyRange([], meta);
  }

  const previousRows = target.snapshot().slice();
  const rawPublicTimeMs = Number(sourceDelta.publicTimeMs);
  const publicTimeMs = Number.isSafeInteger(rawPublicTimeMs) && rawPublicTimeMs >= 0
    ? rawPublicTimeMs
    : null;
  const preserveRevealedPrefix = sourceDeltaType !== WINDOW_DELTA_TYPES.REPLACE
    || sourceDelta.preserveRevealedPrefix === true;
  const contextRows = revealedContextRows(previousRows, publicTimeMs);
  if (preserveRevealedPrefix) {
    contextRows.push(...carriedRevealedProjectionRows(
      previousRows,
      projectedRows,
      publicTimeMs,
    ));
    contextRows.sort((left, right) => Number(left.time) - Number(right.time));
  }
  const rows = mergeDisplayContextWithProjection(contextRows, projectedRows);
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
