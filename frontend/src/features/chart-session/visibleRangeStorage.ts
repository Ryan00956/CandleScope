import type {
  ExchangeId,
  IntervalString,
  MarketType,
  SymbolCode,
  VisibleRangeRestorePlan,
  VisibleRangeSnapshot,
} from "./chartSessionTypes.js";
import {
  canonicalizeIntervalValue,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";

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
  scope: string | null = null,
): string {
  const canonicalInterval = canonicalizeIntervalValue(interval);
  const identity = canonicalInterval
    ? `${exchange}::${marketType}::${symbol}::${canonicalInterval}`
    : "";
  const normalizedScope = String(scope || "").trim();
  return identity && normalizedScope ? `${normalizedScope}::${identity}` : identity;
}

function persistVisibleRanges(ranges: Record<string, unknown>): void {
  try {
    localStorage.setItem(VISIBLE_RANGE_KEY, JSON.stringify(ranges));
  } catch {
    // Visible-range persistence is best effort.
  }
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
  scope: string | null = null,
): void {
  void dataMeta;
  const rangeRecord = isRecord(range) ? range : {};
  const normalized = normalizeVisibleRange({ ...rangeRecord, savedAt: Date.now() });
  const storageKey = buildVisibleRangeStorageKey(symbol, interval, marketType, exchange, scope);
  if (!symbol || !storageKey || !normalized) return;
  const ranges = loadVisibleRanges();
  ranges[storageKey] = normalized;
  persistVisibleRanges(ranges);
}

export function getVisibleRangeForInterval(
  symbol: SymbolCode,
  interval: IntervalString,
  marketType: MarketType = "spot",
  exchange: ExchangeId = "binance",
  scope: string | null = null,
): VisibleRangeSnapshot | null {
  const canonicalInterval = canonicalizeIntervalValue(interval);
  if (!symbol || !canonicalInterval) return null;
  const ranges = loadVisibleRanges();
  const canonicalKey = buildVisibleRangeStorageKey(
    symbol,
    canonicalInterval,
    marketType,
    exchange,
    scope,
  );
  if (Object.prototype.hasOwnProperty.call(ranges, canonicalKey)) {
    return normalizeVisibleRange(ranges[canonicalKey]);
  }

  if (scope) {
    const legacyKey = buildVisibleRangeStorageKey(
      symbol,
      canonicalInterval,
      marketType,
      exchange,
    );
    const legacy = normalizeVisibleRange(ranges[legacyKey]);
    if (legacy) return legacy;
  }

  const normalizedScope = String(scope || "").trim();
  const identityPrefix = normalizedScope
    ? `${normalizedScope}::${exchange}::${marketType}::${symbol}::`
    : `${exchange}::${marketType}::${symbol}::`;
  const rawInterval = String(interval).trim();
  const rawCompositeKey = `${identityPrefix}${rawInterval}`;
  const candidateKeys: string[] = [];
  const addCandidate = (key: string): void => {
    if (key !== canonicalKey && !candidateKeys.includes(key)) candidateKeys.push(key);
  };

  addCandidate(rawCompositeKey);
  for (const key of Object.keys(ranges)) {
    if (!key.startsWith(identityPrefix)) continue;
    const storedInterval = key.slice(identityPrefix.length);
    if (intervalsSemanticallyEquivalent(storedInterval, canonicalInterval)) addCandidate(key);
  }
  addCandidate(canonicalInterval);
  addCandidate(rawInterval);
  for (const key of Object.keys(ranges)) {
    if (key.includes("::")) continue;
    if (intervalsSemanticallyEquivalent(key, canonicalInterval)) addCandidate(key);
  }

  for (const key of candidateKeys) {
    const normalized = normalizeVisibleRange(ranges[key]);
    if (!normalized) continue;
    ranges[canonicalKey] = normalized;
    persistVisibleRanges(ranges);
    return normalized;
  }
  return null;
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
