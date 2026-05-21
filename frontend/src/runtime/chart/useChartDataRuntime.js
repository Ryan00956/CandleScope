import { useCallback, useRef, useState } from "react";
import { markPerfOnce, recordPerfEvent } from "../performance/perfMarks";
import { deduplicateByTime, mergeByTime, upsertRealtimeKline } from "./chartDataRuntime";

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
  const chartDataVersionRef = useRef(0);
  const chartDataCommitMetaRef = useRef(null);
  const pendingInitialHistoryRef = useRef(null);

  const cacheKey = useCallback(
    (sym, intv, mt = marketType, ex = exchange) => `${ex}-${mt}-${sym}-${intv}`,
    [exchange, marketType],
  );

  const saveToCache = useCallback((sym, intv, data) => {
    chartDataCacheRef.current.set(cacheKey(sym, intv), data);
  }, [cacheKey]);

  const getFromCache = useCallback(
    (sym, intv) => chartDataCacheRef.current.get(cacheKey(sym, intv)),
    [cacheKey],
  );

  const getCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) =>
      chartDataCacheRef.current.get(cacheKey(sym, intv, cacheMarketType, cacheExchange)),
    [cacheKey, exchange, marketType],
  );

  const setCache = useCallback(
    (sym, intv, data, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) => {
      chartDataCacheRef.current.set(cacheKey(sym, intv, cacheMarketType, cacheExchange), data);
    },
    [cacheKey, exchange, marketType],
  );

  const hasCache = useCallback(
    (sym, intv, { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange } = {}) =>
      chartDataCacheRef.current.has(cacheKey(sym, intv, cacheMarketType, cacheExchange)),
    [cacheKey, exchange, marketType],
  );

  const clearCache = useCallback(() => {
    chartDataCacheRef.current.clear();
  }, []);

  const mergeCacheData = useCallback(
    (sym, intv, incoming, options = {}) => {
      if (!incoming?.length) return getCache(sym, intv, options);
      const existing = getCache(sym, intv, options);
      const merged = existing && existing.length > 0 ? mergeByTime(incoming, existing) : incoming;
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
  }, [cacheKey]);

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
    const merged = mergeByTime(incoming, chartDataRef.current);
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
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
  };
}
