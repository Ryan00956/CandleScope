import {
  deduplicateByTime,
  klineRowsEqual,
  mergeByTime,
  upsertRealtimeKline,
} from "../market-data/chartDataRuntime.js";

const entries = new Map();

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
    return next;
  }
  const entry = createEntry(symbolKey, interval, patch);
  entries.set(key, entry);
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
  return next;
}

export function markFullCacheError(symbolKey, interval, error) {
  return ensureFullCacheEntry(symbolKey, interval, {
    status: "error",
    lastError: error?.message || String(error || "Unknown error"),
  });
}

export function getFullCacheEntry(symbolKey, interval) {
  return entries.get(fullCacheKey(symbolKey, interval)) || null;
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

export function resetWatchlistFullCache() {
  entries.clear();
}
