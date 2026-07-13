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

export function klineRowsEqual(
  a: readonly Record<string, unknown>[] | null | undefined,
  b: readonly Record<string, unknown>[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] || {};
    const right = b[i] || {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (left[key] !== right[key]) return false;
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
    const diff = data[i].time - data[i - 1].time;
    if (diff > threshold) {
      gaps.push({
        from: data[i - 1].time,
        to: data[i].time,
        missingBars: Math.round(diff / intervalSeconds) - 1,
      });
    }
  }

  const nowSecs = resolveTailGapNow(options);
  const latestBarTime = data[data.length - 1].time;
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
