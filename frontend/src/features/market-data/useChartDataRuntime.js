import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireCacheLease,
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { recordFrontendCacheAccess } from "../cache-gc/cacheAccessRuntime.js";
import { markPerfOnce, recordPerfEvent } from "../../runtime/performance/perfMarks";
import { assertWindowBudget } from "../../runtime/performance/windowBudgetAssert";
import { parseIntervalSeconds } from "../../utils/intervals";
import { MAX_SERIES_BARS } from "./phase1WindowPolicy";
import { WINDOW_DELTA_TYPES } from "./window/windowDeltas";
import {
  buildSeriesWindowKey,
  SeriesWindowRegistry,
} from "./window/windowRegistry";

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
  const [activeSeriesStore, setActiveSeriesStore] = useState(null);
  const windowRegistryRef = useRef(null);
  if (windowRegistryRef.current == null) {
    windowRegistryRef.current = new SeriesWindowRegistry({ maxBars: MAX_SERIES_BARS });
  }
  const chartDataVersionRef = useRef(0);
  const chartDataCommitMetaRef = useRef(null);
  const pendingInitialHistoryRef = useRef(null);

  const cacheKey = useCallback(
    (sym, intv, mt = marketType, ex = exchange) => buildSeriesWindowKey({
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
    }),
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
    windowRegistryRef.current.touchMeta(key, patch);
  }, []);

  const getStore = useCallback((
    sym,
    intv,
    {
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      create = true,
      meta = {},
    } = {},
  ) => {
    const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
    if (!create) return windowRegistryRef.current.get(key);
    return windowRegistryRef.current.getOrCreate(key, {
      intervalSeconds: parseIntervalSeconds(intv),
      meta: {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        ...meta,
      },
    });
  }, [cacheKey, exchange, marketType]);

  const registerStoreResource = useCallback((
    key,
    store,
    {
      symbol: cacheSymbol,
      interval: cacheInterval,
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      source,
    },
  ) => {
    const stats = store.describe();
    if (stats.bars <= 0) {
      unregisterCacheResource("chart-data-cache", key);
      return;
    }
    registerCacheResource("chart-data-cache", key, {
      type: "kline",
      dependencyKey: dependencyKeyFor(cacheSymbol, cacheInterval, cacheMarketType, cacheExchange),
      symbol: cacheSymbol,
      interval: cacheInterval,
      marketType: cacheMarketType,
      exchange: cacheExchange,
      bars: stats.bars,
      estimatedBytes: stats.bars * KLINE_ROW_ESTIMATED_BYTES,
      source,
    });
  }, [dependencyKeyFor, exchange, marketType]);

  const recordCacheAccess = useCallback(({
    key,
    symbol: cacheSymbol,
    interval: cacheInterval,
    marketType: cacheMarketType = marketType,
    exchange: cacheExchange = exchange,
    action,
    source,
  }) => {
    recordFrontendCacheAccess({
      owner: "chart-data-cache",
      key,
      exchange: cacheExchange,
      marketType: cacheMarketType,
      symbol: cacheSymbol,
      interval: cacheInterval,
      action,
      source,
    });
  }, [exchange, marketType]);

  const saveToCache = useCallback((
    sym,
    intv,
    data,
    {
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      source = "chart-commit",
    } = {},
  ) => {
    const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
    const store = getStore(sym, intv, {
      marketType: cacheMarketType,
      exchange: cacheExchange,
      meta: { source },
    });
    const delta = store.replace(data, { source });
    recordCacheAccess({
      key,
      symbol: sym,
      interval: intv,
      marketType: cacheMarketType,
      exchange: cacheExchange,
      action: "chart-active",
      source,
    });
    registerStoreResource(key, store, {
      symbol: sym,
      interval: intv,
      marketType: cacheMarketType,
      exchange: cacheExchange,
      source,
    });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType: cacheMarketType,
      exchange: cacheExchange,
      lastUpdatedMs: Date.now(),
      source,
      trimmedLeft: delta.trimmedLeft || 0,
    });
    return store.snapshot();
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    recordCacheAccess,
    registerStoreResource,
    touchCacheMeta,
  ]);

  const getCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) => {
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const store = getStore(sym, intv, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
        create: false,
      });
      if (store && !store.isEmpty()) {
        touchCacheMeta(key);
        recordCacheAccess({
          key,
          symbol: sym,
          interval: intv,
          marketType: cacheMarketType,
          exchange: cacheExchange,
          action: "chart-switch",
          source: "memory-cache-hit",
        });
        return store.snapshot();
      }
      return undefined;
    },
    [cacheKey, exchange, getStore, marketType, recordCacheAccess, touchCacheMeta],
  );

  const getFromCache = useCallback((sym, intv) => getCache(sym, intv), [getCache]);

  const setCache = useCallback(
    (sym, intv, data, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) =>
      saveToCache(sym, intv, data, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
        source: "cache-set",
      }),
    [exchange, marketType, saveToCache],
  );

  const hasCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) =>
      windowRegistryRef.current.has(cacheKey(sym, intv, cacheMarketType, cacheExchange)),
    [cacheKey, exchange, marketType],
  );

  const clearCache = useCallback(() => {
    const keys = windowRegistryRef.current.clear();
    for (const key of keys) {
      unregisterCacheResource("chart-data-cache", key);
    }
    setActiveSeriesStore(null);
  }, []);

  const mergeCacheData = useCallback(
    (sym, intv, incoming, options = {}) => {
      if (!incoming?.length) return getCache(sym, intv, options);
      const cacheMarketType = options.marketType ?? marketType;
      const cacheExchange = options.exchange ?? exchange;
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const store = getStore(sym, intv, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
        meta: { source: "cache-merge" },
      });
      const delta = store.applyRange(incoming, { source: "cache-merge" });
      const rows = store.snapshot({ force: delta.changed });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) return rows;
      recordCacheAccess({
        key,
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        action: "chart-active",
        source: "cache-merge",
      });
      registerStoreResource(key, store, {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        source: "cache-merge",
      });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        lastUpdatedMs: Date.now(),
        source: "cache-merge",
        trimmedLeft: delta.trimmedLeft || 0,
      });
      return rows;
    },
    [
      cacheKey,
      exchange,
      getCache,
      getStore,
      marketType,
      recordCacheAccess,
      registerStoreResource,
      touchCacheMeta,
    ],
  );

  const patchCacheTick = useCallback(
    (sym, intv, tick, options = {}) => {
      const cacheMarketType = options.marketType ?? marketType;
      const cacheExchange = options.exchange ?? exchange;
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const store = getStore(sym, intv, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
        create: false,
      });
      if (!store || store.isEmpty()) return undefined;
      const delta = store.applyTick(tick, { source: "cache-tick" });
      const rows = store.snapshot({ force: delta.changed });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) return rows;
      registerStoreResource(key, store, {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        source: "cache-tick",
      });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        lastUpdatedMs: Date.now(),
        source: "cache-tick",
        trimmedLeft: delta.trimmedLeft || 0,
      });
      return rows;
    },
    [cacheKey, exchange, getStore, marketType, registerStoreResource, touchCacheMeta],
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
    const seriesKey = cacheKey(sym, intv);
    const commitMeta = {
      version,
      status,
      source,
      seriesKey,
      symbol: sym,
      interval: intv,
      bars,
      firstTime,
      lastTime,
      coverage: bars > 0 ? { from: firstTime, to: lastTime, bars } : null,
      committedAt: Date.now(),
      ...metaExtra,
    };
    const store = windowRegistryRef.current.get(seriesKey);
    if (store && bars > 0) {
      registerStoreResource(seriesKey, store, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        source,
      });
    } else {
      unregisterCacheResource("chart-data-cache", seriesKey);
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
    if (metaExtra.trimmedLeft > 0 || metaExtra.trimmedRight > 0) {
      recordPerfEvent("chart.data.trim", {
        source,
        symbol: sym,
        interval: intv,
        bars,
        originalBars: metaExtra.originalBars,
        trimmedLeft: metaExtra.trimmedLeft || 0,
        trimmedRight: metaExtra.trimmedRight || 0,
      });
    }
    assertWindowBudget({
      seriesKey,
      symbol: sym,
      interval: intv,
      exchange,
      marketType,
      bars,
      source,
    });
    if (bars > 0) {
      markPerfOnce("chart.firstBars", { source, status, symbol: sym, interval: intv, bars });
      if (status === "ready" || status === "provisional") {
        markPerfOnce("chart.ready", { source, status, symbol: sym, interval: intv, bars });
      }
    }
    return version;
  }, [cacheKey, exchange, marketType, registerStoreResource]);

  const markChartDataTransition = useCallback((sym, intv, source = "session-transition") => {
    const previous = chartDataCommitMetaRef.current;
    const version = chartDataVersionRef.current + 1;
    chartDataVersionRef.current = version;
    const transitionMeta = {
      ...(previous || {}),
      version,
      status: "loading",
      source,
      targetSeriesKey: cacheKey(sym, intv),
      targetSymbol: sym,
      targetInterval: intv,
      committedAt: Date.now(),
      optimistic: true,
    };
    chartDataCommitMetaRef.current = transitionMeta;
    setChartDataMeta(transitionMeta);
    recordPerfEvent("chart.data.transition", {
      source,
      symbol: sym,
      interval: intv,
      retainedBars: chartDataRef.current.length,
    });
  }, [cacheKey]);

  const getCacheDiagnostics = useCallback(() => {
    const activeKey = cacheKey(symbol, interval);
    const entries = windowRegistryRef.current.entries().map(({ key, store, meta }) => {
      const stats = describeRows(store.snapshot());
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
        ...stats,
      };
    });

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
      const evicted = windowRegistryRef.current.evict(key);
      if (!evicted) continue;
      unregisterCacheResource("chart-data-cache", key);
      removed.push({
        owner: "chart-data-cache",
        key,
        bars: evicted.bars,
        firstTime: evicted.firstTime,
        lastTime: evicted.lastTime,
        estimatedBytes: evicted.bars * KLINE_ROW_ESTIMATED_BYTES,
      });
    }
    return {
      owner: "chart-data-cache",
      removedCount: removed.length,
      removedBars: removed.reduce((total, entry) => total + entry.bars, 0),
      removedEstimatedBytes: removed.reduce((total, entry) => total + entry.estimatedBytes, 0),
      removed,
    };
  }, [cacheKey, interval, symbol]);

  useEffect(() => acquireCacheLease("chart-data-cache", cacheKey(symbol, interval), "active-chart", {
    dependencyKey: dependencyKeyFor(symbol, interval),
    symbol,
    interval,
    exchange,
    marketType,
  }), [cacheKey, dependencyKeyFor, exchange, interval, marketType, symbol]);

  const replaceChartData = useCallback((sym, intv, data, { cache = false, source = "replace" } = {}) => {
    const key = cacheKey(sym, intv);
    const store = getStore(sym, intv, { meta: { source } });
    const delta = store.replace(data, { source });
    const next = store.snapshot({ force: true });
    if (cache && next.length > 0) {
      recordCacheAccess({
        key,
        symbol: sym,
        interval: intv,
        action: "chart-active",
        source,
      });
    }
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      source,
      trimmedLeft: delta.trimmedLeft || 0,
    });
    chartDataRef.current = next;
    recordChartDataCommit(sym, intv, next, source, {
      ...(cache ? { status: "ready" } : {}),
      originalBars: delta.originalBars,
      trimmedLeft: delta.trimmedLeft,
      trimmedRight: delta.trimmedRight,
    });
    setActiveSeriesStore(store);
    setChartData(next);
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    recordCacheAccess,
    recordChartDataCommit,
    touchCacheMeta,
  ]);

  const clearChartData = useCallback((source = "clear", sym = symbol, intv = interval) => {
    const key = cacheKey(sym, intv);
    const store = getStore(sym, intv);
    store.clear({ source });
    chartDataRef.current = [];
    setActiveSeriesStore(store);
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      source,
    });
    recordChartDataCommit(sym, intv, [], source);
    setChartData([]);
  }, [cacheKey, exchange, getStore, interval, marketType, recordChartDataCommit, symbol, touchCacheMeta]);

  const commitMergedChartData = useCallback((sym, intv, incoming, { onMerged, source = "merge" } = {}) => {
    if (!incoming?.length) return;
    const key = cacheKey(sym, intv);
    const store = getStore(sym, intv, { meta: { source } });
    // Re-seed only when the currently rendered rows belong to this exact
    // series (e.g. the active store was evicted while still displayed).
    // During optimistic session transitions chartDataRef still holds the
    // previous series' rows, which must never leak into the new store.
    if (
      store.isEmpty()
      && chartDataRef.current.length > 0
      && chartDataCommitMetaRef.current?.seriesKey === key
    ) {
      store.replace(chartDataRef.current, { source: "active-seed" });
    }
    const delta = store.applyRange(incoming, { source });
    const next = store.snapshot({ force: delta.changed });
    if (delta.type === WINDOW_DELTA_TYPES.NOOP) {
      if (onMerged) onMerged(next);
      return;
    }
    chartDataRef.current = next;
    setActiveSeriesStore(store);
    registerStoreResource(key, store, { symbol: sym, interval: intv, source });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      source,
      trimmedLeft: delta.trimmedLeft || 0,
    });
    recordChartDataCommit(sym, intv, next, source, {
      incomingBars: incoming.length,
      incomingFirstTime: incoming[0]?.time ?? null,
      incomingLastTime: incoming[incoming.length - 1]?.time ?? null,
      status: "ready",
      originalBars: delta.originalBars,
      trimmedLeft: delta.trimmedLeft,
      trimmedRight: delta.trimmedRight,
      windowDeltaType: delta.type,
      addedLeft: delta.addedLeft || 0,
      addedRight: delta.addedRight || 0,
    });
    if (onMerged) onMerged(next);
    setChartData(next);
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    recordChartDataCommit,
    registerStoreResource,
    touchCacheMeta,
  ]);

  const commitPatchedChartData = useCallback((sym, intv, ticks, { seedIfEmpty = false, source = "patch" } = {}) => {
    if (!ticks?.length) return;
    const key = cacheKey(sym, intv);
    const store = getStore(sym, intv, { meta: { source } });
    const prev = store.snapshot();

    if (store.isEmpty() && seedIfEmpty) {
      const delta = store.replace(ticks, { source });
      const nextSeeded = store.snapshot({ force: true });
      chartDataRef.current = nextSeeded;
      registerStoreResource(key, store, { symbol: sym, interval: intv, source });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        lastUpdatedMs: Date.now(),
        source,
        trimmedLeft: delta.trimmedLeft || 0,
      });
      recordChartDataCommit(sym, intv, nextSeeded, source, {
        incomingBars: ticks.length,
        provisional: source?.includes("latest"),
        seeded: true,
        originalBars: delta.originalBars,
        trimmedLeft: delta.trimmedLeft,
        trimmedRight: delta.trimmedRight,
      });
      setActiveSeriesStore(store);
      setChartData(nextSeeded);
      return;
    }

    if (store.isEmpty()) return;

    if (ticks.length > 1) {
      const delta = store.applyRange(ticks, { source });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) return;

      const next = store.snapshot({ force: true });
      chartDataRef.current = next;
      setActiveSeriesStore(store);
      registerStoreResource(key, store, { symbol: sym, interval: intv, source });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        lastUpdatedMs: Date.now(),
        source,
        trimmedLeft: delta.trimmedLeft || 0,
      });
      recordChartDataCommit(sym, intv, next, source, {
        incomingBars: ticks.length,
        status: source?.includes("latest") ? "provisional" : chartDataCommitMetaRef.current?.status,
        seeded: false,
        originalBars: delta.originalBars,
        trimmedLeft: delta.trimmedLeft,
        trimmedRight: delta.trimmedRight,
        windowDeltaType: delta.type,
        addedLeft: delta.addedLeft || 0,
        addedRight: delta.addedRight || 0,
      });
      setChartData(next);
      return;
    }

    let changed = false;
    let appended = false;
    let replaced = false;
    let structural = false;
    let trimmedLeft = 0;
    let trimmedRight = 0;
    for (const tick of ticks) {
      const delta = store.applyTick(tick, { source });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) continue;
      changed = true;
      structural = structural || delta.type !== WINDOW_DELTA_TYPES.TICK;
      appended = appended || Boolean(delta.appended);
      replaced = replaced || Boolean(delta.replaced);
      trimmedLeft += delta.trimmedLeft || 0;
      trimmedRight += delta.trimmedRight || 0;
    }
    if (!changed) return;

    if (!structural && !appended && replaced && trimmedLeft === 0 && trimmedRight === 0) {
      // Replace-last fast path: the store patched its snapshot in place, so
      // chartDataRef stays current without an O(N) rebuild or React commit.
      recordPerfEvent("chart.data.tick", {
        source,
        symbol: sym,
        interval: intv,
        ticks: ticks.length,
        bars: store.barCount,
      });
      return;
    }

    const next = store.snapshot({ force: true });
    chartDataRef.current = next;
    setActiveSeriesStore(store);
    registerStoreResource(key, store, { symbol: sym, interval: intv, source });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      source,
      trimmedLeft,
    });

    recordChartDataCommit(sym, intv, next, source, {
      incomingBars: ticks.length,
      status: prev.length > 0 ? chartDataCommitMetaRef.current?.status : undefined,
      seeded: false,
      originalBars: next.length + trimmedLeft + trimmedRight,
      trimmedLeft,
      trimmedRight,
      windowDeltaType: structural ? WINDOW_DELTA_TYPES.MID_MERGE : WINDOW_DELTA_TYPES.TICK,
    });
    setChartData(next);
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    recordChartDataCommit,
    registerStoreResource,
    touchCacheMeta,
  ]);

  return {
    chartData,
    chartDataMeta,
    activeSeriesStore,
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
    markChartDataTransition,
    commitMergedChartData,
    commitPatchedChartData,
  };
}
