import { snapshotIndicatorResultCacheDiagnostics } from "../indicators/indicatorResultCacheStore.js";
import { snapshotWatchlistFullCacheDiagnostics } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import { snapshotCacheRegistry } from "./cacheRegistry.js";
import { collectBrowserRuntimePressure } from "./browserPressure.js";
import { snapshotFrontendCacheAccessEvents } from "./cacheAccessRuntime.js";

const KLINE_ROW_ESTIMATED_BYTES = 200;
const INDICATOR_POINT_ESTIMATED_BYTES = 80;
const OUTPUT_ITEM_ESTIMATED_BYTES = 120;

function estimateKlineBytes(totalBars = 0) {
  return Math.max(0, Number(totalBars || 0)) * KLINE_ROW_ESTIMATED_BYTES;
}

function estimateIndicatorBytes({ totalPoints = 0, totalItems = 0 } = {}) {
  return (
    Math.max(0, Number(totalPoints || 0)) * INDICATOR_POINT_ESTIMATED_BYTES
    + Math.max(0, Number(totalItems || 0)) * OUTPUT_ITEM_ESTIMATED_BYTES
  );
}

function normalizeChartSnapshot(snapshot = {}) {
  const totalBars = Number(snapshot.totalBars || 0);
  return {
    owner: "chart-data-cache",
    label: "主图 K 线缓存",
    seriesCount: Number(snapshot.seriesCount || 0),
    totalBars,
    estimatedBytes: snapshot.estimatedBytes ?? estimateKlineBytes(totalBars),
    activeKey: snapshot.activeKey || null,
    entries: snapshot.entries || [],
  };
}

function normalizeWatchlistSnapshot(snapshot = {}) {
  const totalBars = Number(snapshot.totalBars || 0);
  return {
    owner: "watchlist-full-cache",
    label: "自选 Full 后台缓存",
    seriesCount: Number(snapshot.seriesCount || 0),
    totalBars,
    estimatedBytes: snapshot.estimatedBytes ?? estimateKlineBytes(totalBars),
    statusCounts: snapshot.statusCounts || {},
    entries: snapshot.entries || [],
  };
}

function normalizeIndicatorSnapshot(snapshot = {}) {
  const totalPoints = Number(snapshot.totalPoints || 0);
  const totalItems = Number(snapshot.totalItems || 0);
  return {
    owner: "indicator-result-cache",
    label: "指标结果缓存",
    entryCount: Number(snapshot.entryCount || 0),
    totalPoints,
    totalItems,
    estimatedBytes: snapshot.estimatedBytes ?? estimateIndicatorBytes({ totalPoints, totalItems }),
    maxEntries: snapshot.maxEntries,
    entries: snapshot.entries || [],
  };
}

export function collectFrontendCacheDiagnostics({ chartDataCache = null } = {}) {
  const chart = normalizeChartSnapshot(
    typeof chartDataCache === "function" ? chartDataCache() : chartDataCache,
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
    registry: snapshotCacheRegistry(),
    pendingAccessEvents: snapshotFrontendCacheAccessEvents(),
    owners: {
      chart,
      watchlist,
      indicators,
    },
  };
}

export async function collectFrontendCacheDiagnosticsAsync({ chartDataCache = null } = {}) {
  const diagnostics = collectFrontendCacheDiagnostics({ chartDataCache });
  return {
    ...diagnostics,
    runtimePressure: await collectBrowserRuntimePressure({
      estimatedBytes: diagnostics.estimatedBytes,
    }),
  };
}
