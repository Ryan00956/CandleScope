import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireCacheLease,
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { recordFrontendCacheAccess } from "../cache-gc/cacheAccessRuntime.js";
import { markPerfOnce, recordPerfEvent } from "../../runtime/performance/perfMarks";
import { deduplicateByTime, klineRowsEqual, mergeByTime, upsertRealtimeKline } from "./chartDataRuntime";

const KLINE_ROW_ESTIMATED_BYTES = 200;

function inferCommitStatus(source, data, extra = {}) {
  if (extra.status) return extra.status;
  if (!data?.length) {
    return source?.includes("load-start") ? "loading" : "idle";
  }
  if (extra.provisional || source?.includes("latest")) return "provisional";
  if (source?.includes("clear")) return "loading";
  return "ready";
}

export function useChartDataRuntime({ exchange, marketType, symbol, interval }) {
  const [chartData, setChartData] = useState([]);
  const chartDataRef = useRef([]);
  const [chartDataMeta, setChartDataMeta] = useState({
    version: 0,
    status: "idle",
    source: "initial",
    seriesKey: null,
    symbol,
    interval,
    bars: 0,
    firstTime: null,
    lastTime: null,
    coverage: null,
    committedAt: null,
  });
  const chartDataCacheRef = useRef(new Map());
  const chartDataCacheMetaRef = useRef(new Map());
  const chartDataVersionRef = useRef(0);
  const chartDataCommitMetaRef = useRef(null);
  const pendingInitialHistoryRef = useRef(null);

  const cacheKey = useCallback(
    (sym, intv, mt = marketType, ex = exchange) => `${ex}-${mt}-${sym}-${intv}`,
    [exchange, marketType],
  );

  const dependencyKeyFor = useCallback(
    (sym, intv, mt = marketType, ex = exchange) => klineDependencyKey({
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
    }),
    [exchange, marketType],
  );

  const describeRows = useCallback((rows) => {
    const list = rows || [];
    const lastIndex = list.length - 1;
    return {
      bars: list.length,
      firstTime: list[0]?.time ?? null,
      lastTime: lastIndex >= 0 ? list[lastIndex]?.time ?? null : null,
      estimatedBytes: list.length * KLINE_ROW_ESTIMATED_BYTES,
    };
  }, []);

  const touchCacheMeta = useCallback((key, patch = {}) => {
    const current = chartDataCacheMetaRef.current.get(key) || {};
    chartDataCacheMetaRef.current.set(key, {
      ...current,
      ...patch,
      lastAccessMs: Date.now(),
    });
  }, []);

  const saveToCache = useCallback((sym, intv, data) => {
    const key = cacheKey(sym, intv);
    chartDataCacheRef.current.set(key, data);
    recordFrontendCacheAccess({
      owner: "chart-data-cache",
      key,
      exchange,
      marketType,
      symbol: sym,
      interval: intv,
      action: "chart-active",
      source: "chart-commit",
    });
    const stats = describeRows(data);
    registerCacheResource("chart-data-cache", key, {
      type: "kline",
      dependencyKey: dependencyKeyFor(sym, intv),
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      bars: stats.bars,
      estimatedBytes: stats.estimatedBytes,
      source: "chart-commit",
    });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      source: "chart-commit",
    });
  }, [cacheKey, dependencyKeyFor, describeRows, exchange, marketType, touchCacheMeta]);

  const getFromCache = useCallback(
    (sym, intv) => {
      const key = cacheKey(sym, intv);
      const value = chartDataCacheRef.current.get(key);
      if (value) {
        touchCacheMeta(key);
        recordFrontendCacheAccess({
          owner: "chart-data-cache",
          key,
          exchange,
          marketType,
          symbol: sym,
          interval: intv,
          action: "chart-switch",
          source: "memory-cache-hit",
        });
      }
      return value;
    },
    [cacheKey, exchange, marketType, touchCacheMeta],
  );

  const getCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) => {
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const value = chartDataCacheRef.current.get(key);
      if (value) {
        touchCacheMeta(key);
        recordFrontendCacheAccess({
          owner: "chart-data-cache",
          key,
          exchange: cacheExchange,
          marketType: cacheMarketType,
          symbol: sym,
          interval: intv,
          action: "chart-switch",
          source: "memory-cache-hit",
        });
      }
      return value;
    },
    [cacheKey, exchange, marketType, touchCacheMeta],
  );

  const setCache = useCallback(
    (sym, intv, data, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) => {
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      chartDataCacheRef.current.set(key, data);
      recordFrontendCacheAccess({
        owner: "chart-data-cache",
        key,
        exchange: cacheExchange,
        marketType: cacheMarketType,
        symbol: sym,
        interval: intv,
        action: "chart-active",
        source: "cache-set",
      });
      const stats = describeRows(data);
      registerCacheResource("chart-data-cache", key, {
        type: "kline",
        dependencyKey: dependencyKeyFor(sym, intv, cacheMarketType, cacheExchange),
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        bars: stats.bars,
        estimatedBytes: stats.estimatedBytes,
        source: "cache-set",
      });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        lastUpdatedMs: Date.now(),
        source: "cache-set",
      });
    },
    [cacheKey, dependencyKeyFor, describeRows, exchange, marketType, touchCacheMeta],
  );

  const hasCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) =>
      chartDataCacheRef.current.has(cacheKey(sym, intv, cacheMarketType, cacheExchange)),
    [cacheKey, exchange, marketType],
  );

  const clearCache = useCallback(() => {
    for (const key of chartDataCacheRef.current.keys()) {
      unregisterCacheResource("chart-data-cache", key);
    }
    chartDataCacheRef.current.clear();
    chartDataCacheMetaRef.current.clear();
  }, []);

  const mergeCacheData = useCallback(
    (sym, intv, incoming, options = {}) => {
      if (!incoming?.length) return getCache(sym, intv, options);
      const existing = getCache(sym, intv, options);
      const merged = existing && existing.length > 0 ? mergeByTime(incoming, existing) : incoming;
      if (existing && klineRowsEqual(existing, merged)) return existing;
      setCache(sym, intv, merged, options);
      return merged;
    },
    [getCache, setCache],
  );

  const patchCacheTick = useCallback(
    (sym, intv, tick, options = {}) => {
      const existing = getCache(sym, intv, options);
      if (!existing || existing.length === 0) return existing;
      const updated = deduplicateByTime(upsertRealtimeKline(existing, tick));
      setCache(sym, intv, updated, options);
      return updated;
    },
    [getCache, setCache],
  );

  const recordChartDataCommit = useCallback((sym, intv, data, source, extra = {}) => {
    const version = chartDataVersionRef.current + 1;
    const { status: _extraStatus, ...metaExtra } = extra;
    const lastIndex = data?.length ? data.length - 1 : -1;
    const firstTime = data?.[0]?.time ?? null;
    const lastTime = lastIndex >= 0 ? data[lastIndex]?.time ?? null : null;
    const bars = data?.length || 0;
    const status = inferCommitStatus(source, data, extra);
    chartDataVersionRef.current = version;
    const commitMeta = {
      version,
      status,
      source,
      seriesKey: cacheKey(sym, intv),
      symbol: sym,
      interval: intv,
      bars,
      firstTime,
      lastTime,
      coverage: bars > 0 ? { from: firstTime, to: lastTime, bars } : null,
      committedAt: Date.now(),
      ...metaExtra,
    };
    if (bars > 0) {
      registerCacheResource("chart-data-cache", commitMeta.seriesKey, {
        type: "kline",
        dependencyKey: dependencyKeyFor(sym, intv),
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        bars,
        estimatedBytes: bars * KLINE_ROW_ESTIMATED_BYTES,
        source,
      });
    } else {
      unregisterCacheResource("chart-data-cache", commitMeta.seriesKey);
    }
    chartDataCommitMetaRef.current = commitMeta;
    setChartDataMeta(commitMeta);
    recordPerfEvent("chart.data.commit", {
      source,
      status,
      symbol: sym,
      interval: intv,
      bars,
      firstTime,
      lastTime,
    });
    if (bars > 0) {
      markPerfOnce("chart.firstBars", { source, status, symbol: sym, interval: intv, bars });
      if (status === "ready" || status === "provisional") {
        markPerfOnce("chart.ready", { source, status, symbol: sym, interval: intv, bars });
      }
    }
    return version;
  }, [cacheKey, dependencyKeyFor, exchange, marketType]);

  const getCacheDiagnostics = useCallback(() => {
    const activeKey = cacheKey(symbol, interval);
    const entries = Array.from(chartDataCacheRef.current.entries()).map(([key, rows]) => {
      const meta = chartDataCacheMetaRef.current.get(key) || {};
      return {
        owner: "chart-data-cache",
        key,
        tier: key === activeKey ? "active" : "warm",
        symbol: meta.symbol || null,
        interval: meta.interval || null,
        exchange: meta.exchange || exchange,
        marketType: meta.marketType || marketType,
        source: meta.source || "cache",
        lastAccessMs: meta.lastAccessMs || null,
        lastUpdatedMs: meta.lastUpdatedMs || null,
        ...describeRows(rows),
      };
    });

    if (chartDataRef.current.length > 0 && !entries.some((entry) => entry.key === activeKey)) {
      entries.push({
        owner: "chart-data-cache",
        key: activeKey,
        tier: "active",
        symbol,
        interval,
        exchange,
        marketType,
        source: chartDataCommitMetaRef.current?.source || "active-chart",
        lastAccessMs: chartDataCommitMetaRef.current?.committedAt || null,
        lastUpdatedMs: chartDataCommitMetaRef.current?.committedAt || null,
        ...describeRows(chartDataRef.current),
      });
    }

    const totalBars = entries.reduce((total, entry) => total + entry.bars, 0);
    return {
      owner: "chart-data-cache",
      activeKey,
      seriesCount: entries.length,
      totalBars,
      estimatedBytes: totalBars * KLINE_ROW_ESTIMATED_BYTES,
      entries,
    };
  }, [cacheKey, describeRows, exchange, interval, marketType, symbol]);

  const trimCacheEntries = useCallback((victims = []) => {
    const activeKey = cacheKey(symbol, interval);
    const keys = new Set(victims.map((victim) => victim?.key).filter(Boolean));
    const removed = [];
    for (const key of keys) {
      if (key === activeKey) continue;
      const rows = chartDataCacheRef.current.get(key);
      if (!rows) continue;
      chartDataCacheRef.current.delete(key);
      chartDataCacheMetaRef.current.delete(key);
      unregisterCacheResource("chart-data-cache", key);
      removed.push({
        owner: "chart-data-cache",
        key,
        ...describeRows(rows),
      });
    }
    return {
      owner: "chart-data-cache",
      removedCount: removed.length,
      removedBars: removed.reduce((total, entry) => total + entry.bars, 0),
      removedEstimatedBytes: removed.reduce((total, entry) => total + entry.estimatedBytes, 0),
      removed,
    };
  }, [cacheKey, describeRows, interval, symbol]);

  useEffect(() => acquireCacheLease("chart-data-cache", cacheKey(symbol, interval), "active-chart", {
    dependencyKey: dependencyKeyFor(symbol, interval),
    symbol,
    interval,
    exchange,
    marketType,
  }), [cacheKey, dependencyKeyFor, exchange, interval, marketType, symbol]);

  const replaceChartData = useCallback((sym, intv, data, { cache = false, source = "replace" } = {}) => {
    const next = data || [];
    if (cache && next.length > 0) {
      saveToCache(sym, intv, next);
    }
    chartDataRef.current = next;
    recordChartDataCommit(sym, intv, next, source, cache ? { status: "ready" } : {});
    setChartData(next);
  }, [recordChartDataCommit, saveToCache]);

  const clearChartData = useCallback((source = "clear", sym = symbol, intv = interval) => {
    chartDataRef.current = [];
    recordChartDataCommit(sym, intv, [], source);
    setChartData([]);
  }, [interval, recordChartDataCommit, symbol]);

  const commitMergedChartData = useCallback((sym, intv, incoming, { onMerged, source = "merge" } = {}) => {
    if (!incoming?.length) return;
    const previous = chartDataRef.current;
    const merged = mergeByTime(incoming, previous);
    if (klineRowsEqual(previous, merged)) {
      if (onMerged) onMerged(previous);
      return;
    }
    chartDataRef.current = merged;
    saveToCache(sym, intv, merged);
    recordChartDataCommit(sym, intv, merged, source, { incomingBars: incoming.length, status: "ready" });
    if (onMerged) onMerged(merged);
    setChartData(merged);
  }, [recordChartDataCommit, saveToCache]);

  const commitPatchedChartData = useCallback((sym, intv, ticks, { seedIfEmpty = false, source = "patch" } = {}) => {
    if (!ticks?.length) return;
    const prev = chartDataRef.current;
    if (prev.length === 0 && seedIfEmpty) {
      const seeded = deduplicateByTime(ticks);
      chartDataRef.current = seeded;
      saveToCache(sym, intv, seeded);
      recordChartDataCommit(sym, intv, seeded, source, {
        incomingBars: ticks.length,
        provisional: source?.includes("latest"),
        seeded: true,
      });
      setChartData(seeded);
      return;
    }

    let updated = prev;
    ticks.forEach((tick) => {
      updated = upsertRealtimeKline(updated, tick);
    });
    const deduped = deduplicateByTime(updated);
    chartDataRef.current = deduped;
    saveToCache(sym, intv, deduped);
    recordChartDataCommit(sym, intv, deduped, source, {
      incomingBars: ticks.length,
      status: prev.length > 0 ? chartDataCommitMetaRef.current?.status : undefined,
      seeded: false,
    });
    setChartData(deduped);
  }, [recordChartDataCommit, saveToCache]);

  return {
    chartData,
    chartDataMeta,
    pendingInitialHistoryRef,
    cacheKey,
    getFromCache,
    getCache,
    setCache,
    hasCache,
    clearCache,
    getCacheDiagnostics,
    trimCacheEntries,
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
  };
}
