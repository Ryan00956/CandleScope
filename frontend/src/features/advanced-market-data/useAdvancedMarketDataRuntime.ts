import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { buildSeriesWindowKey } from "../market-data/window/windowRegistry.js";
import {
  fetchAdvancedMarketHistory,
  fetchAdvancedMarketSnapshot,
  getAdvancedMarketStreamUrl,
} from "./advancedMarketDataApi.js";
import { advancedMarketDataStore } from "./advancedMarketDataStore.js";
import {
  clampHistoryRangeToNow,
  coverageForHistoryPage,
  mergeHistoryCoverage,
  nextUncoveredHistoryRange,
  type MarketHistoryRange,
} from "./marketHistoryCoverage.js";
import { MarketStreamController } from "./marketStreamController.js";
import { resolveOpenInterestPeriod } from "./metricPaneProjection.js";
import { resolveAdvancedMarketCapabilities } from "./advancedMarketCapabilities.js";
import { useMarketMetricSelection } from "./marketMetricSelectionStore.js";
import {
  buildAdvancedMarketIdentityKey,
  normalizeAdvancedMarketIdentity,
  type AdvancedMarketChannel,
  type AdvancedMarketConnectionStatus,
  type AdvancedMarketIdentity,
  type AdvancedMarketRuntime,
  type AdvancedMarketStudyView,
} from "./advancedMarketDataTypes.js";
import type {
  MarketMetricChannel,
  MarketMetricId,
} from "./marketMetricSelectionTypes.js";

interface UseAdvancedMarketDataRuntimeOptions {
  session: ChartSessionRuntime;
  dataMeta: ChartDataCommitMeta;
  seriesStore: SeriesWindowStore | null;
}

interface ActiveRuntimeContext {
  enabled: boolean;
  identity: AdvancedMarketIdentity;
  identityKey: string;
  interval: string;
  historyContextKey: string;
  metricChannels: readonly MarketMetricChannel[];
  requestedChannels: readonly AdvancedMarketChannel[];
  requestedChannelSignature: string;
  seriesReady: boolean;
}

interface OwnedConnectionState {
  identityKey: string;
  status: AdvancedMarketConnectionStatus;
}

interface OwnedStreamErrorState {
  identityKey: string;
  error: string | null;
}

interface OwnedHistoryErrorState {
  historyContextKey: string;
  errors: Partial<Record<MarketMetricChannel, string>>;
}

const MAX_HISTORY_PAGES_PER_LOAD = 8;
const HISTORY_RETRY_DELAY_MS = 30_000;
const HISTORY_CONTINUATION_DELAY_MS = 50;
const INITIAL_HISTORY_TAIL_BARS = 120;
const INITIAL_HISTORY_TAIL_DURATION_MS = 10 * 24 * 60 * 60 * 1000;
const EMPTY_HISTORY_ERRORS: Partial<Record<MarketMetricChannel, string>> = Object.freeze({});
const SUMMARY_CHANNELS: readonly AdvancedMarketChannel[] = [
  "mark_price",
  "index_price",
  "basis",
];
const MARKET_STUDY_CATALOG: Record<MarketMetricId, {
  name: string;
  description: string;
}> = {
  "market:funding-rate": {
    name: "资金费率 (Funding Rate)",
    description: "交易所结算、无前视历史估算与实时预估组成的资金费率轨迹，按百分比显示。",
  },
  "market:open-interest": {
    name: "未平仓量 (Open Interest)",
    description: "当前合约未平仓头寸规模，按交易所支持的采样周期显示。",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function supportsAdvancedMarketData(session: ChartSessionRuntime): boolean {
  return resolveAdvancedMarketCapabilities({
    marketType: session.view.marketType,
    raw: session.view.exchangeConfig.raw,
  }).summarySupported;
}

function parseVisibleTimeRange(range: unknown): MarketHistoryRange | null {
  if (!isRecord(range) || !isRecord(range.time)) return null;
  const from = Number(range.time.from);
  const to = Number(range.time.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return clampHistoryRangeToNow({
    startMs: Math.max(0, Math.floor(Math.min(from, to) * 1000)),
    endMs: Math.max(0, Math.ceil(Math.max(from, to) * 1000)),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function buildAdvancedMarketHistoryContextKey(
  identityKey: string,
  interval: string,
  channels: readonly MarketMetricChannel[],
): string {
  return `${identityKey}|${interval}|${channels.join("|")}`;
}

export function buildTailFirstHistoryRanges(
  requested: MarketHistoryRange,
  barTimesSeconds: readonly number[],
  tailBars: number = INITIAL_HISTORY_TAIL_BARS,
  maxTailDurationMs: number = INITIAL_HISTORY_TAIL_DURATION_MS,
): MarketHistoryRange[] {
  const startMs = Math.max(0, Math.floor(Math.min(requested.startMs, requested.endMs)));
  const endMs = Math.max(startMs, Math.ceil(Math.max(requested.startMs, requested.endMs)));
  const boundedTailBars = Math.max(1, Math.floor(tailBars));
  const tailIndex = Math.max(0, barTimesSeconds.length - boundedTailBars);
  const tailTime = Number(barTimesSeconds[tailIndex]);
  if (!Number.isFinite(tailTime)) return [{ startMs, endMs }];
  const durationFloorMs = endMs - Math.max(1, Math.floor(maxTailDurationMs));
  const tailStartMs = Math.max(
    startMs,
    Math.min(endMs, Math.max(Math.floor(tailTime * 1000), durationFloorMs)),
  );
  if (tailStartMs <= startMs) return [{ startMs, endMs }];
  return [
    { startMs: tailStartMs, endMs },
    { startMs, endMs: tailStartMs - 1 },
  ];
}

export interface AdvancedMarketHistoryRequestGuard {
  aborted: boolean;
  disposed: boolean;
  expectedGeneration: number;
  currentGeneration: number;
  expectedHistoryContextKey: string;
  currentHistoryContextKey: string;
  expectedIdentityKey: string;
  currentIdentityKey: string;
  expectedInterval: string;
  currentInterval: string;
  channel: MarketMetricChannel;
  period: string | null;
  currentMetricChannels: readonly MarketMetricChannel[];
  seriesReady: boolean;
}

export function isAdvancedMarketHistoryRequestCurrent({
  aborted,
  disposed,
  expectedGeneration,
  currentGeneration,
  expectedHistoryContextKey,
  currentHistoryContextKey,
  expectedIdentityKey,
  currentIdentityKey,
  expectedInterval,
  currentInterval,
  channel,
  period,
  currentMetricChannels,
  seriesReady,
}: AdvancedMarketHistoryRequestGuard): boolean {
  return !disposed
    && !aborted
    && currentGeneration === expectedGeneration
    && currentHistoryContextKey === expectedHistoryContextKey
    && currentIdentityKey === expectedIdentityKey
    && currentInterval === expectedInterval
    && seriesReady
    && currentMetricChannels.includes(channel)
    && (channel !== "open_interest" || resolveOpenInterestPeriod(currentInterval) === period);
}

export function useAdvancedMarketDataRuntime({
  session,
  dataMeta,
  seriesStore,
}: UseAdvancedMarketDataRuntimeOptions): AdvancedMarketRuntime {
  const identity = useMemo(() => normalizeAdvancedMarketIdentity({
    exchange: session.view.exchange,
    marketType: session.view.marketType,
    symbol: session.view.symbol,
  }), [session.view.exchange, session.view.marketType, session.view.symbol]);
  const identityKey = useMemo(() => buildAdvancedMarketIdentityKey(identity), [identity]);
  const interval = session.view.interval;
  const seriesKey = useMemo(() => String(buildSeriesWindowKey({
    exchange: identity.exchange,
    marketType: identity.marketType,
    symbol: identity.symbol,
    interval,
  })), [identity, interval]);
  const capabilitySnapshot = useMemo(() => resolveAdvancedMarketCapabilities({
    marketType: session.view.marketType,
    raw: session.view.exchangeConfig.raw,
  }), [session.view.exchangeConfig.raw, session.view.marketType]);
  const {
    selections: metricSelections,
    add: addMarketStudy,
    remove: removeMarketStudy,
    toggleVisibility: toggleMarketStudyVisibility,
  } = useMarketMetricSelection();
  const metricCapabilities = useMemo(() => ({
    funding_rate: {
      supported: capabilitySnapshot.channels.funding_rate.supported,
      reason: capabilitySnapshot.channels.funding_rate.reason,
    },
    open_interest: {
      supported: capabilitySnapshot.channels.open_interest.supported,
      reason: capabilitySnapshot.channels.open_interest.reason,
    },
  }), [capabilitySnapshot]);
  const activeMetricChannels = useMemo<MarketMetricChannel[]>(() => (
    metricSelections
      .filter((item) => (
        item.added
        && item.visible
        && metricCapabilities[item.channel].supported
      ))
      .map((item) => item.channel)
  ), [metricCapabilities, metricSelections]);
  const metricChannelSignature = activeMetricChannels.join("|");
  const summaryEnabled = capabilitySnapshot.summarySupported;
  const metricsEnabled = activeMetricChannels.length > 0;
  const requestedChannels = useMemo<AdvancedMarketChannel[]>(() => [
    ...(summaryEnabled ? SUMMARY_CHANNELS : []),
    ...activeMetricChannels,
  ], [activeMetricChannels, summaryEnabled]);
  const requestedChannelSignature = requestedChannels.join("|");
  const enabled = requestedChannels.length > 0;
  const historyContextKey = buildAdvancedMarketHistoryContextKey(
    identityKey,
    interval,
    activeMetricChannels,
  );
  const seriesReady = String(seriesStore?.seriesKey || "") === seriesKey
    && String(dataMeta.seriesKey || "") === seriesKey;
  const [retryToken, setRetryToken] = useState(0);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const [connectionState, setConnectionState] = useState<OwnedConnectionState>(() => ({
    identityKey,
    status: enabled ? "connecting" : "disabled",
  }));
  const [streamErrorState, setStreamErrorState] = useState<OwnedStreamErrorState>(() => ({
    identityKey,
    error: null,
  }));
  const [historyErrorState, setHistoryErrorState] = useState<OwnedHistoryErrorState>(() => ({
    historyContextKey,
    errors: {},
  }));
  const connectionStatus: AdvancedMarketConnectionStatus = !enabled
    ? "disabled"
    : connectionState.identityKey !== identityKey || connectionState.status === "disabled"
      ? "connecting"
      : connectionState.status;
  const streamError = enabled && streamErrorState.identityKey === identityKey
    ? streamErrorState.error
    : null;
  const historyErrors = historyErrorState.historyContextKey === historyContextKey
    ? historyErrorState.errors
    : EMPTY_HISTORY_ERRORS;
  const streamGenerationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const disposedRef = useRef(false);
  const activeRef = useRef<ActiveRuntimeContext>({
    enabled,
    identity,
    identityKey,
    interval,
    historyContextKey,
    metricChannels: activeMetricChannels,
    requestedChannels,
    requestedChannelSignature,
    seriesReady,
  });
  const historyAbortControllersRef = useRef(new Set<AbortController>());
  const inFlightRef = useRef(new Set<string>());
  const inFlightCoverageRef = useRef(new Map<string, MarketHistoryRange[]>());
  const coverageRef = useRef(new Map<string, MarketHistoryRange[]>());
  const coverageIdentityRef = useRef(identityKey);
  const historyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyContinuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<MarketStreamController | null>(null);

  // Publish only committed chart state. Layout effects run before passive
  // request effects, without leaking values from an abandoned concurrent render.
  useLayoutEffect(() => {
    activeRef.current = {
      enabled,
      identity,
      identityKey,
      interval,
      historyContextKey,
      metricChannels: activeMetricChannels,
      requestedChannels,
      requestedChannelSignature,
      seriesReady,
    };
  }, [
    activeMetricChannels,
    enabled,
    historyContextKey,
    identity,
    identityKey,
    interval,
    requestedChannels,
    requestedChannelSignature,
    seriesReady,
  ]);

  const clearHistoryRetryTimer = useCallback(() => {
    if (historyRetryTimerRef.current === null) return;
    clearTimeout(historyRetryTimerRef.current);
    historyRetryTimerRef.current = null;
  }, []);

  const clearHistoryContinuationTimer = useCallback(() => {
    if (historyContinuationTimerRef.current === null) return;
    clearTimeout(historyContinuationTimerRef.current);
    historyContinuationTimerRef.current = null;
  }, []);

  const invalidateHistoryRequests = useCallback((clearCoverage = false) => {
    historyGenerationRef.current += 1;
    for (const controller of historyAbortControllersRef.current) controller.abort();
    historyAbortControllersRef.current = new Set();
    inFlightRef.current = new Set();
    inFlightCoverageRef.current = new Map();
    clearHistoryRetryTimer();
    clearHistoryContinuationTimer();
    if (clearCoverage) coverageRef.current = new Map();
  }, [clearHistoryContinuationTimer, clearHistoryRetryTimer]);

  const scheduleHistoryRetry = useCallback((
    expectedHistoryContextKey: string,
    expectedHistoryGeneration: number,
  ) => {
    if (disposedRef.current
      || historyGenerationRef.current !== expectedHistoryGeneration
      || activeRef.current.historyContextKey !== expectedHistoryContextKey
      || historyRetryTimerRef.current !== null) return;
    historyRetryTimerRef.current = setTimeout(() => {
      historyRetryTimerRef.current = null;
      if (disposedRef.current
        || historyGenerationRef.current !== expectedHistoryGeneration
        || activeRef.current.historyContextKey !== expectedHistoryContextKey) return;
      setHistoryRetryToken((value) => value + 1);
    }, HISTORY_RETRY_DELAY_MS);
  }, []);

  const scheduleHistoryContinuation = useCallback((
    expectedHistoryContextKey: string,
    expectedHistoryGeneration: number,
  ) => {
    if (disposedRef.current
      || historyGenerationRef.current !== expectedHistoryGeneration
      || activeRef.current.historyContextKey !== expectedHistoryContextKey
      || historyContinuationTimerRef.current !== null) return;
    historyContinuationTimerRef.current = setTimeout(() => {
      historyContinuationTimerRef.current = null;
      if (disposedRef.current
        || historyGenerationRef.current !== expectedHistoryGeneration
        || activeRef.current.historyContextKey !== expectedHistoryContextKey) return;
      setHistoryRetryToken((value) => value + 1);
    }, HISTORY_CONTINUATION_DELAY_MS);
  }, []);

  useLayoutEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      streamGenerationRef.current += 1;
      invalidateHistoryRequests(true);
    };
  }, [invalidateHistoryRequests]);

  const loadHistory = useCallback((requested: MarketHistoryRange): boolean => {
    const context = activeRef.current;
    if (!context.enabled || !context.seriesReady || context.metricChannels.length === 0) {
      return false;
    }
    const inFlight = inFlightRef.current;
    const inFlightCoverage = inFlightCoverageRef.current;
    const coverage = coverageRef.current;
    const oiPeriod = resolveOpenInterestPeriod(context.interval);
    const expectedHistoryGeneration = historyGenerationRef.current;
    const expectedHistoryContextKey = context.historyContextKey;
    const requests: Array<{
      channel: MarketMetricChannel;
      period: string | null;
      view: "hybrid" | null;
      limit: number;
      direction: "forward" | "backward";
    }> = [];
    if (context.metricChannels.includes("funding_rate")) {
      requests.push({
        channel: "funding_rate" as const,
        period: context.interval,
        view: "hybrid",
        limit: 1000,
        direction: "forward" as const,
      });
    }
    if (context.metricChannels.includes("open_interest")) {
      requests.push({
        channel: "open_interest" as const,
        period: oiPeriod,
        view: null,
        limit: 500,
        direction: "backward" as const,
      });
    }
    let scheduled = false;
    for (const descriptor of requests) {
      const coverageKey = [
        context.identityKey,
        descriptor.channel,
        descriptor.period || "none",
        descriptor.view || "sparse",
      ].join(":");
      const requestRange = nextUncoveredHistoryRange(
        [
          ...(coverage.get(coverageKey) || []),
          ...(inFlightCoverage.get(coverageKey) || []),
        ],
        requested,
      );
      if (!requestRange) continue;
      const requestKey = [
        coverageKey,
        requestRange.startMs,
        requestRange.endMs,
      ].join(":");
      if (inFlight.has(requestKey)) continue;
      scheduled = true;
      inFlight.add(requestKey);
      inFlightCoverage.set(coverageKey, [
        ...(inFlightCoverage.get(coverageKey) || []),
        requestRange,
      ]);
      setHistoryErrorState((current) => {
        if (disposedRef.current
          || historyGenerationRef.current !== expectedHistoryGeneration
          || activeRef.current.historyContextKey !== expectedHistoryContextKey) return current;
        const errors = current.historyContextKey === expectedHistoryContextKey
          ? current.errors
          : {};
        if (!(descriptor.channel in errors)) {
          return current.historyContextKey === expectedHistoryContextKey
            ? current
            : { historyContextKey: expectedHistoryContextKey, errors: {} };
        }
        const next = { ...errors };
        delete next[descriptor.channel];
        return { historyContextKey: expectedHistoryContextKey, errors: next };
      });
      const controller = new AbortController();
      const controllers = historyAbortControllersRef.current;
      controllers.add(controller);
      const isCurrentRequest = (): boolean => {
        const current = activeRef.current;
        return isAdvancedMarketHistoryRequestCurrent({
          aborted: controller.signal.aborted,
          disposed: disposedRef.current,
          expectedGeneration: expectedHistoryGeneration,
          currentGeneration: historyGenerationRef.current,
          expectedHistoryContextKey,
          currentHistoryContextKey: current.historyContextKey,
          expectedIdentityKey: context.identityKey,
          currentIdentityKey: current.identityKey,
          expectedInterval: context.interval,
          currentInterval: current.interval,
          channel: descriptor.channel,
          period: descriptor.period,
          currentMetricChannels: current.metricChannels,
          seriesReady: current.seriesReady,
        });
      };
      void (async () => {
        try {
          for (let page = 0; page < MAX_HISTORY_PAGES_PER_LOAD; page += 1) {
            if (!isCurrentRequest()) return;
            const pageRange = nextUncoveredHistoryRange(
              coverage.get(coverageKey) || [],
              requestRange,
            );
            if (!pageRange) return;
            const payload = await fetchAdvancedMarketHistory(
              context.identity,
              descriptor.channel,
              {
                period: descriptor.period,
                view: descriptor.view,
                startMs: pageRange.startMs,
                endMs: pageRange.endMs,
                limit: descriptor.limit,
                signal: controller.signal,
              },
            );
            if (!isCurrentRequest()) return;
            advancedMarketDataStore.mergeMetricHistory(
              context.identity,
              descriptor.channel,
              payload.data,
              descriptor.period,
            );
            if (payload.fallback === true || payload.retryable === true) {
              scheduleHistoryRetry(expectedHistoryContextKey, expectedHistoryGeneration);
              return;
            }
            const covered = coverageForHistoryPage(
              pageRange,
              payload,
              descriptor.direction,
            );
            if (!covered) {
              scheduleHistoryRetry(expectedHistoryContextKey, expectedHistoryGeneration);
              return;
            }
            coverage.set(
              coverageKey,
              mergeHistoryCoverage(coverage.get(coverageKey) || [], covered),
            );
          }
          if (nextUncoveredHistoryRange(coverage.get(coverageKey) || [], requestRange)) {
            scheduleHistoryContinuation(expectedHistoryContextKey, expectedHistoryGeneration);
          }
        } catch (error: unknown) {
          if (isAbortError(error) || !isCurrentRequest()) return;
          console.warn(`Advanced market ${descriptor.channel} history failed:`, error);
          setHistoryErrorState((current) => {
            if (!isCurrentRequest()) return current;
            const errors = current.historyContextKey === expectedHistoryContextKey
              ? current.errors
              : {};
            return {
              historyContextKey: expectedHistoryContextKey,
              errors: {
                ...errors,
                [descriptor.channel]: error instanceof Error ? error.message : String(error),
              },
            };
          });
          scheduleHistoryRetry(expectedHistoryContextKey, expectedHistoryGeneration);
        } finally {
          inFlight.delete(requestKey);
          const remainingRanges = (inFlightCoverage.get(coverageKey) || []).filter(
            (range) => range.startMs !== requestRange.startMs || range.endMs !== requestRange.endMs,
          );
          if (remainingRanges.length > 0) inFlightCoverage.set(coverageKey, remainingRanges);
          else inFlightCoverage.delete(coverageKey);
          controllers.delete(controller);
        }
      })();
    }
    return scheduled;
  }, [scheduleHistoryContinuation, scheduleHistoryRetry]);

  const ensureVisibleRange = useCallback((range: unknown): boolean => {
    const requested = parseVisibleTimeRange(range);
    return requested ? loadHistory(requested) : false;
  }, [loadHistory]);

  const retry = useCallback(() => {
    invalidateHistoryRequests(false);
    setConnectionState({
      identityKey,
      status: enabled ? "connecting" : "disabled",
    });
    setStreamErrorState({ identityKey, error: null });
    setHistoryErrorState({ historyContextKey, errors: {} });
    setRetryToken((value) => value + 1);
  }, [enabled, historyContextKey, identityKey, invalidateHistoryRequests]);

  useEffect(() => {
    if (!activeMetricChannels.includes("open_interest")) return;
    advancedMarketDataStore.setOpenInterestPeriod(
      identity,
      resolveOpenInterestPeriod(interval),
    );
  }, [activeMetricChannels, identity, interval]);

  useEffect(() => {
    if (!activeMetricChannels.includes("funding_rate")) return;
    advancedMarketDataStore.setFundingPeriod(identity, interval);
  }, [activeMetricChannels, identity, interval]);

  useEffect(() => {
    const identityChanged = coverageIdentityRef.current !== identityKey;
    coverageIdentityRef.current = identityKey;
    invalidateHistoryRequests(identityChanged);
    if (!disposedRef.current) {
      setHistoryErrorState({ historyContextKey, errors: {} });
    }
  }, [historyContextKey, identityKey, invalidateHistoryRequests]);

  useEffect(() => {
    streamGenerationRef.current += 1;
    const generation = streamGenerationRef.current;
    const isCurrentStream = (): boolean => !disposedRef.current
      && streamGenerationRef.current === generation
      && activeRef.current.identityKey === identityKey;

    if (!enabled) {
      streamRef.current = null;
      setConnectionState({ identityKey, status: "disabled" });
      setStreamErrorState({ identityKey, error: null });
      advancedMarketDataStore.setConnectionStatus(identity, "disabled");
      return undefined;
    }

    setConnectionState({ identityKey, status: "connecting" });
    setStreamErrorState({ identityKey, error: null });
    advancedMarketDataStore.setConnectionStatus(identity, "connecting");
    const stream = new MarketStreamController({
      url: getAdvancedMarketStreamUrl(),
      identity,
      channels: activeRef.current.requestedChannels,
      onRecords: (records) => {
        if (isCurrentStream()) {
          advancedMarketDataStore.applyRecords(identity, records);
        }
      },
      onStatus: (status) => {
        if (isCurrentStream()) {
          setConnectionState({ identityKey, status });
          if (status === "live") setStreamErrorState({ identityKey, error: null });
          advancedMarketDataStore.setConnectionStatus(identity, status);
        }
      },
      onError: (error) => {
        if (isCurrentStream()) {
          console.warn("Advanced market stream error:", error);
          setStreamErrorState({
            identityKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    streamRef.current = stream;
    stream.start();

    return () => {
      if (streamGenerationRef.current === generation) streamGenerationRef.current += 1;
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
      advancedMarketDataStore.setConnectionStatus(identity, "disconnected");
    };
  }, [enabled, identity, identityKey, retryToken]);

  useEffect(() => {
    streamRef.current?.setChannels(requestedChannels);
  }, [requestedChannelSignature, requestedChannels]);

  useEffect(() => {
    if (!enabled || requestedChannels.length === 0) return undefined;
    const controller = new AbortController();
    const expectedChannelSignature = requestedChannelSignature;
    void fetchAdvancedMarketSnapshot(identity, requestedChannels, controller.signal)
      .then((payload) => {
        if (!disposedRef.current
          && !controller.signal.aborted
          && activeRef.current.identityKey === identityKey
          && activeRef.current.requestedChannelSignature === expectedChannelSignature) {
          advancedMarketDataStore.applyRecords(identity, payload.data);
        }
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)
          && !disposedRef.current
          && activeRef.current.identityKey === identityKey
          && activeRef.current.requestedChannelSignature === expectedChannelSignature) {
          console.warn("Advanced market snapshot failed:", error);
        }
      });
    return () => controller.abort();
  }, [enabled, identity, identityKey, requestedChannelSignature, requestedChannels, retryToken]);

  useEffect(() => {
    if (!metricsEnabled || !seriesReady) return;
    if (dataMeta.firstTime == null || dataMeta.lastTime == null) return;
    const firstTime = Number(dataMeta.firstTime);
    const lastTime = Number(dataMeta.lastTime);
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) return;
    const fullRange = {
      startMs: Math.max(0, Math.floor(firstTime * 1000)),
      endMs: Math.max(0, Math.ceil(lastTime * 1000)),
    };
    const barTimes = (seriesStore?.snapshot() || []).map((row) => Number(row.time));
    for (const range of buildTailFirstHistoryRanges(fullRange, barTimes)) {
      loadHistory(range);
    }
  }, [
    dataMeta.firstTime,
    dataMeta.lastTime,
    historyRetryToken,
    loadHistory,
    metricChannelSignature,
    metricsEnabled,
    retryToken,
    seriesStore,
    seriesReady,
    interval,
  ]);

  const marketStudies = useMemo<AdvancedMarketStudyView[]>(() => (
    metricSelections.map((item) => {
      const catalog = MARKET_STUDY_CATALOG[item.id];
      const capability = metricCapabilities[item.channel];
      const error = item.visible
        ? historyErrors[item.channel] || streamError || null
        : null;
      let status: AdvancedMarketStudyView["status"] = "available";
      if (!capability.supported) status = "unavailable";
      else if (!item.added) status = "available";
      else if (!item.visible) status = "hidden";
      else if (error) status = "error";
      else if (connectionStatus === "live") status = "active";
      else status = "loading";
      return {
        ...item,
        ...catalog,
        category: "contract-data" as const,
        paneTarget: "sub" as const,
        supported: capability.supported,
        supportReason: capability.reason,
        status,
        error,
      };
    })
  ), [
    connectionStatus,
    historyErrors,
    metricCapabilities,
    metricSelections,
    streamError,
  ]);

  const view = useMemo(() => ({
    enabled,
    summaryEnabled,
    metricsEnabled,
    identity,
    identityKey,
    interval,
    seriesKey,
    seriesStore,
    marketStudies,
    metricCapabilities,
  }), [
    enabled,
    identity,
    identityKey,
    interval,
    marketStudies,
    metricCapabilities,
    metricsEnabled,
    seriesKey,
    seriesStore,
    summaryEnabled,
  ]);

  return useMemo(() => ({
    view,
    actions: {
      ensureVisibleRange,
      retry,
      addMarketStudy,
      removeMarketStudy,
      toggleMarketStudyVisibility,
    },
    status: { enabled, connectionStatus },
  }), [
    addMarketStudy,
    connectionStatus,
    enabled,
    ensureVisibleRange,
    removeMarketStudy,
    retry,
    toggleMarketStudyVisibility,
    view,
  ]);
}
