import type {
  EpochSeconds,
  KlineBar,
} from "./marketDataTypes.js";
import { toEpochSeconds } from "./marketDataTypes.js";

export interface GapDetectionOptions {
  includeTailGap?: boolean;
  nowSecs?: unknown;
  nowMs?: unknown;
}
export interface DetectedGap {
  from: EpochSeconds;
  to: EpochSeconds;
  missingBars: number;
  isTailGap?: true;
}

/**
 * Latest/realtime data may seed an empty series provisionally, but it must not
 * downgrade history that already established the current epoch as ready.
 */
export function resolvePatchedChartDataStatus(
  source: string,
  currentStatus: string | undefined,
): string | undefined {
  if (!source.includes("latest")) return currentStatus;
  return currentStatus === "ready" ? "ready" : "provisional";
}

const CHART_HISTORY_PROOF_FIELDS = [
  "historyComplete",
  "historyRepairPending",
  "historyValidatedCountBack",
  "lastValidatedMs",
] as const;

/**
 * Structural/realtime commits must not erase the last explicit history proof.
 * The window registry is the durable per-series owner; explicit fields from a
 * new history result override it, while malformed persisted values fail closed.
 */
export function inheritChartHistoryProof(
  persistedMeta: Record<string, unknown> | null | undefined,
  explicitMeta: Record<string, unknown> | null | undefined = {},
): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  const persisted = persistedMeta || {};
  if (Object.prototype.hasOwnProperty.call(persisted, "historyComplete")) {
    inherited.historyComplete = persisted.historyComplete === true;
  }
  if (Object.prototype.hasOwnProperty.call(persisted, "historyRepairPending")) {
    inherited.historyRepairPending = persisted.historyRepairPending === true;
  }
  if (Object.prototype.hasOwnProperty.call(persisted, "historyValidatedCountBack")) {
    const parsed = Number(persisted.historyValidatedCountBack);
    inherited.historyValidatedCountBack = Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(persisted, "lastValidatedMs")) {
    const parsed = Number(persisted.lastValidatedMs);
    inherited.lastValidatedMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  const explicit = explicitMeta || {};
  for (const field of CHART_HISTORY_PROOF_FIELDS) {
    if (explicit[field] !== undefined) inherited[field] = explicit[field];
  }
  return inherited;
}

/**
 * Async history and WebSocket callbacks may outlive the chart session that
 * created them. They may still refresh their own warm cache, but only the
 * exact current series is allowed to publish into the visible chart state.
 */
export function seriesCommitOwnsActiveChart(
  targetSeriesKey: string | null | undefined,
  activeSeriesKey: string | null | undefined,
): boolean {
  return Boolean(targetSeriesKey && targetSeriesKey === activeSeriesKey);
}

interface WarmChartPublicationMeta {
  interval?: unknown;
  optimistic?: unknown;
  seriesKey?: unknown;
  symbol?: unknown;
  targetInterval?: unknown;
  targetSeriesKey?: unknown;
  targetSymbol?: unknown;
  version?: unknown;
}

export function shouldDeferWarmChartPublication({
  currentMeta,
  expectedPreviousSeriesKey,
  historyComplete,
  historyRepairPending,
  source,
  targetInterval,
  targetSeriesKey,
  targetSymbol,
}: {
  currentMeta?: WarmChartPublicationMeta | null;
  expectedPreviousSeriesKey?: string | null;
  historyComplete?: boolean;
  historyRepairPending?: boolean;
  source?: string;
  targetInterval?: string;
  targetSeriesKey?: string;
  targetSymbol?: string;
}): boolean {
  return Boolean(
    source === "memory-cache-hit"
    && historyComplete === true
    && historyRepairPending !== true
    && currentMeta?.optimistic === true
    && currentMeta.targetSeriesKey === targetSeriesKey
    && currentMeta.targetSymbol === targetSymbol
    && currentMeta.targetInterval === targetInterval
    && currentMeta.symbol === targetSymbol
    && currentMeta.seriesKey === expectedPreviousSeriesKey
    && typeof currentMeta.interval === "string"
    && currentMeta.interval !== targetInterval
  );
}

export function deferredWarmChartPublicationStillOwnsTarget({
  activeSeriesKey,
  currentMeta,
  registeredStore,
  targetSeriesKey,
  targetStore,
  transitionVersion,
}: {
  activeSeriesKey?: string | null;
  currentMeta?: WarmChartPublicationMeta | null;
  registeredStore?: unknown;
  targetSeriesKey?: string;
  targetStore?: unknown;
  transitionVersion?: number;
}): boolean {
  return Boolean(
    targetSeriesKey
    && activeSeriesKey === targetSeriesKey
    && currentMeta?.optimistic === true
    && currentMeta.targetSeriesKey === targetSeriesKey
    && currentMeta.version === transitionVersion
    && registeredStore === targetStore
  );
}

/**
 * A terminal empty/NOOP history commit can beat the deferred warm-cache task.
 * In that race the pending store must be published before the commit clears
 * the optimistic transition metadata, otherwise the previous interval stays
 * visible after the timer correctly rejects itself.
 */
export function pendingWarmPublicationMatchesCommit({
  activeSeriesKey,
  pendingSeriesKey,
  pendingStore,
  targetSeriesKey,
  targetStore,
}: {
  activeSeriesKey?: string | null;
  pendingSeriesKey?: string | null;
  pendingStore?: unknown;
  targetSeriesKey?: string | null;
  targetStore?: unknown;
}): boolean {
  return Boolean(
    targetSeriesKey
    && activeSeriesKey === targetSeriesKey
    && pendingSeriesKey === targetSeriesKey
    && pendingStore === targetStore
  );
}

export function klineRowsEqual(
  a: unknown,
  b: unknown,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const leftRows: unknown[] = a;
  const rightRows: unknown[] = b;
  if (leftRows.length !== rightRows.length) return false;
  for (let i = 0; i < leftRows.length; i += 1) {
    const left = leftRows[i];
    const right = rightRows[i];
    if (left === null || typeof left !== "object" || Array.isArray(left)
      || right === null || typeof right !== "object" || Array.isArray(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (Reflect.get(left, key) !== Reflect.get(right, key)) return false;
    }
  }
  return true;
}

export function shouldAdoptSharedSeriesSnapshot({
  currentRows,
  ownsActiveSeries,
  sharedRows,
}: {
  currentRows: readonly KlineBar[];
  ownsActiveSeries: boolean;
  sharedRows: readonly KlineBar[];
}): boolean {
  return ownsActiveSeries && sharedRows.length > 0 && currentRows !== sharedRows;
}

function resolveTailGapNow(options: GapDetectionOptions): EpochSeconds | null {
  if (!options?.includeTailGap) return null;
  const explicitSeconds = toEpochSeconds(options.nowSecs);
  if (options.nowSecs != null && explicitSeconds != null) {
    return toEpochSeconds(Math.floor(explicitSeconds));
  }
  const explicitMilliseconds = Number(options.nowMs);
  if (options.nowMs != null && Number.isFinite(explicitMilliseconds)) {
    return toEpochSeconds(Math.floor(explicitMilliseconds / 1000));
  }
  return null;
}

/**
 * Detect internal gaps in a sorted K-line array.
 * Returns gap boundaries in unix seconds.
 *
 * Tail-gap detection is opt-in and must pass an explicit current time. The
 * frontend recovery loop should not infer exchange trading sessions from
 * Date.now(), because inactive sessions can look like missing bars forever.
 */
export function detectGaps(
  data: readonly KlineBar[] | null | undefined,
  intervalSeconds: number | null | undefined,
  options: GapDetectionOptions = {},
): DetectedGap[] {
  if (!data || data.length < 2 || !intervalSeconds || intervalSeconds <= 0) return [];
  const gaps: DetectedGap[] = [];
  const threshold = intervalSeconds * 1.5;

  for (let i = 1; i < data.length; i += 1) {
    const current = data[i];
    const previous = data[i - 1];
    if (!current || !previous) continue;
    const diff = current.time - previous.time;
    if (diff > threshold) {
      gaps.push({
        from: previous.time,
        to: current.time,
        missingBars: Math.round(diff / intervalSeconds) - 1,
      });
    }
  }

  const nowSecs = resolveTailGapNow(options);
  const latestBarTime = data.at(-1)?.time;
  if (latestBarTime == null) return gaps;
  const tailGap = nowSecs == null ? 0 : nowSecs - latestBarTime;
  if (nowSecs != null && tailGap > intervalSeconds * 3) {
    gaps.push({
      from: latestBarTime,
      to: nowSecs,
      missingBars: Math.floor(tailGap / intervalSeconds),
      isTailGap: true,
    });
  }

  return gaps;
}
