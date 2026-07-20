import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import {
  mergeHistoryCoverage,
  type MarketHistoryRange,
} from "../advanced-market-data/marketHistoryCoverage.js";
import type {
  AdvancedMarketConnectionStatus,
  AdvancedMarketIdentity,
} from "../advanced-market-data/advancedMarketDataTypes.js";
import { fetchLiquidationHistory, getLiquidationStreamUrl } from "./liquidationApi.js";
import {
  LiquidationHistoryRequestCoordinator,
  normalizeLiquidationHistoryRange,
} from "./liquidationHistoryRequests.js";
import { liquidationStore } from "./liquidationStore.js";
import { LiquidationStreamController } from "./liquidationStreamController.js";
import type {
  LiquidationPositionSide,
  LiquidationQualityMetadata,
  LiquidationRuntimeView,
} from "./liquidationTypes.js";

interface UseLiquidationRuntimeOptions {
  identity: AdvancedMarketIdentity;
  identityKey: string;
  interval: string;
  seriesKey: string;
  dataMeta: ChartDataCommitMeta;
  seriesStore: SeriesWindowStore | null;
  added: boolean;
  visible: boolean;
  supported: boolean;
}

export interface LiquidationRuntimeResult {
  view: LiquidationRuntimeView;
  ensureVisibleRange(range: unknown): boolean;
  retry(): void;
}

interface ActiveContext {
  enabled: boolean;
  identity: AdvancedMarketIdentity;
  identityKey: string;
  interval: string;
  seriesReady: boolean;
}

const LIQUIDATION_SIDES: readonly LiquidationPositionSide[] = ["long", "short"];
const MAX_HISTORY_PAGES_PER_LOAD = 8;
const HISTORY_PAGE_LIMIT = 5000;
const HISTORY_RETRY_DELAY_MS = 30_000;
const MINUTE_MS = 60_000;
const LIVE_HISTORY_RECONCILE_MS = 60_000;
const LIVE_HISTORY_RECONCILE_WINDOW_MS = 5 * MINUTE_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVisibleRange(value: unknown): MarketHistoryRange | null {
  if (!isRecord(value) || !isRecord(value.time)) return null;
  const from = Number(value.time.from);
  const to = Number(value.time.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return normalizeLiquidationHistoryRange({
    startMs: Math.floor(Math.min(from, to) * 1000),
    endMs: Math.ceil(Math.max(from, to) * 1000),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function assertHistoryIdentity(
  identity: AdvancedMarketIdentity,
  side: LiquidationPositionSide,
  payload: Awaited<ReturnType<typeof fetchLiquidationHistory>>,
): void {
  if (payload.key.exchange !== identity.exchange.toLowerCase()
    || payload.key.market_type !== identity.marketType.toLowerCase()
    || payload.key.symbol !== identity.symbol.toUpperCase()
    || payload.key.params.period !== "1m"
    || payload.key.params.position_side !== side) {
    throw new Error(`Liquidation ${side} history identity did not match the request`);
  }
}

export function useLiquidationRuntime({
  identity,
  identityKey,
  interval,
  seriesKey,
  dataMeta,
  seriesStore,
  added,
  visible,
  supported,
}: UseLiquidationRuntimeOptions): LiquidationRuntimeResult {
  const enabled = added && supported;
  const seriesReady = String(seriesStore?.seriesKey || "") === seriesKey
    && String(dataMeta.seriesKey || "") === seriesKey;
  const [streamToken, setStreamToken] = useState(0);
  const [historyToken, setHistoryToken] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<AdvancedMarketConnectionStatus>(
    enabled ? "connecting" : "disabled",
  );
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [quality, setQuality] = useState<LiquidationQualityMetadata | null>(null);
  const disposedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveContext>({
    enabled,
    identity,
    identityKey,
    interval,
    seriesReady,
  });
  const coverageRef = useRef(new Map<LiquidationPositionSide, MarketHistoryRange[]>());
  const requestCoordinatorRef = useRef(new LiquidationHistoryRequestCoordinator());
  const abortControllersRef = useRef(new Set<AbortController>());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    activeRef.current = { enabled, identity, identityKey, interval, seriesReady };
  }, [enabled, identity, identityKey, interval, seriesReady]);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const invalidateHistory = useCallback((clearCoverage: boolean) => {
    generationRef.current += 1;
    for (const controller of abortControllersRef.current) controller.abort();
    abortControllersRef.current = new Set();
    requestCoordinatorRef.current.clear();
    clearRetryTimer();
    if (clearCoverage) coverageRef.current = new Map();
  }, [clearRetryTimer]);

  const scheduleHistoryRetry = useCallback((expectedGeneration: number) => {
    if (disposedRef.current
      || generationRef.current !== expectedGeneration
      || retryTimerRef.current !== null) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (disposedRef.current || generationRef.current !== expectedGeneration) return;
      setHistoryToken((value) => value + 1);
    }, HISTORY_RETRY_DELAY_MS);
  }, []);

  useLayoutEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      invalidateHistory(true);
    };
  }, [invalidateHistory]);

  const loadHistory = useCallback((rawRange: MarketHistoryRange): boolean => {
    const context = activeRef.current;
    if (!context.enabled || !context.seriesReady) return false;
    const requested = normalizeLiquidationHistoryRange(rawRange);
    if (!requested) return false;
    const expectedGeneration = generationRef.current;
    let scheduled = false;
    for (const side of LIQUIDATION_SIDES) {
      const claims = requestCoordinatorRef.current.claim(
        side,
        requested,
        coverageRef.current.get(side) || [],
      );
      if (claims.length > 0) scheduled = true;
      for (const claim of claims) {
        const uncovered = claim.range;
        const controller = new AbortController();
        abortControllersRef.current.add(controller);
        const isCurrent = (): boolean => {
          const current = activeRef.current;
          return !disposedRef.current
            && !controller.signal.aborted
            && generationRef.current === expectedGeneration
            && current.enabled
            && current.seriesReady
            && current.identityKey === context.identityKey
            && current.interval === context.interval;
        };
        void (async () => {
          let pageStartMs = uncovered.startMs;
          try {
            setHistoryError(null);
            for (let page = 0; page < MAX_HISTORY_PAGES_PER_LOAD; page += 1) {
              if (!isCurrent() || pageStartMs > uncovered.endMs) return;
              const payload = await fetchLiquidationHistory(context.identity, {
                positionSide: side,
                startMs: pageStartMs,
                endMs: uncovered.endMs,
                limit: HISTORY_PAGE_LIMIT,
                signal: controller.signal,
              });
              if (!isCurrent()) return;
              assertHistoryIdentity(context.identity, side, payload);
              liquidationStore.mergeHistory(context.identity, payload.data, payload.quality);
              setQuality(payload.quality);
              const tail = payload.data.at(-1);
              if (!payload.hasMore) {
                coverageRef.current.set(side, mergeHistoryCoverage(
                  coverageRef.current.get(side) || [],
                  uncovered,
                ));
                return;
              }
              if (!tail || tail.bucketStartMs < pageStartMs) {
                throw new Error(`Liquidation ${side} history did not advance its cursor`);
              }
              const coveredEndMs = Math.min(uncovered.endMs, tail.bucketStartMs);
              coverageRef.current.set(side, mergeHistoryCoverage(
                coverageRef.current.get(side) || [],
                { startMs: pageStartMs, endMs: coveredEndMs },
              ));
              pageStartMs = tail.bucketStartMs + MINUTE_MS;
            }
            if (pageStartMs <= uncovered.endMs && isCurrent()) {
              setHistoryToken((value) => value + 1);
            }
          } catch (caught: unknown) {
            if (isAbortError(caught) || !isCurrent()) return;
            console.warn(`Liquidation ${side} history failed:`, caught);
            setHistoryError(caught instanceof Error ? caught.message : String(caught));
            scheduleHistoryRetry(expectedGeneration);
          } finally {
            requestCoordinatorRef.current.release(claim);
            abortControllersRef.current.delete(controller);
          }
        })();
      }
    }
    return scheduled;
  }, [scheduleHistoryRetry]);

  const ensureVisibleRange = useCallback((range: unknown): boolean => {
    const requested = parseVisibleRange(range);
    return requested ? loadHistory(requested) : false;
  }, [loadHistory]);

  const reloadHistory = useCallback((clearUnconfirmed: boolean) => {
    if (clearUnconfirmed) liquidationStore.clearUnconfirmed(identity);
    invalidateHistory(true);
    setHistoryError(null);
    setHistoryToken((value) => value + 1);
  }, [identity, invalidateHistory]);

  const retry = useCallback(() => {
    reloadHistory(true);
    setError(null);
    setConnectionStatus(enabled ? "connecting" : "disabled");
    setStreamToken((value) => value + 1);
  }, [enabled, reloadHistory]);

  useEffect(() => {
    invalidateHistory(true);
    setHistoryError(null);
    setQuality(null);
  }, [identityKey, interval, invalidateHistory]);

  useEffect(() => {
    if (!enabled || !seriesReady) return undefined;
    const reconcileTail = () => {
      const cutoffMs = Math.max(0, Date.now() - LIVE_HISTORY_RECONCILE_WINDOW_MS);
      for (const side of LIQUIDATION_SIDES) {
        const retained = (coverageRef.current.get(side) || []).flatMap((range) => {
          if (range.startMs >= cutoffMs) return [];
          return [{ ...range, endMs: Math.min(range.endMs, cutoffMs - 1) }];
        });
        coverageRef.current.set(side, retained);
      }
      setHistoryToken((value) => value + 1);
    };
    const timer = window.setInterval(reconcileTail, LIVE_HISTORY_RECONCILE_MS);
    return () => { window.clearInterval(timer); };
  }, [enabled, identityKey, seriesReady]);

  useEffect(() => {
    if (!enabled) {
      setConnectionStatus("disabled");
      setError(null);
      liquidationStore.setConnectionStatus(identity, "disabled");
      return undefined;
    }
    let current = true;
    setConnectionStatus("connecting");
    setError(null);
    liquidationStore.setConnectionStatus(identity, "connecting");
    const stream = new LiquidationStreamController({
      url: getLiquidationStreamUrl(),
      identity,
      onEvents: (events, nextQuality) => {
        if (!current) return;
        liquidationStore.applyEvents(identity, events, nextQuality);
        setQuality(nextQuality);
      },
      onQuality: (nextQuality) => {
        if (!current) return;
        setQuality(nextQuality);
      },
      onStatus: (status) => {
        if (!current) return;
        setConnectionStatus(status);
        if (status === "live") setError(null);
        liquidationStore.setConnectionStatus(identity, status);
      },
      onError: (caught) => {
        if (!current) return;
        console.warn("Liquidation stream error:", caught);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
      onResyncRequired: () => {
        if (current) reloadHistory(true);
      },
      onSubscribed: () => {
        if (current) reloadHistory(false);
      },
    });
    stream.start();
    return () => {
      current = false;
      stream.close();
      liquidationStore.setConnectionStatus(identity, "disconnected");
    };
  }, [enabled, identity, reloadHistory, streamToken]);

  useEffect(() => {
    if (!enabled || !seriesReady) return;
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
    historyToken,
    interval,
    loadHistory,
    seriesReady,
  ]);

  const view = useMemo<LiquidationRuntimeView>(() => ({
    enabled,
    visible,
    identityKey,
    connectionStatus: enabled ? connectionStatus : "disabled",
    error: enabled ? error : null,
    historyError: enabled ? historyError : null,
    quality,
  }), [connectionStatus, enabled, error, historyError, identityKey, quality, visible]);

  return useMemo(() => ({ view, ensureVisibleRange, retry }), [ensureVisibleRange, retry, view]);
}
