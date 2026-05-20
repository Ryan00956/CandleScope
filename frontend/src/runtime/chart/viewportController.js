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
  if (range.logical && Number.isFinite(range.logical.from) && Number.isFinite(range.logical.to)) {
    normalized.logical = {
      from: range.logical.from,
      to: range.logical.to,
    };
  }
  if (range.time && Number.isFinite(range.time.from) && Number.isFinite(range.time.to)) {
    normalized.time = {
      from: range.time.from,
      to: range.time.to,
    };
  }
  if (Number.isFinite(range.barSpacing)) {
    normalized.barSpacing = range.barSpacing;
  }
  if (Number.isFinite(range.scrollPosition)) {
    normalized.scrollPosition = range.scrollPosition;
  }
  if (Number.isFinite(range.dataVersion)) {
    normalized.dataVersion = range.dataVersion;
  }
  if (typeof range.dataStatus === "string") {
    normalized.dataStatus = range.dataStatus;
  }
  if (typeof range.dataSource === "string") {
    normalized.dataSource = range.dataSource;
  }
  if (Number.isFinite(range.dataFirstTime)) {
    normalized.dataFirstTime = range.dataFirstTime;
  }
  if (Number.isFinite(range.dataLastTime)) {
    normalized.dataLastTime = range.dataLastTime;
  }
  if (Number.isFinite(range.dataBars)) {
    normalized.dataBars = range.dataBars;
  }
  if (Number.isFinite(range.savedAt)) {
    normalized.savedAt = range.savedAt;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function attachVisibleRangeDataMeta(range, dataMeta) {
  if (!range || !dataMeta) return range;
  const next = { ...range };
  if (Number.isFinite(dataMeta.version)) next.dataVersion = dataMeta.version;
  if (typeof dataMeta.status === "string") next.dataStatus = dataMeta.status;
  if (typeof dataMeta.source === "string") next.dataSource = dataMeta.source;
  if (Number.isFinite(dataMeta.firstTime)) next.dataFirstTime = dataMeta.firstTime;
  if (Number.isFinite(dataMeta.lastTime)) next.dataLastTime = dataMeta.lastTime;
  if (Number.isFinite(dataMeta.bars)) next.dataBars = dataMeta.bars;
  next.savedAt = Date.now();
  return next;
}

export function saveVisibleRangeForInterval(symbol, interval, range, marketType = "spot", exchange = "binance", dataMeta = null) {
  const normalized = normalizeVisibleRange(range);
  if (!symbol || !interval || !normalized) return;
  const ranges = loadVisibleRanges();
  ranges[buildVisibleRangeStorageKey(symbol, interval, marketType, exchange)] =
    attachVisibleRangeDataMeta(normalized, dataMeta);
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
  const dataLength = data?.length || 0;
  const firstDataTime = data?.[0]?.time;
  const lastDataTime = dataLength > 0 ? data[dataLength - 1]?.time : undefined;
  const savedTimeRange = savedVisibleRange?.time;
  const savedLogicalRange = savedVisibleRange?.logical;

  const savedTimeIntersectsData = Boolean(
    savedTimeRange
      && Number.isFinite(savedTimeRange.from)
      && Number.isFinite(savedTimeRange.to)
      && Number.isFinite(firstDataTime)
      && Number.isFinite(lastDataTime)
      && savedTimeRange.to >= firstDataTime
      && savedTimeRange.from <= lastDataTime,
  );

  const savedLogicalIntersectsData = Boolean(
    savedLogicalRange
      && Number.isFinite(savedLogicalRange.from)
      && Number.isFinite(savedLogicalRange.to)
      && savedLogicalRange.to >= 0
      && savedLogicalRange.from <= dataLength - 1,
  );

  const savedVersion = savedVisibleRange?.dataVersion;
  const currentVersion = currentDataMeta?.version;
  const hasVersionPair = Number.isFinite(savedVersion) && Number.isFinite(currentVersion);
  const savedVersionMatchesCurrent = !hasVersionPair || savedVersion === currentVersion;
  const canUseLogicalFallback = (!savedTimeRange || savedTimeIntersectsData) && savedVersionMatchesCurrent;
  const barSpacing = Number.isFinite(savedVisibleRange?.barSpacing)
    ? savedVisibleRange.barSpacing
    : null;
  const scrollPosition = Number.isFinite(savedVisibleRange?.scrollPosition)
    ? savedVisibleRange.scrollPosition
    : null;

  if (savedTimeIntersectsData) {
    return {
      mode: "time",
      timeRange: savedTimeRange,
      barSpacing,
      scrollPosition,
    };
  }

  if (canUseLogicalFallback && savedLogicalIntersectsData) {
    return {
      mode: "logical",
      logicalRange: savedLogicalRange,
      barSpacing,
      scrollPosition,
    };
  }

  return {
    mode: "fit",
    timeRange: null,
    logicalRange: null,
    barSpacing: null,
    scrollPosition: null,
  };
}
