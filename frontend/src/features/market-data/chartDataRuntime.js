export function mergeByTime(older, current) {
  const merged = [...older, ...current];
  const uniq = new Map();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

export function deduplicateByTime(data) {
  if (!data || data.length <= 1) return data;
  const seen = new Map();
  for (const item of data) {
    seen.set(item.time, item);
  }
  return Array.from(seen.values()).sort((a, b) => a.time - b.time);
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

export function upsertRealtimeKline(current, incoming) {
  if (!current || current.length === 0) return current;
  if (!incoming || incoming.time == null) return current;
  const next = { ...incoming };

  const firstTime = current[0].time;
  const lastIndex = current.length - 1;
  const lastTime = current[lastIndex].time;

  if (next.time < firstTime) return current;
  if (next.time === lastTime) {
    const updated = [...current];
    updated[lastIndex] = next;
    return updated;
  }
  if (next.time > lastTime) {
    return [...current, next];
  }

  const idx = current.findIndex((item) => item.time === next.time);
  if (idx === -1) return current;
  const updated = [...current];
  updated[idx] = next;
  return updated;
}
