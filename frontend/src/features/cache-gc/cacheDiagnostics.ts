import { snapshotIndicatorResultCacheDiagnostics } from "../indicators/indicatorResultCacheStore.js";
import { snapshotWatchlistFullCacheDiagnostics } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import { snapshotCacheRegistry } from "./cacheRegistry.js";
import { collectBrowserRuntimePressure } from "./browserPressure.js";
import { snapshotFrontendAutoGcScheduler } from "./frontendAutoGcScheduler.js";
import { snapshotFrontendCacheAccessEvents } from "./cacheAccessRuntime.js";
import type { CacheDiagnostics, CacheDiagnosticsEntry } from "./cacheGcTypes.js";

const KLINE_ROW_ESTIMATED_BYTES = 200;
const INDICATOR_POINT_ESTIMATED_BYTES = 80;
const OUTPUT_ITEM_ESTIMATED_BYTES = 120;

interface SnapshotRecord extends Record<string, unknown> {
  totalBars?: unknown;
  seriesCount?: unknown;
  estimatedBytes?: unknown;
  activeKey?: unknown;
  statusCounts?: unknown;
  entries?: unknown;
  totalPoints?: unknown;
  totalItems?: unknown;
  entryCount?: unknown;
  maxEntries?: unknown;
}

type SnapshotProvider = (() => unknown) | null;

function isSnapshotProvider(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function snapshotRecord(value: unknown): SnapshotRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SnapshotRecord
    : {};
}

function entriesFrom(value: unknown): CacheDiagnosticsEntry[] {
  return Array.isArray(value) ? value as CacheDiagnosticsEntry[] : [];
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function estimateKlineBytes(totalBars: unknown = 0): number {
  return Math.max(0, Number(totalBars || 0)) * KLINE_ROW_ESTIMATED_BYTES;
}

function estimateIndicatorBytes({
  totalPoints = 0,
  totalItems = 0,
}: { totalPoints?: unknown; totalItems?: unknown } = {}): number {
  return (
    Math.max(0, Number(totalPoints || 0)) * INDICATOR_POINT_ESTIMATED_BYTES
    + Math.max(0, Number(totalItems || 0)) * OUTPUT_ITEM_ESTIMATED_BYTES
  );
}

function normalizeChartSnapshot(snapshotValue: unknown = {}) {
  const snapshot = snapshotRecord(snapshotValue);
  const totalBars = Number(snapshot.totalBars || 0);
  return {
    owner: "chart-data-cache",
    label: "主图 K 线缓存",
    seriesCount: Number(snapshot.seriesCount || 0),
    totalBars,
    estimatedBytes: finiteNonNegative(snapshot.estimatedBytes, estimateKlineBytes(totalBars)),
    activeKey: snapshot.activeKey || null,
    entries: entriesFrom(snapshot.entries),
  };
}

function normalizeWatchlistSnapshot(snapshotValue: unknown = {}) {
  const snapshot = snapshotRecord(snapshotValue);
  const totalBars = Number(snapshot.totalBars || 0);
  return {
    owner: "watchlist-full-cache",
    label: "自选 Full 后台缓存",
    seriesCount: Number(snapshot.seriesCount || 0),
    totalBars,
    estimatedBytes: finiteNonNegative(snapshot.estimatedBytes, estimateKlineBytes(totalBars)),
    statusCounts: snapshot.statusCounts || {},
    entries: entriesFrom(snapshot.entries),
  };
}

function normalizeIndicatorSnapshot(snapshotValue: unknown = {}) {
  const snapshot = snapshotRecord(snapshotValue);
  const totalPoints = Number(snapshot.totalPoints || 0);
  const totalItems = Number(snapshot.totalItems || 0);
  return {
    owner: "indicator-result-cache",
    label: "指标结果缓存",
    entryCount: Number(snapshot.entryCount || 0),
    totalPoints,
    totalItems,
    estimatedBytes: finiteNonNegative(
      snapshot.estimatedBytes,
      estimateIndicatorBytes({ totalPoints, totalItems }),
    ),
    maxEntries: snapshot.maxEntries,
    entries: entriesFrom(snapshot.entries),
  };
}

export function collectFrontendCacheDiagnostics({
  chartDataCache = null,
}: { chartDataCache?: SnapshotProvider | unknown } = {}): CacheDiagnostics {
  const chart = normalizeChartSnapshot(
    isSnapshotProvider(chartDataCache) ? chartDataCache() : chartDataCache,
  );
  const watchlist = normalizeWatchlistSnapshot(snapshotWatchlistFullCacheDiagnostics());
  const indicators = normalizeIndicatorSnapshot(snapshotIndicatorResultCacheDiagnostics());
  const estimatedBytes = chart.estimatedBytes + watchlist.estimatedBytes + indicators.estimatedBytes;

  return {
    generatedAtMs: Date.now(),
    mode: "diagnostics",
    estimatedBytes,
    runtimePressure: {
      browserHeap: {
        available: false,
        source: "estimated-cache-bytes",
        estimatedBytes,
      },
      browserStorage: {
        available: false,
        source: "not-collected-sync",
      },
    },
    klineBars: chart.totalBars + watchlist.totalBars,
    indicatorPoints: indicators.totalPoints,
    autoGcRuntime: snapshotFrontendAutoGcScheduler(),
    registry: snapshotCacheRegistry(),
    pendingAccessEvents: snapshotFrontendCacheAccessEvents(),
    owners: {
      chart,
      watchlist,
      indicators,
    },
  };
}

export async function collectFrontendCacheDiagnosticsAsync({
  chartDataCache = null,
}: { chartDataCache?: SnapshotProvider | unknown } = {}): Promise<CacheDiagnostics> {
  const diagnostics = collectFrontendCacheDiagnostics({ chartDataCache });
  return {
    ...diagnostics,
    runtimePressure: await collectBrowserRuntimePressure({
      estimatedBytes: Number(diagnostics.estimatedBytes || 0),
    }),
  };
}
