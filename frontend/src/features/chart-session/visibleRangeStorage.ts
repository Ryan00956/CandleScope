import type {
  ExchangeId,
  IntervalString,
  MarketType,
  SymbolCode,
  VisibleRangeRestorePlan,
  VisibleRangeSnapshot,
} from "./chartSessionTypes.js";

const VISIBLE_RANGE_KEY = "candlescope-visible-ranges";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function loadVisibleRanges(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(VISIBLE_RANGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildVisibleRangeStorageKey(
  symbol: SymbolCode,
  interval: IntervalString,
  marketType: MarketType = "spot",
  exchange: ExchangeId = "binance",
): string {
  return `${exchange}::${marketType}::${symbol}::${interval}`;
}

export function normalizeVisibleRange(range: unknown): VisibleRangeSnapshot | null {
  if (!isRecord(range)) return null;
  const normalized: VisibleRangeSnapshot = {};
  if (finiteNumber(range.barSpacing)) {
    normalized.barSpacing = range.barSpacing;
  }

  const rightOffset = finiteNumber(range.rightOffset)
    ? range.rightOffset
    : range.scrollPosition;
  if (finiteNumber(rightOffset)) {
    normalized.rightOffset = rightOffset;
  }

  const legacyTime = isRecord(range.time) ? range.time : null;
  const rightmostTime = finiteNumber(range.rightmostTime)
    ? range.rightmostTime
    : legacyTime?.to;
  if (finiteNumber(rightmostTime)) {
    normalized.rightmostTime = rightmostTime;
  }

  if (finiteNumber(range.savedAt)) {
    normalized.savedAt = range.savedAt;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function saveVisibleRangeForInterval(
  symbol: SymbolCode,
  interval: IntervalString,
  range: unknown,
  marketType: MarketType = "spot",
  exchange: ExchangeId = "binance",
  dataMeta: unknown = null,
): void {
  void dataMeta;
  const rangeRecord = isRecord(range) ? range : {};
  const normalized = normalizeVisibleRange({ ...rangeRecord, savedAt: Date.now() });
  if (!symbol || !interval || !normalized) return;
  const ranges = loadVisibleRanges();
  ranges[buildVisibleRangeStorageKey(symbol, interval, marketType, exchange)] = normalized;
  localStorage.setItem(VISIBLE_RANGE_KEY, JSON.stringify(ranges));
}

export function getVisibleRangeForInterval(
  symbol: SymbolCode,
  interval: IntervalString,
  marketType: MarketType = "spot",
  exchange: ExchangeId = "binance",
): VisibleRangeSnapshot | null {
  if (!symbol || !interval) return null;
  const ranges = loadVisibleRanges();
  return (
    normalizeVisibleRange(ranges[buildVisibleRangeStorageKey(symbol, interval, marketType, exchange)])
    || normalizeVisibleRange(ranges[interval])
    || null
  );
}

export function planVisibleRangeRestore(
  savedVisibleRange: unknown,
  data: unknown,
  currentDataMeta: unknown = null,
): VisibleRangeRestorePlan {
  void data;
  void currentDataMeta;
  const normalized = normalizeVisibleRange(savedVisibleRange);
  const barSpacing = finiteNumber(normalized?.barSpacing)
    ? normalized.barSpacing
    : null;
  const rightOffset = finiteNumber(normalized?.rightOffset)
    ? normalized.rightOffset
    : null;
  const rightmostTime = finiteNumber(normalized?.rightmostTime)
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
