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
