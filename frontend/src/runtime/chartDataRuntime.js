const MAX_RENDER_GAP_POINTS_PER_GAP = 5_000;
const MAX_RENDER_GAP_POINTS_TOTAL = 20_000;

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

export function buildRenderableChartData(data, intervalSeconds) {
  if (!data || data.length <= 1 || !intervalSeconds || intervalSeconds <= 0) {
    return data || [];
  }

  const sorted = deduplicateByTime(data);
  const rendered = [];
  let insertedTotal = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (i > 0) {
      const previous = sorted[i - 1];
      const diff = current.time - previous.time;
      const missingBars = Math.round(diff / intervalSeconds) - 1;

      if (missingBars > 0) {
        const canInsertFullGap =
          missingBars <= MAX_RENDER_GAP_POINTS_PER_GAP &&
          insertedTotal + missingBars <= MAX_RENDER_GAP_POINTS_TOTAL;

        if (canInsertFullGap) {
          for (let t = previous.time + intervalSeconds; t < current.time; t += intervalSeconds) {
            rendered.push({ time: t, __whitespace: true });
            insertedTotal += 1;
          }
        } else {
          const firstMissing = previous.time + intervalSeconds;
          const lastMissing = current.time - intervalSeconds;
          rendered.push({ time: firstMissing, __whitespace: true });
          insertedTotal += 1;
          if (lastMissing > firstMissing) {
            rendered.push({ time: lastMissing, __whitespace: true });
            insertedTotal += 1;
          }
        }
      }
    }
    rendered.push(current);
  }

  return rendered;
}

/**
 * Detect gaps in a sorted K-line array.
 * Returns gap boundaries in unix seconds.
 */
export function detectGaps(data, intervalSeconds) {
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

  const nowSecs = Math.floor(Date.now() / 1000);
  const latestBarTime = data[data.length - 1].time;
  const tailGap = nowSecs - latestBarTime;
  if (tailGap > intervalSeconds * 3) {
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
