import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  acquireCacheLease,
  klineDependencyKey,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { recordFrontendCacheAccess } from "../cache-gc/cacheAccessRuntime.js";
import { validateChartCacheGcVictim } from "../cache-gc/chartCacheGcSafety.js";
import type { GcVictim } from "../cache-gc/cacheGcTypes.js";
import { markPerfOnce, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import { assertWindowBudget } from "../../runtime/performance/windowBudgetAssert.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { CommitChartData, PendingInitialSeries, WindowDelta } from "./klineContracts.js";
import { IndicatorWindowCommitBuffer } from "./indicatorWindowCommitBuffer.js";
import type {
  CachedChartDataActivation,
  EpochSeconds,
  KlineBar,
  SeriesKey,
} from "./marketDataTypes.js";
import {
  deferredWarmChartPublicationStillOwnsTarget,
  inheritChartHistoryProof,
  pendingWarmPublicationMatchesCommit,
  resolvePatchedChartDataStatus,
  seriesCommitOwnsActiveChart,
  shouldDeferWarmChartPublication,
} from "./chartDataRuntime.js";
import { MAX_SERIES_BARS } from "./phase1WindowPolicy.js";
import { WINDOW_DELTA_TYPES } from "./window/windowDeltas.js";
import type { SeriesWindowStore } from "./window/seriesWindowStore.js";
import {
  buildSeriesWindowKey,
  createDetachedSeriesWindowStore,
  SeriesWindowRegistry,
} from "./window/windowRegistry.js";

const KLINE_ROW_ESTIMATED_BYTES = 200;
const SERIES_STORE_GC_GENERATIONS = new WeakMap<SeriesWindowStore, number>();
let nextSeriesStoreGcGeneration = 1;

function seriesStoreGcGeneration(store: SeriesWindowStore): number {
  const existing = SERIES_STORE_GC_GENERATIONS.get(store);
  if (existing != null) return existing;
  const generation = nextSeriesStoreGcGeneration;
  nextSeriesStoreGcGeneration += 1;
  SERIES_STORE_GC_GENERATIONS.set(store, generation);
  return generation;
}

export type ChartDataStatus = "idle" | "loading" | "provisional" | "ready" | string;

export interface ChartDataCommitMeta extends Record<string, unknown> {
  version: number;
  status: ChartDataStatus;
  source: string;
  seriesKey?: SeriesKey | null;
  symbol?: SymbolCode;
  interval?: IntervalString;
  bars?: number;
  firstTime?: EpochSeconds | null;
  lastTime?: EpochSeconds | null;
  coverage?: { from: EpochSeconds | null; to: EpochSeconds | null; bars: number } | null;
  committedAt: number | null;
  targetSeriesKey?: SeriesKey;
  targetSymbol?: SymbolCode;
  targetInterval?: IntervalString;
  optimistic?: boolean;
  trimmedLeft?: number;
  trimmedRight?: number;
  windowDeltaType?: string;
  incomingFirstTime?: EpochSeconds | null;
  incomingLastTime?: EpochSeconds | null;
  changedRanges?: WindowDelta["changedRanges"];
  dataRevision?: unknown;
  indicatorWindowDeferred?: boolean;
  historyComplete?: boolean;
  historyRepairPending?: boolean;
  historyValidatedCountBack?: number | null;
  lastValidatedMs?: number | null;
}

interface CommitMetaExtra extends Record<string, unknown> {
  status?: ChartDataStatus;
  provisional?: boolean;
  originalBars?: number;
  trimmedLeft?: number;
  trimmedRight?: number;
}

interface CacheIdentityOptions {
  marketType?: MarketType;
  exchange?: ExchangeId;
}

interface GetStoreOptions extends CacheIdentityOptions {
  meta?: Record<string, unknown>;
}

interface RegisterStoreOptions extends CacheIdentityOptions {
  symbol: SymbolCode;
  interval: IntervalString;
  source: string;
}

interface RecordCacheAccessInput extends RegisterStoreOptions {
  key: string;
  action: string;
}

interface ReplaceChartDataOptions {
  cache?: boolean;
  source?: string;
}

interface ActivateCachedChartDataOptions {
  source?: string;
}

interface PendingWarmChartPublication {
  key: SeriesKey;
  store: SeriesWindowStore;
  timer: ReturnType<typeof setTimeout>;
  transitionVersion: number;
}

interface MergeChartDataOptions {
  deferIndicatorWindow?: boolean;
  historyComplete?: boolean;
  historyRepairPending?: boolean;
  historyValidatedCountBack?: number | null;
  indicatorWindowOwner?: string;
  onMerged?: (rows: KlineBar[]) => void;
  source?: string;
}

interface PatchChartDataOptions {
  seedIfEmpty?: boolean;
  source?: string;
}

interface UseChartDataRuntimeOptions {
  exchange: ExchangeId;
  marketType: MarketType;
  symbol: SymbolCode;
  interval: IntervalString;
  onIndicatorWindowMeta?: (meta: ChartDataCommitMeta) => void;
  windowRegistry?: SeriesWindowRegistry | null;
}

export interface ChartDataRuntime {
  chartData: KlineBar[];
  chartDataMeta: ChartDataCommitMeta;
  activeSeriesStore: SeriesWindowStore | null;
  pendingInitialHistoryRef: MutableRefObject<PendingInitialSeries | null>;
  cacheKey(symbol: SymbolCode, interval: IntervalString, marketType?: MarketType, exchange?: ExchangeId): SeriesKey;
  getFromCache(symbol: SymbolCode, interval: IntervalString): KlineBar[];
  getCache(symbol: SymbolCode, interval: IntervalString, options?: CacheIdentityOptions): KlineBar[] | undefined;
  setCache(symbol: SymbolCode, interval: IntervalString, rows: KlineBar[], options?: CacheIdentityOptions): KlineBar[];
  hasCache(symbol: SymbolCode, interval: IntervalString, options?: CacheIdentityOptions): boolean;
  getCacheDiagnostics(): Record<string, unknown>;
  trimCacheEntries(victims?: GcVictim[]): Record<string, unknown>;
  mergeCacheData(symbol: SymbolCode, interval: IntervalString, rows: KlineBar[], options?: CacheIdentityOptions): KlineBar[] | undefined;
  patchCacheTick(symbol: SymbolCode, interval: IntervalString, row: KlineBar, options?: CacheIdentityOptions): KlineBar[] | undefined;
  activateCachedChartData(symbol: SymbolCode, interval: IntervalString, options?: ActivateCachedChartDataOptions): CachedChartDataActivation | null;
  detachActiveChartData(symbol: SymbolCode, interval: IntervalString, source?: string): void;
  replaceChartData(symbol: SymbolCode, interval: IntervalString, rows: KlineBar[], options?: ReplaceChartDataOptions): void;
  clearChartData(source?: string, symbol?: SymbolCode, interval?: IntervalString): void;
  markChartDataTransition(symbol: SymbolCode, interval: IntervalString, source?: string): void;
  commitMergedChartData: CommitChartData;
  commitPatchedChartData: CommitChartData;
}

function inferCommitStatus(
  source: string,
  data: readonly KlineBar[],
  extra: CommitMetaExtra = {},
): ChartDataStatus {
  if (extra.status) return extra.status;
  if (!data?.length) {
    return source?.includes("load-start") ? "loading" : "idle";
  }
  if (extra.provisional || source?.includes("latest")) return "provisional";
  if (source?.includes("clear")) return "loading";
  return "ready";
}

function finiteTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolveHistoryProofUpdate(
  {
    historyComplete,
    historyRepairPending,
    historyValidatedCountBack,
  }: {
    historyComplete: boolean | undefined;
    historyRepairPending: boolean | undefined;
    historyValidatedCountBack: number | null | undefined;
  },
  nowMs = Date.now(),
): { patch: Record<string, unknown>; commit: CommitMetaExtra } | null {
  if (
    historyComplete === undefined
    && historyRepairPending === undefined
    && historyValidatedCountBack === undefined
  ) return null;

  const patch: Record<string, unknown> = {};
  if (historyComplete !== undefined) patch.historyComplete = historyComplete === true;
  if (historyRepairPending !== undefined) {
    patch.historyRepairPending = historyRepairPending === true;
  }
  if (historyComplete === true) {
    const parsedCountBack = Number(historyValidatedCountBack);
    patch.historyValidatedCountBack = Number.isSafeInteger(parsedCountBack) && parsedCountBack >= 0
      ? parsedCountBack
      : null;
    patch.lastValidatedMs = nowMs;
  } else if (historyComplete === false) {
    patch.historyValidatedCountBack = null;
    patch.lastValidatedMs = null;
  } else if (historyValidatedCountBack !== undefined) {
    const parsedCountBack = Number(historyValidatedCountBack);
    patch.historyValidatedCountBack = Number.isSafeInteger(parsedCountBack) && parsedCountBack >= 0
      ? parsedCountBack
      : null;
  }

  const status = historyComplete === true && historyRepairPending !== true
    ? "ready"
    : historyComplete === false || historyRepairPending === true
      ? "loading"
      : undefined;
  return {
    patch,
    commit: {
      ...patch,
      ...(status === undefined ? {} : { status }),
    },
  };
}

export function useChartDataRuntime({
  exchange,
  marketType,
  symbol,
  interval,
  onIndicatorWindowMeta,
  windowRegistry: configuredWindowRegistry,
}: UseChartDataRuntimeOptions): ChartDataRuntime {
  const [chartData, setChartData] = useState<KlineBar[]>([]);
  const chartDataRef = useRef<KlineBar[]>([]);
  const [chartDataMeta, setChartDataMeta] = useState<ChartDataCommitMeta>({
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
  const [activeSeriesStore, setActiveSeriesStore] = useState<SeriesWindowStore | null>(null);
  const windowRegistryRef = useRef<SeriesWindowRegistry | null>(null);
  if (windowRegistryRef.current == null) {
    windowRegistryRef.current = new SeriesWindowRegistry({ maxBars: MAX_SERIES_BARS });
  }
  const windowRegistry = configuredWindowRegistry || windowRegistryRef.current;
  const chartDataVersionRef = useRef(0);
  const chartDataCommitMetaRef = useRef<ChartDataCommitMeta | null>(null);
  const pendingInitialHistoryRef = useRef<PendingInitialSeries | null>(null);
  const indicatorWindowCommitBufferRef = useRef(new IndicatorWindowCommitBuffer());
  const pendingWarmPublicationRef = useRef<PendingWarmChartPublication | null>(null);

  const cacheKey = useCallback(
    (sym: SymbolCode, intv: IntervalString, mt = marketType, ex = exchange) => buildSeriesWindowKey({
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
    }),
    [exchange, marketType],
  );
  const activeSeriesKeyRef = useRef<SeriesKey>(cacheKey(symbol, interval));
  useLayoutEffect(() => {
    activeSeriesKeyRef.current = cacheKey(symbol, interval);
  }, [cacheKey, interval, symbol]);
  const ownsActiveChart = useCallback((key: string) => (
    seriesCommitOwnsActiveChart(key, activeSeriesKeyRef.current)
  ), []);
  const cancelPendingWarmPublication = useCallback(() => {
    const pending = pendingWarmPublicationRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingWarmPublicationRef.current = null;
  }, []);
  const flushPendingWarmPublicationBeforeCommit = useCallback((
    key: SeriesKey,
    store: SeriesWindowStore,
    rows: KlineBar[],
  ) => {
    const pending = pendingWarmPublicationRef.current;
    if (!pendingWarmPublicationMatchesCommit({
      activeSeriesKey: activeSeriesKeyRef.current,
      pendingSeriesKey: pending?.key ?? null,
      pendingStore: pending?.store,
      targetSeriesKey: key,
      targetStore: store,
    })) return false;
    cancelPendingWarmPublication();
    chartDataRef.current = rows;
    setActiveSeriesStore(store);
    setChartData(rows);
    recordPerfEvent("chart.data.warmPublication.flushedBeforeCommit", {
      datasetKey: key,
      storeVersion: store.version,
    });
    return true;
  }, [cancelPendingWarmPublication]);
  useEffect(() => () => cancelPendingWarmPublication(), [cancelPendingWarmPublication]);

  const dependencyKeyFor = useCallback(
    (sym: SymbolCode, intv: IntervalString, mt = marketType, ex = exchange) => klineDependencyKey({
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
    }),
    [exchange, marketType],
  );

  const describeRows = useCallback((rows: readonly KlineBar[] | null | undefined) => {
    const list = rows || [];
    const lastIndex = list.length - 1;
    return {
      bars: list.length,
      firstTime: list[0]?.time ?? null,
      lastTime: lastIndex >= 0 ? list[lastIndex]?.time ?? null : null,
      estimatedBytes: list.length * KLINE_ROW_ESTIMATED_BYTES,
    };
  }, []);

  const touchCacheMeta = useCallback((key: string, patch: Record<string, unknown> = {}) => {
    windowRegistry.touchMeta(key, patch);
  }, [windowRegistry]);

  const getStore = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    {
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      meta = {},
    }: GetStoreOptions = {},
  ) => {
    const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
    return windowRegistry.getOrCreate(key, {
      intervalSeconds: parseIntervalSeconds(intv),
      meta: {
        symbol: sym,
        interval: intv,
        marketType: cacheMarketType,
        exchange: cacheExchange,
        ...meta,
      },
    });
  }, [cacheKey, exchange, marketType, windowRegistry]);

  const findStore = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    {
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
    }: CacheIdentityOptions = {},
  ) => windowRegistry.get(cacheKey(sym, intv, cacheMarketType, cacheExchange)), [
    cacheKey,
    exchange,
    marketType,
    windowRegistry,
  ]);

  const registerStoreResource = useCallback((
    key: string,
    store: SeriesWindowStore,
    {
      symbol: cacheSymbol,
      interval: cacheInterval,
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      source,
    }: RegisterStoreOptions,
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
  }: RecordCacheAccessInput) => {
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
    sym: SymbolCode,
    intv: IntervalString,
    data: KlineBar[],
    {
      marketType: cacheMarketType = marketType,
      exchange: cacheExchange = exchange,
      source = "chart-commit",
    }: CacheIdentityOptions & { source?: string } = {},
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
      historyComplete: false,
      historyRepairPending: false,
      historyValidatedCountBack: null,
      lastValidatedMs: null,
      lastTailUpdatedMs: null,
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
    (
      sym: SymbolCode,
      intv: IntervalString,
      { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange }: CacheIdentityOptions = {},
    ) => {
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const store = findStore(sym, intv, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
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
    [cacheKey, exchange, findStore, marketType, recordCacheAccess, touchCacheMeta],
  );

  const getFromCache = useCallback(
    (sym: SymbolCode, intv: IntervalString) => getCache(sym, intv) || [],
    [getCache],
  );

  const setCache = useCallback(
    (
      sym: SymbolCode,
      intv: IntervalString,
      data: KlineBar[],
      { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange }: CacheIdentityOptions = {},
    ) =>
      saveToCache(sym, intv, data, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
        source: "cache-set",
      }),
    [exchange, marketType, saveToCache],
  );

  const hasCache = useCallback(
    (
      sym: SymbolCode,
      intv: IntervalString,
      { marketType: cacheMarketType = marketType, exchange: cacheExchange = exchange }: CacheIdentityOptions = {},
    ) => windowRegistry.has(cacheKey(sym, intv, cacheMarketType, cacheExchange)),
    [cacheKey, exchange, marketType, windowRegistry],
  );

  const mergeCacheData = useCallback(
    (
      sym: SymbolCode,
      intv: IntervalString,
      incoming: KlineBar[],
      options: CacheIdentityOptions = {},
    ) => {
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
    (
      sym: SymbolCode,
      intv: IntervalString,
      tick: KlineBar,
      options: CacheIdentityOptions = {},
    ) => {
      const cacheMarketType = options.marketType ?? marketType;
      const cacheExchange = options.exchange ?? exchange;
      const key = cacheKey(sym, intv, cacheMarketType, cacheExchange);
      const store = findStore(sym, intv, {
        marketType: cacheMarketType,
        exchange: cacheExchange,
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
        lastTailUpdatedMs: Date.now(),
        source: "cache-tick",
        trimmedLeft: delta.trimmedLeft || 0,
      });
      return rows;
    },
    [cacheKey, exchange, findStore, marketType, registerStoreResource, touchCacheMeta],
  );

  const recordChartDataCommit = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    data: KlineBar[],
    source: string,
    extra: CommitMetaExtra = {},
  ) => {
    const seriesKey = cacheKey(sym, intv);
    if (!ownsActiveChart(seriesKey)) return chartDataVersionRef.current;
    const version = chartDataVersionRef.current + 1;
    const { status: _extraStatus, ...metaExtra } = extra;
    const lastIndex = data?.length ? data.length - 1 : -1;
    const firstTime = data?.[0]?.time ?? null;
    const lastTime = lastIndex >= 0 ? data[lastIndex]?.time ?? null : null;
    const bars = data?.length || 0;
    const status = inferCommitStatus(source, data, extra);
    const store = windowRegistry.get(seriesKey);
    const historyProof = inheritChartHistoryProof(
      store ? windowRegistry.meta(seriesKey) : null,
      metaExtra,
    );
    chartDataVersionRef.current = version;
    const commitMeta: ChartDataCommitMeta = {
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
      ...historyProof,
      // A realtime/chart commit can land between a partial history commit and
      // its settled probe. Keep the pending marker sticky for that exact
      // series so WS corrections cannot flush against an incomplete window.
      indicatorWindowDeferred: metaExtra.indicatorWindowDeferred === true
        || indicatorWindowCommitBufferRef.current.hasPending(seriesKey),
    };
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
    if (commitMeta.indicatorWindowDeferred !== true) {
      onIndicatorWindowMeta?.(commitMeta);
    }
    setChartDataMeta(commitMeta);
    recordPerfEvent("chart.data.commit", {
      source,
      status,
      datasetKey: seriesKey,
      symbol: sym,
      interval: intv,
      bars,
      firstTime,
      lastTime,
    });
    if ((metaExtra.trimmedLeft || 0) > 0 || (metaExtra.trimmedRight || 0) > 0) {
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
  }, [cacheKey, exchange, marketType, onIndicatorWindowMeta, ownsActiveChart, registerStoreResource, windowRegistry]);

  const markChartDataTransition = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    source = "session-transition",
  ) => {
    const targetKey = cacheKey(sym, intv);
    if (!ownsActiveChart(targetKey)) return;
    cancelPendingWarmPublication();
    const previous = chartDataCommitMetaRef.current;
    if (previous?.seriesKey) {
      indicatorWindowCommitBufferRef.current.discard(previous.seriesKey);
    }
    indicatorWindowCommitBufferRef.current.discard(targetKey);
    const version = chartDataVersionRef.current + 1;
    chartDataVersionRef.current = version;
    const transitionMeta = {
      ...(previous || {}),
      version,
      status: "loading",
      source,
      targetSeriesKey: targetKey,
      targetSymbol: sym,
      targetInterval: intv,
      committedAt: Date.now(),
      optimistic: true,
      // The retained bars may belong to the prior series, but deferred history
      // ownership never does. A session transition cancels it explicitly.
      indicatorWindowDeferred: false,
    };
    chartDataCommitMetaRef.current = transitionMeta;
    setChartDataMeta(transitionMeta);
    recordPerfEvent("chart.data.transition", {
      source,
      symbol: sym,
      interval: intv,
      retainedBars: chartDataRef.current.length,
    });
  }, [cacheKey, cancelPendingWarmPublication, ownsActiveChart]);

  const getCacheDiagnostics = useCallback(() => {
    const activeKey = cacheKey(symbol, interval);
    const entries = windowRegistry.entries().map(({ key, store, meta }) => {
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
        lastAccessMs: meta.lastAccessMs ?? null,
        lastUpdatedMs: meta.lastUpdatedMs ?? null,
        lastTailUpdatedMs: meta.lastTailUpdatedMs ?? null,
        lastValidatedMs: meta.lastValidatedMs ?? null,
        historyComplete: meta.historyComplete === true,
        historyRepairPending: meta.historyRepairPending === true,
        historyValidatedCountBack: meta.historyValidatedCountBack ?? null,
        rightTruncated: store.rightTruncated,
        coverageGaps: store.coverage().gaps.length,
        generation: seriesStoreGcGeneration(store),
        revision: Number(store.version),
        metaRevision: Number(meta.metaRevision),
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
  }, [cacheKey, describeRows, exchange, interval, marketType, symbol, windowRegistry]);

  const trimCacheEntries = useCallback((victims: GcVictim[] = []) => {
    const activeKey = cacheKey(symbol, interval);
    const byKey = new Map<string, GcVictim>();
    for (const victim of victims) {
      if (typeof victim?.key === "string" && victim.key) byKey.set(victim.key, victim);
    }
    const removed: Array<{
      owner: string;
      key: string;
      bars: number;
      firstTime: EpochSeconds | null;
      lastTime: EpochSeconds | null;
      estimatedBytes: number;
    }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const [key, victim] of byKey.entries()) {
      const store = windowRegistry.get(key);
      if (!store) {
        skipped.push({ key, reason: "entry-missing" });
        continue;
      }
      const meta = windowRegistry.meta(key);
      const stats = describeRows(store.snapshot());
      const validation = validateChartCacheGcVictim(victim, {
        key,
        activeKey,
        generation: seriesStoreGcGeneration(store),
        revision: Number(store.version),
        metaRevision: Number(meta.metaRevision),
        lastAccessMs: typeof meta.lastAccessMs === "number" ? meta.lastAccessMs : null,
        lastUpdatedMs: typeof meta.lastUpdatedMs === "number" ? meta.lastUpdatedMs : null,
        bars: stats.bars,
        estimatedBytes: stats.estimatedBytes,
      });
      if (!validation.allowed) {
        skipped.push({ key, reason: validation.reason });
        continue;
      }
      const evicted = windowRegistry.evict(key);
      if (!evicted) continue;
      indicatorWindowCommitBufferRef.current.discard(key);
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
      skipped,
    };
  }, [cacheKey, describeRows, interval, symbol, windowRegistry]);

  useEffect(() => {
    const release = acquireCacheLease("chart-data-cache", cacheKey(symbol, interval), "active-chart", {
      dependencyKey: dependencyKeyFor(symbol, interval),
      symbol,
      interval,
      exchange,
      marketType,
    });
    return release || undefined;
  }, [cacheKey, dependencyKeyFor, exchange, interval, marketType, symbol]);

  const activateCachedChartData = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    { source = "memory-cache-hit" }: ActivateCachedChartDataOptions = {},
  ): CachedChartDataActivation | null => {
    const key = cacheKey(sym, intv);
    if (!ownsActiveChart(key)) return null;
    const activation = windowRegistry.activate(key);
    if (!activation) return null;
    const { rows: next, store } = activation;
    const meta = windowRegistry.meta(key);
    const historyComplete = meta.historyComplete === true;
    const historyRepairPending = meta.historyRepairPending === true;
    const parsedValidatedCountBack = Number(meta.historyValidatedCountBack);
    const historyValidatedCountBack = Number.isSafeInteger(parsedValidatedCountBack)
      && parsedValidatedCountBack >= 0
      ? parsedValidatedCountBack
      : null;
    const lastTailUpdatedMs = finiteTimestamp(meta.lastTailUpdatedMs);
    const lastValidatedMs = finiteTimestamp(meta.lastValidatedMs);
    const coverage = store.coverage();

    indicatorWindowCommitBufferRef.current.discard(key);
    recordCacheAccess({
      key,
      symbol: sym,
      interval: intv,
      action: "chart-switch",
      source,
    });
    registerStoreResource(key, store, { symbol: sym, interval: intv, source });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      source,
    });
    const publish = (rows: KlineBar[]) => {
      const publicationMeta = windowRegistry.meta(key);
      const publicationHistoryComplete = publicationMeta.historyComplete === true;
      const publicationRepairPending = publicationMeta.historyRepairPending === true;
      const parsedPublicationCountBack = Number(publicationMeta.historyValidatedCountBack);
      const publicationCountBack = Number.isSafeInteger(parsedPublicationCountBack)
        && parsedPublicationCountBack >= 0
        ? parsedPublicationCountBack
        : null;
      chartDataRef.current = rows;
      recordChartDataCommit(sym, intv, rows, source, {
        status: publicationHistoryComplete && !publicationRepairPending ? "ready" : "loading",
        dataRevision: store.version,
        historyComplete: publicationHistoryComplete,
        historyRepairPending: publicationRepairPending,
        historyValidatedCountBack: publicationCountBack,
        lastValidatedMs: finiteTimestamp(publicationMeta.lastValidatedMs),
      });
      setActiveSeriesStore(store);
      setChartData(rows);
    };

    const transitionMeta = chartDataCommitMetaRef.current;
    const previousInterval = transitionMeta?.interval;
    const expectedPreviousSeriesKey = transitionMeta?.symbol === sym
      && typeof previousInterval === "string"
      ? cacheKey(sym, previousInterval as IntervalString)
      : null;
    const transitionVersion = Number(transitionMeta?.version);
    const deferPublication = Number.isSafeInteger(transitionVersion)
      && shouldDeferWarmChartPublication({
        currentMeta: transitionMeta,
        expectedPreviousSeriesKey,
        historyComplete,
        historyRepairPending,
        source,
        targetInterval: intv,
        targetSeriesKey: key,
        targetSymbol: sym,
      });
    cancelPendingWarmPublication();
    if (deferPublication) {
      const timer = setTimeout(() => {
        const pending = pendingWarmPublicationRef.current;
        if (!pending || pending.timer !== timer) return;
        pendingWarmPublicationRef.current = null;
        if (!deferredWarmChartPublicationStillOwnsTarget({
          activeSeriesKey: activeSeriesKeyRef.current,
          currentMeta: chartDataCommitMetaRef.current,
          registeredStore: windowRegistry.get(key),
          targetSeriesKey: key,
          targetStore: store,
          transitionVersion,
        })) {
          recordPerfEvent("chart.data.warmPublication.skipped", {
            datasetKey: key,
            interval: intv,
            symbol: sym,
          });
          return;
        }
        publish(store.snapshot());
      }, 0);
      pendingWarmPublicationRef.current = {
        key,
        store,
        timer,
        transitionVersion,
      };
      recordPerfEvent("chart.data.warmPublication.deferred", {
        datasetKey: key,
        interval: intv,
        symbol: sym,
        transitionVersion,
      });
    } else {
      publish(next);
    }
    return {
      coverage,
      historyComplete,
      historyRepairPending,
      historyValidatedCountBack,
      lastTailUpdatedMs,
      lastValidatedMs,
      revision: store.version,
      rightTruncated: store.rightTruncated,
      rows: next,
    };
  }, [
    cacheKey,
    cancelPendingWarmPublication,
    exchange,
    marketType,
    ownsActiveChart,
    recordCacheAccess,
    recordChartDataCommit,
    registerStoreResource,
    touchCacheMeta,
    windowRegistry,
  ]);

  const detachActiveChartData = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    source = "session-transition-detach",
  ) => {
    const key = cacheKey(sym, intv);
    if (!ownsActiveChart(key)) return;
    cancelPendingWarmPublication();
    // Display-only empty owner: never register it and never mutate either the
    // previous or target warm cache while clearing a cold transition frame.
    const detachedStore = createDetachedSeriesWindowStore(key, {
      maxBars: MAX_SERIES_BARS,
      intervalSeconds: parseIntervalSeconds(intv),
    });
    chartDataRef.current = [];
    setActiveSeriesStore(detachedStore);
    setChartData([]);
    recordPerfEvent("chart.data.detach", {
      source,
      symbol: sym,
      interval: intv,
    });
  }, [cacheKey, cancelPendingWarmPublication, ownsActiveChart]);

  const replaceChartData = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    data: KlineBar[],
    { cache = false, source = "replace" }: ReplaceChartDataOptions = {},
  ) => {
    const key = cacheKey(sym, intv);
    indicatorWindowCommitBufferRef.current.discard(key);
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
      historyComplete: false,
      historyRepairPending: false,
      historyValidatedCountBack: null,
      lastValidatedMs: null,
      lastTailUpdatedMs: null,
      source,
      trimmedLeft: delta.trimmedLeft || 0,
    });
    if (!ownsActiveChart(key)) return;
    chartDataRef.current = next;
    recordChartDataCommit(sym, intv, next, source, {
      ...(cache ? { status: "ready" } : {}),
      ...(delta.originalBars === undefined ? {} : { originalBars: delta.originalBars }),
      ...(delta.trimmedLeft === undefined ? {} : { trimmedLeft: delta.trimmedLeft }),
      ...(delta.trimmedRight === undefined ? {} : { trimmedRight: delta.trimmedRight }),
    });
    setActiveSeriesStore(store);
    setChartData(next);
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    ownsActiveChart,
    recordCacheAccess,
    recordChartDataCommit,
    touchCacheMeta,
  ]);

  const clearChartData = useCallback((
    source = "clear",
    sym: SymbolCode = symbol,
    intv: IntervalString = interval,
  ) => {
    const key = cacheKey(sym, intv);
    if (!ownsActiveChart(key)) return;
    indicatorWindowCommitBufferRef.current.discard(key);
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
      historyComplete: false,
      historyRepairPending: false,
      historyValidatedCountBack: null,
      lastValidatedMs: null,
      lastTailUpdatedMs: null,
      source,
    });
    recordChartDataCommit(sym, intv, [], source);
    setChartData([]);
  }, [cacheKey, exchange, getStore, interval, marketType, ownsActiveChart, recordChartDataCommit, symbol, touchCacheMeta]);

  const commitMergedChartData = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    incoming: KlineBar[],
    {
      deferIndicatorWindow = false,
      historyComplete,
      historyRepairPending,
      historyValidatedCountBack,
      indicatorWindowOwner,
      onMerged,
      source = "merge",
    }: MergeChartDataOptions = {},
  ) => {
    const key = cacheKey(sym, intv);
    const store = getStore(sym, intv, { meta: { source } });
    const historyProofUpdate = resolveHistoryProofUpdate({
      historyComplete,
      historyRepairPending,
      historyValidatedCountBack,
    });
    const touchHistoryProof = () => {
      if (!historyProofUpdate) return;
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        source,
        ...historyProofUpdate.patch,
      });
    };
    if (!incoming?.length) {
      const indicatorWindowCommit = indicatorWindowCommitBufferRef.current.record(key, [], {
        ownerToken: indicatorWindowOwner,
        pending: deferIndicatorWindow,
      });
      touchHistoryProof();
      if (
        historyProofUpdate
        || indicatorWindowCommit.lifecycleChanged
        || indicatorWindowCommit.publish
      ) {
        const next = store.snapshot();
        flushPendingWarmPublicationBeforeCommit(key, store, next);
        recordChartDataCommit(sym, intv, next, source, {
          status: "ready",
          ...(historyProofUpdate?.commit || {}),
          ...(indicatorWindowCommit.ranges.length > 0
            ? { windowDeltaType: WINDOW_DELTA_TYPES.MID_MERGE }
            : {}),
          changedRanges: indicatorWindowCommit.ranges,
          indicatorWindowDeferred: indicatorWindowCommit.deferred,
        });
      }
      return;
    }
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
      const indicatorWindowCommit = indicatorWindowCommitBufferRef.current.record(key, [], {
        ownerToken: indicatorWindowOwner,
        pending: deferIndicatorWindow,
      });
      touchHistoryProof();
      if (
        historyProofUpdate
        || indicatorWindowCommit.lifecycleChanged
        || indicatorWindowCommit.publish
      ) {
        flushPendingWarmPublicationBeforeCommit(key, store, next);
        recordChartDataCommit(sym, intv, next, source, {
          status: "ready",
          ...(historyProofUpdate?.commit || {}),
          ...(indicatorWindowCommit.ranges.length > 0
            ? { windowDeltaType: WINDOW_DELTA_TYPES.MID_MERGE }
            : {}),
          changedRanges: indicatorWindowCommit.ranges,
          indicatorWindowDeferred: indicatorWindowCommit.deferred,
        });
      }
      if (onMerged) onMerged(next);
      return;
    }
    const indicatorWindowCommit = indicatorWindowCommitBufferRef.current.record(
      key,
      delta.changedRanges,
      {
        ownerToken: indicatorWindowOwner,
        pending: deferIndicatorWindow,
      },
    );
    registerStoreResource(key, store, { symbol: sym, interval: intv, source });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      ...(historyProofUpdate?.patch || {}),
      source,
      trimmedLeft: delta.trimmedLeft || 0,
    });
    if (ownsActiveChart(key)) {
      chartDataRef.current = next;
      setActiveSeriesStore(store);
      recordChartDataCommit(sym, intv, next, source, {
        incomingBars: incoming.length,
        incomingFirstTime: incoming[0]?.time ?? null,
        incomingLastTime: incoming[incoming.length - 1]?.time ?? null,
        status: "ready",
        ...(historyProofUpdate?.commit || {}),
        ...(delta.originalBars === undefined ? {} : { originalBars: delta.originalBars }),
        ...(delta.trimmedLeft === undefined ? {} : { trimmedLeft: delta.trimmedLeft }),
        ...(delta.trimmedRight === undefined ? {} : { trimmedRight: delta.trimmedRight }),
        windowDeltaType: delta.type,
        addedLeft: delta.addedLeft || 0,
        addedRight: delta.addedRight || 0,
        changedRanges: indicatorWindowCommit.ranges,
        indicatorWindowDeferred: indicatorWindowCommit.deferred,
      });
      setChartData(next);
    }
    if (onMerged) onMerged(next);
  }, [
    cacheKey,
    exchange,
    flushPendingWarmPublicationBeforeCommit,
    getStore,
    marketType,
    ownsActiveChart,
    recordChartDataCommit,
    registerStoreResource,
    touchCacheMeta,
  ]);

  const commitPatchedChartData = useCallback((
    sym: SymbolCode,
    intv: IntervalString,
    ticks: KlineBar[],
    { seedIfEmpty = false, source = "patch" }: PatchChartDataOptions = {},
  ) => {
    if (!ticks?.length) return;
    const key = cacheKey(sym, intv);
    const publishToActiveChart = ownsActiveChart(key);
    const store = getStore(sym, intv, { meta: { source } });
    const prev = store.snapshot();

    if (store.isEmpty() && seedIfEmpty) {
      const delta = store.replace(ticks, { source });
      const nextSeeded = store.snapshot({ force: true });
      registerStoreResource(key, store, { symbol: sym, interval: intv, source });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        lastUpdatedMs: Date.now(),
        historyComplete: false,
        historyRepairPending: false,
        historyValidatedCountBack: null,
        lastValidatedMs: null,
        lastTailUpdatedMs: Date.now(),
        source,
        trimmedLeft: delta.trimmedLeft || 0,
      });
      if (publishToActiveChart) {
        chartDataRef.current = nextSeeded;
        recordChartDataCommit(sym, intv, nextSeeded, source, {
          incomingBars: ticks.length,
          provisional: source?.includes("latest"),
          seeded: true,
          ...(delta.originalBars === undefined ? {} : { originalBars: delta.originalBars }),
          ...(delta.trimmedLeft === undefined ? {} : { trimmedLeft: delta.trimmedLeft }),
          ...(delta.trimmedRight === undefined ? {} : { trimmedRight: delta.trimmedRight }),
        });
        setActiveSeriesStore(store);
        setChartData(nextSeeded);
      }
      return;
    }

    if (store.isEmpty()) return;

    if (ticks.length > 1) {
      const delta = store.applyRange(ticks, { source });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) return;

      const deferIndicatorWindow = indicatorWindowCommitBufferRef.current.hasPending(key);
      const indicatorWindowCommit = deferIndicatorWindow
        ? indicatorWindowCommitBufferRef.current.record(key, delta.changedRanges)
        : { ranges: delta.changedRanges || [] };

      const next = store.snapshot({ force: true });
      const patchedStatus = resolvePatchedChartDataStatus(
        source,
        publishToActiveChart && chartDataCommitMetaRef.current?.seriesKey === key
          ? chartDataCommitMetaRef.current.status
          : undefined,
      );
      registerStoreResource(key, store, { symbol: sym, interval: intv, source });
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        lastUpdatedMs: Date.now(),
        lastTailUpdatedMs: Date.now(),
        source,
        trimmedLeft: delta.trimmedLeft || 0,
      });
      if (publishToActiveChart) {
        chartDataRef.current = next;
        setActiveSeriesStore(store);
        recordChartDataCommit(sym, intv, next, source, {
          incomingBars: ticks.length,
          incomingFirstTime: ticks[0]?.time ?? null,
          incomingLastTime: ticks[ticks.length - 1]?.time ?? null,
          ...(patchedStatus === undefined ? {} : { status: patchedStatus }),
          seeded: false,
          ...(delta.originalBars === undefined ? {} : { originalBars: delta.originalBars }),
          ...(delta.trimmedLeft === undefined ? {} : { trimmedLeft: delta.trimmedLeft }),
          ...(delta.trimmedRight === undefined ? {} : { trimmedRight: delta.trimmedRight }),
          windowDeltaType: delta.type,
          addedLeft: delta.addedLeft || 0,
          addedRight: delta.addedRight || 0,
          changedRanges: indicatorWindowCommit.ranges,
          indicatorWindowDeferred: deferIndicatorWindow,
        });
        setChartData(next);
      }
      return;
    }

    let changed = false;
    let appended = false;
    let replaced = false;
    let structural = false;
    let trimmedLeft = 0;
    let trimmedRight = 0;
    const structuralChangedRanges: WindowDelta["changedRanges"] = [];
    for (const tick of ticks) {
      const delta = store.applyTick(tick, { source });
      if (delta.type === WINDOW_DELTA_TYPES.NOOP) continue;
      changed = true;
      structural = structural || delta.type !== WINDOW_DELTA_TYPES.TICK;
      appended = appended || Boolean(delta.appended);
      replaced = replaced || Boolean(delta.replaced);
      trimmedLeft += delta.trimmedLeft || 0;
      trimmedRight += delta.trimmedRight || 0;
      if (delta.type === WINDOW_DELTA_TYPES.MID_MERGE) {
        structuralChangedRanges.push({ start: tick.time, end: tick.time, type: "mid-merge" });
      }
    }
    if (!changed) return;

    if (!structural && !appended && replaced && trimmedLeft === 0 && trimmedRight === 0) {
      // Replace-last fast path: the store patched its snapshot in place, so
      // chartDataRef stays current without an O(N) rebuild or React commit.
      // It is still a real cache mutation. Keep the freshness watermark moving
      // so a continuously updated warm window is not mistaken for stale data
      // when the user switches away and immediately returns.
      touchCacheMeta(key, {
        symbol: sym,
        interval: intv,
        marketType,
        exchange,
        lastUpdatedMs: Date.now(),
        lastTailUpdatedMs: Date.now(),
        source,
      });
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
    const deferIndicatorWindow = indicatorWindowCommitBufferRef.current.hasPending(key);
    const indicatorWindowCommit = deferIndicatorWindow
      ? indicatorWindowCommitBufferRef.current.record(key, structuralChangedRanges)
      : { ranges: structuralChangedRanges };
    registerStoreResource(key, store, { symbol: sym, interval: intv, source });
    touchCacheMeta(key, {
      symbol: sym,
      interval: intv,
      marketType,
      exchange,
      lastUpdatedMs: Date.now(),
      lastTailUpdatedMs: Date.now(),
      source,
      trimmedLeft,
    });
    if (publishToActiveChart) {
      chartDataRef.current = next;
      setActiveSeriesStore(store);
      recordChartDataCommit(sym, intv, next, source, {
        incomingBars: ticks.length,
        incomingFirstTime: ticks[0]?.time ?? null,
        incomingLastTime: ticks[ticks.length - 1]?.time ?? null,
        ...(prev.length > 0 && chartDataCommitMetaRef.current?.status !== undefined
          ? { status: chartDataCommitMetaRef.current.status }
          : {}),
        seeded: false,
        originalBars: next.length + trimmedLeft + trimmedRight,
        trimmedLeft,
        trimmedRight,
        windowDeltaType: structural ? WINDOW_DELTA_TYPES.MID_MERGE : WINDOW_DELTA_TYPES.TICK,
        changedRanges: indicatorWindowCommit.ranges,
        indicatorWindowDeferred: deferIndicatorWindow,
      });
      setChartData(next);
    }
  }, [
    cacheKey,
    exchange,
    getStore,
    marketType,
    ownsActiveChart,
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
    getCacheDiagnostics,
    trimCacheEntries,
    mergeCacheData,
    patchCacheTick,
    activateCachedChartData,
    detachActiveChartData,
    replaceChartData,
    clearChartData,
    markChartDataTransition,
    commitMergedChartData,
    commitPatchedChartData,
  };
}
