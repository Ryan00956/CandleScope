import {
  klineRowsEqual,
} from "../market-data/chartDataRuntime.js";
import {
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { GcVictim } from "../cache-gc/cacheGcTypes.js";
import type {
  FullCacheCoverage,
  FullCacheEntry,
  FullCacheStatus,
  WarmCacheRow,
} from "./watchlistFullCacheTypes.js";

const entries = new Map<string, FullCacheEntry>();
const KLINE_ROW_ESTIMATED_BYTES = 200;

type FullCacheEntryPatch = Partial<Omit<FullCacheEntry, "key" | "symbolKey" | "interval">>;

function mergeByTime(older: KlineBar[], current: KlineBar[]): KlineBar[] {
  const merged = [...older, ...current];
  const uniq = new Map<number, KlineBar>();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

function deduplicateByTime(data: KlineBar[]): KlineBar[] {
  if (!data || data.length <= 1) return data;
  const seen = new Map<number, KlineBar>();
  for (const item of data) {
    seen.set(item.time, item);
  }
  return Array.from(seen.values()).sort((a, b) => a.time - b.time);
}

/**
 * Apply the ordered realtime contract without scanning historical rows.
 *
 * Browser K-line sockets only forward CREATED / UPDATED / CLOSED events for a
 * series, so supported realtime writes are a tail replacement or a newer-bar
 * append. Historical repairs remain the responsibility of mergeFullCacheRows.
 * The rows array is module-owned and intentionally mutated to keep this hot
 * path O(1) with respect to the number of cached bars.
 */
function patchRealtimeKlineTail(
  rows: KlineBar[],
  incoming: KlineBar | null | undefined,
): boolean {
  if (rows.length === 0 || !incoming || incoming.time == null) return false;

  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  if (!last) return false;

  const next = { ...incoming };
  if (next.time < last.time) return false;

  if (next.time === last.time) {
    if (klineRowsEqual([last], [next])) return false;
    rows[lastIndex] = next;
    return true;
  }

  rows.push(next);
  return true;
}

export function fullCacheKey(symbolKey: string, interval: string): string {
  return `${symbolKey}::${interval}`;
}

function buildCoverage(rows: KlineBar[]): FullCacheCoverage | null {
  if (!rows?.length) return null;
  return {
    firstTime: rows.at(0)?.time ?? null,
    lastTime: rows.at(-1)?.time ?? null,
    bars: rows.length,
  };
}

function registerKlineEntry(entry: FullCacheEntry): void {
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

function createEntry(
  symbolKey: string,
  interval: string,
  patch: FullCacheEntryPatch = {},
): FullCacheEntry {
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

export function ensureFullCacheEntry(
  symbolKey: string,
  interval: string,
  patch: FullCacheEntryPatch = {},
): FullCacheEntry {
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

export function setFullCacheEntryStatus(
  symbolKey: string,
  interval: string,
  status: FullCacheStatus,
  patch: FullCacheEntryPatch = {},
): FullCacheEntry {
  return ensureFullCacheEntry(symbolKey, interval, {
    ...patch,
    status,
  });
}

export function mergeFullCacheRows(
  symbolKey: string,
  interval: string,
  rows: KlineBar[],
  options: FullCacheEntryPatch & { nowMs?: number } = {},
): FullCacheEntry {
  if (!rows?.length) return ensureFullCacheEntry(symbolKey, interval, options);
  const current = ensureFullCacheEntry(symbolKey, interval);
  const merged = current.rows.length > 0 ? mergeByTime(rows, current.rows) : deduplicateByTime(rows);
  if (klineRowsEqual(current.rows, merged)) return current;
  const next: FullCacheEntry = {
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

export function patchFullCacheRealtimeKline(
  symbolKey: string,
  interval: string,
  tick: KlineBar | null | undefined,
  options: FullCacheEntryPatch & { nowMs?: number } = {},
): FullCacheEntry {
  const current = entries.get(fullCacheKey(symbolKey, interval));
  if (!current || !current.rows.length) {
    return mergeFullCacheRows(symbolKey, interval, tick ? [tick] : [], {
      ...options,
      status: "live",
      source: options.source || "ws",
    });
  }
  if (!patchRealtimeKlineTail(current.rows, tick)) return current;
  const nowMs = options.nowMs || Date.now();
  const next: FullCacheEntry = {
    ...current,
    rows: current.rows,
    status: "live",
    source: options.source || "ws",
    lastUpdatedMs: nowMs,
    lastRealtimeMs: nowMs,
    lastError: null,
    coverage: buildCoverage(current.rows),
  };
  entries.set(next.key, next);
  registerKlineEntry(next);
  return next;
}

export function markFullCacheError(symbolKey: string, interval: string, error: unknown): FullCacheEntry {
  return ensureFullCacheEntry(symbolKey, interval, {
    status: "error",
    lastError: error instanceof Error ? error.message : String(error || "Unknown error"),
  });
}

export function getFullCacheEntry(symbolKey: string, interval: string): FullCacheEntry | null {
  const entry = entries.get(fullCacheKey(symbolKey, interval)) || null;
  if (entry) {
    entry.lastAccessMs = Date.now();
  }
  return entry;
}

export function getWarmRows(symbolKey: string, interval: string): WarmCacheRow | null {
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

export function snapshotFullCacheEntries(): FullCacheEntry[] {
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
  const statusCounts = snapshot.reduce<Record<string, number>>((counts, entry) => ({
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

export function trimWatchlistFullCacheEntries(victims: GcVictim[] = []) {
  const keys = new Set(victims.map((victim) => victim?.key).filter(Boolean));
  const removed: Array<{ owner: string; key: string; bars: number; estimatedBytes: number }> = [];
  const skipped: Array<{ owner: string; key: string; reason: string }> = [];
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

export function resetWatchlistFullCache(): void {
  for (const key of entries.keys()) {
    unregisterCacheResource("watchlist-full-cache", key);
  }
  entries.clear();
}
