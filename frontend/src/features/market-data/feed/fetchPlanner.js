export function seriesKeyFor({
  exchange = "binance",
  marketType = "spot",
  symbol = "BTCUSDT",
  interval = "1h",
} = {}) {
  return [
    String(exchange || "").toLowerCase(),
    String(marketType || "").toLowerCase(),
    String(symbol || "").toUpperCase(),
    String(interval || ""),
  ].join(":");
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRangeSec({ start, end, startSec, endSec } = {}) {
  const normalizedStart = finiteNumber(startSec ?? start);
  const normalizedEnd = finiteNumber(endSec ?? end);
  if (normalizedStart == null || normalizedEnd == null || normalizedEnd < normalizedStart) {
    return null;
  }
  return { start: normalizedStart, end: normalizedEnd };
}

export function normalizeCountBack(countBack) {
  const parsed = finiteNumber(countBack);
  if (parsed == null || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

export function countBackToDays(countBack, intervalSeconds, fallbackDays = 7) {
  const normalizedCountBack = normalizeCountBack(countBack);
  const normalizedIntervalSeconds = finiteNumber(intervalSeconds);
  if (!normalizedCountBack || !normalizedIntervalSeconds || normalizedIntervalSeconds <= 0) {
    return fallbackDays;
  }
  return Math.max(0.001, (normalizedCountBack * normalizedIntervalSeconds) / 86_400);
}

export function planBarsFetch({
  from,
  to,
  countBack,
  days,
  intervalSeconds,
  fallbackDays = 7,
} = {}) {
  const range = normalizeRangeSec({ start: from, end: to });
  if (range) {
    return { type: "range", range };
  }

  const normalizedTo = finiteNumber(to);
  const normalizedCountBack = normalizeCountBack(countBack);
  if (normalizedTo != null && normalizedCountBack) {
    return {
      type: "before",
      before: normalizedTo,
      bars: normalizedCountBack,
    };
  }

  const plannedDays = finiteNumber(days)
    ?? countBackToDays(normalizedCountBack, intervalSeconds, fallbackDays);
  return {
    type: "history",
    days: plannedDays,
    countBack: normalizedCountBack,
  };
}

export function requestKeyFor(type, series, params = {}) {
  const keyParts = [type, seriesKeyFor(series)];
  const sortedEntries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of sortedEntries) {
    keyParts.push(`${key}=${String(value)}`);
  }
  return keyParts.join("|");
}

export function rowsFromResult(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

export function rowRange(rows) {
  if (!rows?.length) return null;
  const times = rows
    .map((row) => finiteNumber(row?.time))
    .filter((time) => time != null);
  if (!times.length) return null;
  return {
    start: Math.min(...times),
    end: Math.max(...times),
  };
}
