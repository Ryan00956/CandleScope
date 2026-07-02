const VISIBLE_RANGE_KEY = "candlescope-visible-ranges";

function loadVisibleRanges() {
  try {
    const raw = localStorage.getItem(VISIBLE_RANGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function buildVisibleRangeStorageKey(symbol, interval, marketType = "spot", exchange = "binance") {
  return `${exchange}::${marketType}::${symbol}::${interval}`;
}

export function normalizeVisibleRange(range) {
  if (!range || typeof range !== "object") return null;
  const normalized = {};
  if (Number.isFinite(range.barSpacing)) {
    normalized.barSpacing = range.barSpacing;
  }

  const rightOffset = Number.isFinite(range.rightOffset)
    ? range.rightOffset
    : range.scrollPosition;
  if (Number.isFinite(rightOffset)) {
    normalized.rightOffset = rightOffset;
  }

  const rightmostTime = Number.isFinite(range.rightmostTime)
    ? range.rightmostTime
    : range.time?.to;
  if (Number.isFinite(rightmostTime)) {
    normalized.rightmostTime = rightmostTime;
  }

  if (Number.isFinite(range.savedAt)) {
    normalized.savedAt = range.savedAt;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function saveVisibleRangeForInterval(symbol, interval, range, marketType = "spot", exchange = "binance", dataMeta = null) {
  void dataMeta;
  const normalized = normalizeVisibleRange({ ...range, savedAt: Date.now() });
  if (!symbol || !interval || !normalized) return;
  const ranges = loadVisibleRanges();
  ranges[buildVisibleRangeStorageKey(symbol, interval, marketType, exchange)] = normalized;
  localStorage.setItem(VISIBLE_RANGE_KEY, JSON.stringify(ranges));
}

export function getVisibleRangeForInterval(symbol, interval, marketType = "spot", exchange = "binance") {
  if (!symbol || !interval) return null;
  const ranges = loadVisibleRanges();
  return (
    normalizeVisibleRange(ranges[buildVisibleRangeStorageKey(symbol, interval, marketType, exchange)]) ||
    normalizeVisibleRange(ranges[interval]) ||
    null
  );
}

export function planVisibleRangeRestore(savedVisibleRange, data, currentDataMeta = null) {
  void data;
  void currentDataMeta;
  const normalized = normalizeVisibleRange(savedVisibleRange);
  const barSpacing = Number.isFinite(normalized?.barSpacing)
    ? normalized.barSpacing
    : null;
  const rightOffset = Number.isFinite(normalized?.rightOffset)
    ? normalized.rightOffset
    : null;
  const rightmostTime = Number.isFinite(normalized?.rightmostTime)
    ? normalized.rightmostTime
    : null;

  if (barSpacing != null || rightOffset != null || rightmostTime != null) {
    return {
      mode: "anchor",
      barSpacing,
      rightOffset,
      rightmostTime,
    };
  }

  return {
    mode: "fit",
    timeRange: null,
    logicalRange: null,
    barSpacing: null,
    rightOffset: null,
    rightmostTime: null,
  };
}
