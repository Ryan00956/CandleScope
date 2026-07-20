import {
  klineRowsEqual,
} from "../market-data/chartDataRuntime.js";
import { MAX_SERIES_BARS } from "../market-data/phase1WindowPolicy.js";
import {
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { GcVictim } from "../cache-gc/cacheGcTypes.js";
import type {
  FullCacheCoverage,
  FullCacheEntry,
  FullCacheStatus,
  FullCacheTrimPlan,
  WarmCacheRow,
} from "./watchlistFullCacheTypes.js";

const entries = new Map<string, FullCacheEntry>();
const realtimeRowVersions = new Map<string, Map<number, number>>();
let realtimeVersion = 0;
const KLINE_ROW_ESTIMATED_BYTES = 200;
let nextEntryGeneration = 1;

export const WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS = 500;
export const WATCHLIST_FULL_CACHE_DEFAULT_MAX_BARS = MAX_SERIES_BARS;
const WATCHLIST_FULL_CACHE_SUB_MINUTE_SPAN_SECONDS = 60 * 60;

export function isTrustedFullCachePreload(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return (result as Record<string, unknown>).all_rows_final === true;
}

type FullCacheEntryPatch = Partial<Omit<
  FullCacheEntry,
  "key" | "symbolKey" | "interval" | "generation" | "revision"
>>;

/**
 * Seconds-based subscriptions produce orders of magnitude more rows than the
 * longer intervals. Keep at most one hour for those streams, while retaining
 * enough rows to satisfy the existing warm preload contract.
 */
export function getWatchlistFullCacheMaxBars(interval: string): number {
  const intervalSeconds = parseIntervalSeconds(interval);
  if (intervalSeconds != null && intervalSeconds < 60) {
    return Math.max(
      WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
      Math.min(
        WATCHLIST_FULL_CACHE_DEFAULT_MAX_BARS,
        Math.ceil(WATCHLIST_FULL_CACHE_SUB_MINUTE_SPAN_SECONDS / intervalSeconds),
      ),
    );
  }
  return WATCHLIST_FULL_CACHE_DEFAULT_MAX_BARS;
}

function trimRowsToFullCacheLimit(rows: KlineBar[], interval: string): number {
  const overflow = rows.length - getWatchlistFullCacheMaxBars(interval);
  if (overflow <= 0) return 0;
  rows.splice(0, overflow);
  return overflow;
}

function pruneFullCacheRealtimeRowVersions(
  symbolKey: string,
  interval: string,
  rows: KlineBar[],
): void {
  const key = fullCacheKey(symbolKey, interval);
  const rowVersions = realtimeRowVersions.get(key);
  if (!rowVersions) return;
  const firstTime = rows.at(0)?.time;
  const lastTime = rows.at(-1)?.time;
  if (firstTime == null || lastTime == null) {
    realtimeRowVersions.delete(key);
    return;
  }
  for (const time of rowVersions.keys()) {
    if (time < firstTime || time > lastTime) rowVersions.delete(time);
  }
  if (rowVersions.size === 0) realtimeRowVersions.delete(key);
}

function mergeByTime(
  current: KlineBar[],
  incoming: KlineBar[],
  preserveCurrent?: (time: number) => boolean,
): KlineBar[] {
  // HTTP/history normally wins duplicate timestamps so a verified repair is
  // not hidden by old warm rows. A request-scoped predicate may preserve only
  // timestamps touched by realtime after that HTTP request began.
  const uniq = new Map<number, KlineBar>();
  for (const item of current) {
    uniq.set(item.time, item);
  }
  for (const item of incoming) {
    if (uniq.has(item.time) && preserveCurrent?.(item.time)) continue;
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
 * CREATED / UPDATED / CLOSED events stay on this constant-sized tail path.
 * BAR_AMENDED is handled separately because it is explicitly allowed to
 * replace an arbitrary retained historical timestamp.
 * The rows array is module-owned and intentionally mutated so consumers retain
 * their existing array reference. Retention enforcement is applied separately
 * after an append.
 */
function patchRealtimeKlineTail(
  rows: KlineBar[],
  incoming: KlineBar | null | undefined,
  authoritative: boolean,
): boolean {
  if (rows.length === 0 || !incoming || incoming.time == null) return false;

  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  if (!last) return false;

  const next = { ...incoming };
  if (next.time < last.time) return false;

  if (next.time === last.time) {
    // Once a REST/closed/amended row has been marked final, an ordinary
    // forming-bar update must not regress it back to a partial snapshot.
    if (last.is_closed === true && !authoritative) return false;
    if (klineRowsEqual([last], [next])) return false;
    rows[lastIndex] = next;
    return true;
  }

  rows.push(next);
  return true;
}

function patchHistoricalKlineAmendment(
  rows: KlineBar[],
  incoming: KlineBar | null | undefined,
): boolean {
  if (rows.length === 0 || !incoming || incoming.time == null) return false;

  const next: KlineBar = { ...incoming, is_closed: true };
  const first = rows[0];
  if (!first || next.time < first.time) return false;

  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = rows[middle];
    if (candidate && candidate.time < next.time) low = middle + 1;
    else high = middle;
  }

  const existing = rows[low];
  if (existing?.time === next.time) {
    if (klineRowsEqual([existing], [next])) return false;
    rows[low] = next;
    return true;
  }

  // Do not grow the retained window backwards for an amendment outside its
  // coverage, but repair a missing timestamp inside the retained range.
  rows.splice(low, 0, next);
  return true;
}

function isAuthoritativeRealtimeEvent(
  eventType: string | null | undefined,
  tick: KlineBar | null | undefined,
): boolean {
  return eventType === "bar.closed"
    || eventType === "bar.amended"
    || tick?.is_closed === true;
}

export function fullCacheKey(symbolKey: string, interval: string): string {
  return `${symbolKey}::${interval}`;
}

export function getFullCacheRealtimeVersion(): number {
  return realtimeVersion;
}

export function getFullCacheRealtimeTrackedRowCount(
  symbolKey: string,
  interval: string,
): number {
  return realtimeRowVersions.get(fullCacheKey(symbolKey, interval))?.size || 0;
}

function advanceFullCacheRealtimeVersion(
  symbolKey: string,
  interval: string,
  time: number,
): void {
  const key = fullCacheKey(symbolKey, interval);
  realtimeVersion += 1;
  const rowVersions = realtimeRowVersions.get(key) || new Map<number, number>();
  rowVersions.set(time, realtimeVersion);
  realtimeRowVersions.set(key, rowVersions);
}

function realtimeRowChangedAfter(
  symbolKey: string,
  interval: string,
  time: number,
  version: number,
): boolean {
  return (realtimeRowVersions.get(fullCacheKey(symbolKey, interval))?.get(time) || 0) > version;
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
    generation: entry.generation,
    revision: entry.revision,
    bars,
    maxBars: getWatchlistFullCacheMaxBars(entry.interval),
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
  trimRowsToFullCacheLimit(rows, interval);
  const generation = nextEntryGeneration;
  nextEntryGeneration += 1;
  return {
    key: fullCacheKey(symbolKey, interval),
    symbolKey,
    interval,
    generation,
    revision: 1,
    rows,
    subscribed: patch.subscribed ?? false,
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
    const rows = patch.rows || current.rows;
    trimRowsToFullCacheLimit(rows, interval);
    pruneFullCacheRealtimeRowVersions(symbolKey, interval, rows);
    const next = {
      ...current,
      ...patch,
      rows,
      revision: current.revision + 1,
      subscribed: patch.subscribed ?? current.subscribed ?? false,
      coverage: buildCoverage(rows),
      lastUpdatedMs: patch.lastUpdatedMs ?? Date.now(),
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

function buildSubscribedTrimPlan(entry: FullCacheEntry): FullCacheTrimPlan | null {
  if (!entry.subscribed && entry.status !== "live") return null;
  const keepBars = Math.min(
    WATCHLIST_FULL_CACHE_MIN_RETAINED_BARS,
    getWatchlistFullCacheMaxBars(entry.interval),
  );
  const removedBars = entry.rows.length - keepBars;
  if (removedBars <= 0) return null;
  const keepStart = entry.rows[removedBars]?.time;
  if (keepStart == null) return null;
  return {
    keepStart,
    keepBars,
    removedBars,
    removedEstimatedBytes: removedBars * KLINE_ROW_ESTIMATED_BYTES,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resourceSnapshotMatchesCurrentEntry(entry: FullCacheEntry, victim: GcVictim): boolean {
  const resourceTotals = isRecord(victim.resourceTotals) ? victim.resourceTotals : null;
  const bars = entry.rows.length;
  const estimatedBytes = bars * KLINE_ROW_ESTIMATED_BYTES;
  return victim.owner === "watchlist-full-cache"
    && victim.category === "kline"
    && victim.generation === entry.generation
    && victim.expectedRevision === entry.revision
    && victim.lastAccessMs === entry.lastAccessMs
    && victim.lastUpdatedMs === entry.lastUpdatedMs
    && victim.lastRealtimeMs === entry.lastRealtimeMs
    && resourceTotals != null
    && resourceTotals.bars === bars
    && resourceTotals.indicatorPoints === 0
    && resourceTotals.indicatorItems === 0
    && resourceTotals.estimatedBytes === estimatedBytes;
}

function deletePlanMatchesCurrentEntry(entry: FullCacheEntry, victim: GcVictim): boolean {
  const relief = isRecord(victim.relief) ? victim.relief : null;
  const bars = entry.rows.length;
  const estimatedBytes = bars * KLINE_ROW_ESTIMATED_BYTES;
  return resourceSnapshotMatchesCurrentEntry(entry, victim)
    && victim.bars === bars
    && victim.points === 0
    && victim.items === 0
    && victim.estimatedBytes === estimatedBytes
    && relief != null
    && relief.bars === bars
    && relief.indicatorPoints === 0
    && relief.indicatorItems === 0
    && relief.estimatedBytes === estimatedBytes;
}

export function setFullCacheEntrySubscribed(
  symbolKey: string,
  interval: string,
  subscribed: boolean,
): FullCacheEntry {
  const key = fullCacheKey(symbolKey, interval);
  const current = entries.get(key);
  if (!current) return ensureFullCacheEntry(symbolKey, interval, { subscribed });
  const trimmedBars = trimRowsToFullCacheLimit(current.rows, interval);
  pruneFullCacheRealtimeRowVersions(symbolKey, interval, current.rows);
  if (current.subscribed === subscribed && trimmedBars === 0) return current;
  const next: FullCacheEntry = {
    ...current,
    subscribed,
    revision: current.revision + 1,
    coverage: buildCoverage(current.rows),
  };
  entries.set(key, next);
  registerKlineEntry(next);
  return next;
}

export function mergeFullCacheRows(
  symbolKey: string,
  interval: string,
  rows: KlineBar[],
  options: FullCacheEntryPatch & {
    nowMs?: number;
    expectedRealtimeVersion?: number;
  } = {},
): FullCacheEntry {
  if (!rows?.length) {
    const entryPatch: FullCacheEntryPatch & {
      nowMs?: number;
      expectedRealtimeVersion?: number;
    } = { ...options };
    delete entryPatch.nowMs;
    delete entryPatch.expectedRealtimeVersion;
    return ensureFullCacheEntry(symbolKey, interval, entryPatch);
  }
  const current = ensureFullCacheEntry(symbolKey, interval);
  const expectedRealtimeVersion = options.expectedRealtimeVersion;
  const merged = current.rows.length > 0
    ? mergeByTime(
      current.rows,
      rows,
      expectedRealtimeVersion == null
        ? undefined
        : (time) => realtimeRowChangedAfter(
          symbolKey,
          interval,
          time,
          expectedRealtimeVersion,
        ),
    )
    : deduplicateByTime(rows);
  trimRowsToFullCacheLimit(merged, interval);
  pruneFullCacheRealtimeRowVersions(symbolKey, interval, merged);
  if (klineRowsEqual(current.rows, merged)) return current;
  const next: FullCacheEntry = {
    ...current,
    rows: merged,
    revision: current.revision + 1,
    status: options.status || "warm",
    source: options.source || "history",
    lastUpdatedMs: options.nowMs || Date.now(),
    lastRealtimeMs: options.lastRealtimeMs ?? current.lastRealtimeMs,
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
  options: FullCacheEntryPatch & { nowMs?: number; eventType?: string | null } = {},
): FullCacheEntry {
  const current = entries.get(fullCacheKey(symbolKey, interval));
  if (!current || !current.rows.length) {
    const nowMs = options.nowMs || Date.now();
    const next = mergeFullCacheRows(symbolKey, interval, tick ? [tick] : [], {
      ...options,
      status: "live",
      source: options.source || "ws",
      lastRealtimeMs: nowMs,
      nowMs,
    });
    if (
      tick?.time != null
      && isAuthoritativeRealtimeEvent(options.eventType, tick)
    ) {
      advanceFullCacheRealtimeVersion(symbolKey, interval, tick.time);
    }
    return next;
  }
  const amended = options.eventType === "bar.amended";
  const acceptedRealtimeOrder = tick?.time != null && (
    amended
      ? tick.time >= (current.rows[0]?.time ?? Number.POSITIVE_INFINITY)
      : tick.time >= (current.rows.at(-1)?.time ?? Number.POSITIVE_INFINITY)
  );
  const patched = amended
    ? patchHistoricalKlineAmendment(current.rows, tick)
    : patchRealtimeKlineTail(
      current.rows,
      tick,
      isAuthoritativeRealtimeEvent(options.eventType, tick),
    );
  const trimmedBars = trimRowsToFullCacheLimit(current.rows, interval);
  if (
    acceptedRealtimeOrder
    && isAuthoritativeRealtimeEvent(options.eventType, tick)
    && tick?.time != null
  ) {
    advanceFullCacheRealtimeVersion(symbolKey, interval, tick.time);
  }
  pruneFullCacheRealtimeRowVersions(symbolKey, interval, current.rows);
  if (!patched && trimmedBars === 0) return current;
  const nowMs = options.nowMs || Date.now();
  const next: FullCacheEntry = {
    ...current,
    rows: current.rows,
    revision: current.revision + 1,
    status: patched ? "live" : current.status,
    source: patched ? options.source || "ws" : current.source,
    lastUpdatedMs: patched ? nowMs : current.lastUpdatedMs,
    lastRealtimeMs: patched ? nowMs : current.lastRealtimeMs,
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
    entry.revision += 1;
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
    const trimPlan = buildSubscribedTrimPlan(entry);
    return {
      owner: "watchlist-full-cache",
      key: entry.key,
      symbolKey: entry.symbolKey,
      interval: entry.interval,
      generation: entry.generation,
      revision: entry.revision,
      tier: entry.subscribed || entry.status === "live" ? "subscribed" : "warm",
      subscribed: entry.subscribed,
      status: entry.status,
      source: entry.source,
      bars,
      maxBars: getWatchlistFullCacheMaxBars(entry.interval),
      firstTime: entry.coverage?.firstTime ?? null,
      lastTime: entry.coverage?.lastTime ?? null,
      estimatedBytes: bars * KLINE_ROW_ESTIMATED_BYTES,
      lastAccessMs: entry.lastAccessMs ?? null,
      lastUpdatedMs: entry.lastUpdatedMs ?? null,
      lastRealtimeMs: entry.lastRealtimeMs ?? null,
      lastError: entry.lastError || null,
      ...(trimPlan ? {
        trimSafety: { safeRangeTrim: true as const },
        trimPlan,
      } : {}),
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
  const byKey = new Map<string, GcVictim>();
  for (const victim of victims) {
    if (typeof victim?.key === "string" && victim.key) byKey.set(victim.key, victim);
  }
  const removed: Array<{
    owner: string;
    key: string;
    action: "trim-range" | "delete-entry";
    bars: number;
    estimatedBytes: number;
    remainingBars?: number;
  }> = [];
  const skipped: Array<{ owner: string; key: string; reason: string }> = [];
  for (const [key, victim] of byKey.entries()) {
    const entry = entries.get(key);
    if (!entry) continue;
    const protectedEntry = Boolean(
      entry.subscribed
      || entry.status === "live"
      || victim.tier === "active"
      || victim.tier === "subscribed",
    );
    if (victim.action === "trim-range") {
      const currentPlan = buildSubscribedTrimPlan({
        ...entry,
        subscribed: true,
      });
      const suppliedPlan = victim.trimPlan as Record<string, unknown> | undefined;
      const suppliedRelief = victim.relief;
      const planMatches = currentPlan != null
        && resourceSnapshotMatchesCurrentEntry(entry, victim)
        && victim.trimSafety?.safeRangeTrim === true
        && Number(suppliedPlan?.keepStart) === Number(currentPlan.keepStart)
        && Number(suppliedPlan?.keepBars) === currentPlan.keepBars
        && Number(suppliedPlan?.removedBars) === currentPlan.removedBars
        && Number(suppliedPlan?.removedEstimatedBytes) === currentPlan.removedEstimatedBytes
        && Number(victim.keepStart) === Number(currentPlan.keepStart)
        && Number(victim.bars) === currentPlan.removedBars
        && Number(victim.estimatedBytes) === currentPlan.removedEstimatedBytes
        && (suppliedRelief == null || (
          Number(suppliedRelief.bars) === currentPlan.removedBars
          && Number(suppliedRelief.estimatedBytes) === currentPlan.removedEstimatedBytes
        ));
      if (!planMatches || !currentPlan) {
        skipped.push({ owner: "watchlist-full-cache", key, reason: "trim-plan-stale-or-invalid" });
        continue;
      }
      entry.rows.splice(0, currentPlan.removedBars);
      pruneFullCacheRealtimeRowVersions(entry.symbolKey, entry.interval, entry.rows);
      entry.coverage = buildCoverage(entry.rows);
      entry.revision += 1;
      entries.set(key, entry);
      registerKlineEntry(entry);
      removed.push({
        owner: "watchlist-full-cache",
        key,
        action: "trim-range",
        bars: currentPlan.removedBars,
        estimatedBytes: currentPlan.removedEstimatedBytes,
        remainingBars: entry.rows.length,
      });
      continue;
    }
    if (protectedEntry) {
      skipped.push({ owner: "watchlist-full-cache", key, reason: "subscribed-delete-protected" });
      continue;
    }
    if (!deletePlanMatchesCurrentEntry(entry, victim)) {
      skipped.push({ owner: "watchlist-full-cache", key, reason: "delete-plan-stale-or-invalid" });
      continue;
    }
    entries.delete(key);
    realtimeRowVersions.delete(key);
    unregisterCacheResource("watchlist-full-cache", key);
    const bars = entry.rows?.length || 0;
    removed.push({
      owner: "watchlist-full-cache",
      key,
      action: "delete-entry",
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
  realtimeRowVersions.clear();
}
