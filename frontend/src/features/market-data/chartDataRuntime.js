export function klineRowsEqual(a, b) {
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

function resolveTailGapNow(options) {
  if (!options?.includeTailGap) return null;
  if (options.nowSecs != null && Number.isFinite(Number(options.nowSecs))) {
    return Math.floor(Number(options.nowSecs));
  }
  if (options.nowMs != null && Number.isFinite(Number(options.nowMs))) {
    return Math.floor(Number(options.nowMs) / 1000);
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
export function detectGaps(data, intervalSeconds, options = {}) {
  if (!data || data.length < 2 || !intervalSeconds || intervalSeconds <= 0) return [];
  const gaps = [];
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
