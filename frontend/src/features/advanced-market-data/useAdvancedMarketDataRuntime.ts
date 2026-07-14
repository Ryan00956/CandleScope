import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import {
  fetchAdvancedMarketHistory,
  fetchAdvancedMarketSnapshot,
  getAdvancedMarketStreamUrl,
} from "./advancedMarketDataApi.js";
import { advancedMarketDataStore } from "./advancedMarketDataStore.js";
import {
  coverageForHistoryPage,
  mergeHistoryCoverage,
  nextUncoveredHistoryRange,
  type MarketHistoryRange,
} from "./marketHistoryCoverage.js";
import { MarketStreamController } from "./marketStreamController.js";
import { resolveOpenInterestPeriod } from "./metricPaneProjection.js";
import {
  ADVANCED_MARKET_CHANNELS,
  buildAdvancedMarketIdentityKey,
  normalizeAdvancedMarketIdentity,
  type AdvancedMarketIdentity,
  type AdvancedMarketRuntime,
} from "./advancedMarketDataTypes.js";

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
  generation: number;
}

const MAX_HISTORY_PAGES_PER_LOAD = 8;
const HISTORY_RETRY_DELAY_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function supportsAdvancedMarketData(session: ChartSessionRuntime): boolean {
  const { exchange, marketType, exchangeConfig } = session.view;
  if (marketType.toLowerCase() !== "futures") return false;
  const raw = exchangeConfig.raw;
  if (!raw) return exchange.toLowerCase() === "binance";
  const channels = Array.isArray(raw.channels) ? raw.channels : [];
  const required = new Set(["mark_price", "index_price", "funding_rate", "open_interest"]);
  for (const item of channels) {
    if (!isRecord(item) || typeof item.channel !== "string") continue;
    const marketTypes = Array.isArray(item.market_types) ? item.market_types : [];
    if (!marketTypes.some((value) => String(value).toLowerCase() === marketType.toLowerCase())) continue;
    required.delete(item.channel.toLowerCase());
  }
  return required.size === 0;
}

function parseVisibleTimeRange(range: unknown): MarketHistoryRange | null {
  if (!isRecord(range) || !isRecord(range.time)) return null;
  const from = Number(range.time.from);
  const to = Number(range.time.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    startMs: Math.max(0, Math.floor(Math.min(from, to) * 1000)),
    endMs: Math.max(0, Math.ceil(Math.max(from, to) * 1000)),
  };
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
  const enabled = supportsAdvancedMarketData(session);
  const [retryToken, setRetryToken] = useState(0);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveRuntimeContext>({
    enabled,
    identity,
    identityKey,
    interval: session.view.interval,
    generation: 0,
  });
  const abortControllersRef = useRef(new Set<AbortController>());
  const inFlightRef = useRef(new Set<string>());
  const coverageRef = useRef(new Map<string, MarketHistoryRange[]>());
  const historyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeRef.current = {
      ...activeRef.current,
      enabled,
      identity,
      identityKey,
      interval: session.view.interval,
    };
  }, [enabled, identity, identityKey, session.view.interval]);

  const scheduleHistoryRetry = useCallback(() => {
    if (historyRetryTimerRef.current !== null) return;
    historyRetryTimerRef.current = setTimeout(() => {
      historyRetryTimerRef.current = null;
      setHistoryRetryToken((value) => value + 1);
    }, HISTORY_RETRY_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (historyRetryTimerRef.current !== null) {
      clearTimeout(historyRetryTimerRef.current);
      historyRetryTimerRef.current = null;
    }
  }, []);

  const loadHistory = useCallback((requested: MarketHistoryRange): boolean => {
    const context = activeRef.current;
    if (!context.enabled) return false;
    const inFlight = inFlightRef.current;
    const coverage = coverageRef.current;
    const oiPeriod = resolveOpenInterestPeriod(context.interval);
    const requests = [
      {
        channel: "funding_rate" as const,
        period: null,
        limit: 1000,
        direction: "forward" as const,
      },
      {
        channel: "open_interest" as const,
        period: oiPeriod,
        limit: 500,
        direction: "backward" as const,
      },
    ];
    let scheduled = false;
    for (const descriptor of requests) {
      const coverageKey = `${context.identityKey}:${descriptor.channel}:${descriptor.period || "none"}`;
      if (!nextUncoveredHistoryRange(coverage.get(coverageKey) || [], requested)) continue;
      const requestKey = [
        coverageKey,
        requested.startMs,
        requested.endMs,
      ].join(":");
      if (inFlight.has(requestKey)) continue;
      scheduled = true;
      inFlight.add(requestKey);
      const controller = new AbortController();
      const controllers = abortControllersRef.current;
      controllers.add(controller);
      const expectedGeneration = context.generation;
      void (async () => {
        try {
          for (let page = 0; page < MAX_HISTORY_PAGES_PER_LOAD; page += 1) {
            const current = activeRef.current;
            if (controller.signal.aborted
              || current.generation !== expectedGeneration
              || current.identityKey !== context.identityKey) return;
            const pageRange = nextUncoveredHistoryRange(
              coverage.get(coverageKey) || [],
              requested,
            );
            if (!pageRange) return;
            const payload = await fetchAdvancedMarketHistory(
              context.identity,
              descriptor.channel,
              {
                period: descriptor.period,
                startMs: pageRange.startMs,
                endMs: pageRange.endMs,
                limit: descriptor.limit,
                signal: controller.signal,
              },
            );
            const latest = activeRef.current;
            if (controller.signal.aborted
              || latest.generation !== expectedGeneration
              || latest.identityKey !== context.identityKey) return;
            advancedMarketDataStore.mergeMetricHistory(
              context.identity,
              descriptor.channel,
              payload.data,
              descriptor.period,
            );
            if (payload.fallback === true) {
              scheduleHistoryRetry();
              return;
            }
            const covered = coverageForHistoryPage(
              pageRange,
              payload,
              descriptor.direction,
            );
            if (!covered) {
              scheduleHistoryRetry();
              return;
            }
            coverage.set(
              coverageKey,
              mergeHistoryCoverage(coverage.get(coverageKey) || [], covered),
            );
          }
          if (nextUncoveredHistoryRange(coverage.get(coverageKey) || [], requested)) {
            scheduleHistoryRetry();
          }
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn(`Advanced market ${descriptor.channel} history failed:`, error);
          scheduleHistoryRetry();
        } finally {
          inFlight.delete(requestKey);
          controllers.delete(controller);
        }
      })();
    }
    return scheduled;
  }, [scheduleHistoryRetry]);

  const ensureVisibleRange = useCallback((range: unknown): boolean => {
    const requested = parseVisibleTimeRange(range);
    return requested ? loadHistory(requested) : false;
  }, [loadHistory]);

  const retry = useCallback(() => {
    if (historyRetryTimerRef.current !== null) {
      clearTimeout(historyRetryTimerRef.current);
      historyRetryTimerRef.current = null;
    }
    setRetryToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    advancedMarketDataStore.setOpenInterestPeriod(
      identity,
      resolveOpenInterestPeriod(session.view.interval),
    );
  }, [enabled, identity, session.view.interval]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    activeRef.current = {
      enabled,
      identity,
      identityKey,
      interval: activeRef.current.interval,
      generation,
    };
    coverageRef.current = new Map();
    inFlightRef.current = new Set();
    for (const controller of abortControllersRef.current) controller.abort();
    const controllers = new Set<AbortController>();
    abortControllersRef.current = controllers;

    if (!enabled) {
      advancedMarketDataStore.setConnectionStatus(identity, "disabled");
      return undefined;
    }

    advancedMarketDataStore.setConnectionStatus(identity, "connecting");
    const snapshotController = new AbortController();
    controllers.add(snapshotController);
    void fetchAdvancedMarketSnapshot(identity, ADVANCED_MARKET_CHANNELS, snapshotController.signal)
      .then((payload) => {
        if (!snapshotController.signal.aborted
          && activeRef.current.generation === generation
          && activeRef.current.identityKey === identityKey) {
          advancedMarketDataStore.applyRecords(identity, payload.data);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Advanced market snapshot failed:", error);
        }
      })
      .finally(() => controllers.delete(snapshotController));

    const stream = new MarketStreamController({
      url: getAdvancedMarketStreamUrl(),
      identity,
      onRecords: (records) => {
        if (activeRef.current.generation === generation
          && activeRef.current.identityKey === identityKey) {
          advancedMarketDataStore.applyRecords(identity, records);
        }
      },
      onStatus: (status) => {
        if (activeRef.current.generation === generation
          && activeRef.current.identityKey === identityKey) {
          advancedMarketDataStore.setConnectionStatus(identity, status);
        }
      },
      onError: (error) => console.warn("Advanced market stream error:", error),
    });
    stream.start();

    return () => {
      stream.close();
      snapshotController.abort();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      advancedMarketDataStore.setConnectionStatus(identity, "disconnected");
    };
  }, [enabled, identity, identityKey, retryToken]);

  useEffect(() => {
    if (!enabled) return;
    if (dataMeta.firstTime == null || dataMeta.lastTime == null) return;
    const firstTime = Number(dataMeta.firstTime);
    const lastTime = Number(dataMeta.lastTime);
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) return;
    loadHistory({
      startMs: Math.max(0, Math.floor(firstTime * 1000)),
      endMs: Math.max(0, Math.ceil(lastTime * 1000)),
    });
  }, [
    dataMeta.firstTime,
    dataMeta.lastTime,
    enabled,
    historyRetryToken,
    loadHistory,
    retryToken,
    session.view.interval,
  ]);

  const view = useMemo(() => ({
    enabled,
    identity,
    identityKey,
    seriesStore,
  }), [enabled, identity, identityKey, seriesStore]);

  return useMemo(() => ({
    view,
    actions: { ensureVisibleRange, retry },
    status: { enabled },
  }), [enabled, ensureVisibleRange, retry, view]);
}
