import {
  klineRowsEqual,
} from "../market-data/chartDataRuntime.js";
import {
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";

const entries = new Map();
const KLINE_ROW_ESTIMATED_BYTES = 200;

function mergeByTime(older, current) {
  const merged = [...older, ...current];
  const uniq = new Map();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

function deduplicateByTime(data) {
  if (!data || data.length <= 1) return data;
  const seen = new Map();
  for (const item of data) {
    seen.set(item.time, item);
  }
  return Array.from(seen.values()).sort((a, b) => a.time - b.time);
}

function upsertRealtimeKline(current, incoming) {
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

export function fullCacheKey(symbolKey, interval) {
  return `${symbolKey}::${interval}`;
}

function buildCoverage(rows) {
  if (!rows?.length) return null;
  return {
    firstTime: rows[0].time ?? null,
    lastTime: rows[rows.length - 1]?.time ?? null,
    bars: rows.length,
  };
}

function registerKlineEntry(entry) {
  const parsed = parseSymbolKey(entry.symbolKey);
  const bars = entry.rows?.length || 0;
  registerCacheResource("watchlist-full-cache", entry.key, {
    type: "kline",
    dependencyKey: klineDependencyKey({
      exchange: parsed.exchange,
      marketType: parsed.marketType,
      symbol: parsed.symbol,
      interval: entry.interval,
    }),
    symbol: parsed.symbol,
    interval: entry.interval,
    marketType: parsed.marketType,
    exchange: parsed.exchange,
    bars,
    estimatedBytes: bars * KLINE_ROW_ESTIMATED_BYTES,
    status: entry.status,
    source: entry.source,
  });
}

function createEntry(symbolKey, interval, patch = {}) {
  const rows = patch.rows || [];
  return {
    key: fullCacheKey(symbolKey, interval),
    symbolKey,
    interval,
    rows,
    status: patch.status || "idle",
    source: patch.source || "cache",
    lastUpdatedMs: patch.lastUpdatedMs || Date.now(),
    lastAccessMs: patch.lastAccessMs || null,
    lastRealtimeMs: patch.lastRealtimeMs || null,
    lastError: patch.lastError || null,
    coverage: buildCoverage(rows),
  };
}

export function ensureFullCacheEntry(symbolKey, interval, patch = {}) {
  const key = fullCacheKey(symbolKey, interval);
  const current = entries.get(key);
  if (current) {
    const next = {
      ...current,
      ...patch,
      lastUpdatedMs: patch.lastUpdatedMs || Date.now(),
    };
    entries.set(key, next);
    registerKlineEntry(next);
    return next;
  }
  const entry = createEntry(symbolKey, interval, patch);
  entries.set(key, entry);
  registerKlineEntry(entry);
  return entry;
}

export function setFullCacheEntryStatus(symbolKey, interval, status, patch = {}) {
  return ensureFullCacheEntry(symbolKey, interval, {
    ...patch,
    status,
  });
}

export function mergeFullCacheRows(symbolKey, interval, rows, options = {}) {
  if (!rows?.length) return ensureFullCacheEntry(symbolKey, interval, options);
  const current = ensureFullCacheEntry(symbolKey, interval);
  const merged = current.rows.length > 0 ? mergeByTime(rows, current.rows) : deduplicateByTime(rows);
  if (klineRowsEqual(current.rows, merged)) return current;
  const next = {
    ...current,
    rows: merged,
    status: options.status || "warm",
    source: options.source || "history",
    lastUpdatedMs: options.nowMs || Date.now(),
    lastError: null,
    coverage: buildCoverage(merged),
  };
  entries.set(next.key, next);
  registerKlineEntry(next);
  return next;
}

export function patchFullCacheRealtimeKline(symbolKey, interval, tick, options = {}) {
  const current = entries.get(fullCacheKey(symbolKey, interval));
  if (!current || !current.rows.length) {
    return mergeFullCacheRows(symbolKey, interval, tick ? [tick] : [], {
      ...options,
      status: "live",
      source: options.source || "ws",
    });
  }
  const patched = deduplicateByTime(upsertRealtimeKline(current.rows, tick));
  if (klineRowsEqual(current.rows, patched)) return current;
  const nowMs = options.nowMs || Date.now();
  const next = {
    ...current,
    rows: patched,
    status: "live",
    source: options.source || "ws",
    lastUpdatedMs: nowMs,
    lastRealtimeMs: nowMs,
    lastError: null,
    coverage: buildCoverage(patched),
  };
  entries.set(next.key, next);
  registerKlineEntry(next);
  return next;
}

export function markFullCacheError(symbolKey, interval, error) {
  return ensureFullCacheEntry(symbolKey, interval, {
    status: "error",
    lastError: error?.message || String(error || "Unknown error"),
  });
}

export function getFullCacheEntry(symbolKey, interval) {
  const entry = entries.get(fullCacheKey(symbolKey, interval)) || null;
  if (entry) {
    entry.lastAccessMs = Date.now();
  }
  return entry;
}

export function getWarmRows(symbolKey, interval) {
  const entry = getFullCacheEntry(symbolKey, interval);
  if (!entry?.rows?.length) return null;
  return {
    rows: entry.rows,
    status: entry.status,
    source: entry.source,
    coverage: entry.coverage,
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

export function snapshotFullCacheEntries() {
  return Array.from(entries.values());
}

export function snapshotWatchlistFullCacheDiagnostics() {
  const snapshot = Array.from(entries.values()).map((entry) => {
    const bars = entry.rows?.length || 0;
    return {
      owner: "watchlist-full-cache",
      key: entry.key,
      symbolKey: entry.symbolKey,
      interval: entry.interval,
      tier: entry.status === "live" ? "subscribed" : "warm",
      status: entry.status,
      source: entry.source,
      bars,
      firstTime: entry.coverage?.firstTime ?? null,
      lastTime: entry.coverage?.lastTime ?? null,
      estimatedBytes: bars * KLINE_ROW_ESTIMATED_BYTES,
      lastAccessMs: entry.lastAccessMs || null,
      lastUpdatedMs: entry.lastUpdatedMs || null,
      lastRealtimeMs: entry.lastRealtimeMs || null,
      lastError: entry.lastError || null,
    };
  });
  const statusCounts = snapshot.reduce((counts, entry) => ({
    ...counts,
    [entry.status]: (counts[entry.status] || 0) + 1,
  }), {});
  const totalBars = snapshot.reduce((total, entry) => total + entry.bars, 0);
  return {
    owner: "watchlist-full-cache",
    seriesCount: snapshot.length,
    totalBars,
    estimatedBytes: totalBars * KLINE_ROW_ESTIMATED_BYTES,
    statusCounts,
    entries: snapshot,
  };
}

export function trimWatchlistFullCacheEntries(victims = []) {
  const keys = new Set(victims.map((victim) => victim?.key).filter(Boolean));
  const removed = [];
  const skipped = [];
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry) continue;
    if (entry.status === "live") {
      skipped.push({ owner: "watchlist-full-cache", key, reason: "live-entry-protected" });
      continue;
    }
    entries.delete(key);
    unregisterCacheResource("watchlist-full-cache", key);
    const bars = entry.rows?.length || 0;
    removed.push({
      owner: "watchlist-full-cache",
      key,
      bars,
      estimatedBytes: bars * KLINE_ROW_ESTIMATED_BYTES,
    });
  }
  return {
    owner: "watchlist-full-cache",
    removedCount: removed.length,
    removedBars: removed.reduce((total, entry) => total + entry.bars, 0),
    removedEstimatedBytes: removed.reduce((total, entry) => total + entry.estimatedBytes, 0),
    skipped,
    removed,
  };
}

export function resetWatchlistFullCache() {
  for (const key of entries.keys()) {
    unregisterCacheResource("watchlist-full-cache", key);
  }
  entries.clear();
}
