import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { markPerfOnce, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type {
  BackfillCompletedMessage,
  CommitChartData,
  KlineStreamController,
  PatchCacheTick,
} from "./klineContracts.js";
import type { KlineBar } from "./marketDataTypes.js";
import type { SeriesDataFeed } from "./feed/seriesDataFeed.js";

const WS_RECONNECT_BASE_DELAY = 2_000;
const WS_RECONNECT_MAX_DELAY = 60_000;
const WS_MAX_RECONNECT_ATTEMPTS = 20;
const WS_PING_INTERVAL = 30_000;
const WS_INITIAL_FALLBACK_DELAY = 4_000;
const POLLING_INTERVAL_MS = 1_000;
const PENDING_REPAIR_POLL_INTERVAL_MS = 3_000;
const HELD_WINDOW_GAP_SCAN_INTERVAL_MS = 15_000;
const WS_RECOVERY_COUNT_BACK = 1_500;
const TAB_RECOVERY_MIN_HIDDEN_MS = 15_000;

export type KlineWebSocketStatus =
  | "idle"
  | "connecting"
  | "live"
  | "fallback"
  | "reconnecting";

export interface UseKlineStreamRuntimeOptions {
  symbol: SymbolCode;
  exchange: ExchangeId;
  marketType: MarketType;
  trackedIntervals: readonly IntervalString[];
  intervalRef: MutableRefObject<IntervalString>;
  seriesDataFeed: SeriesDataFeed;
  commitPatchedChartData: CommitChartData;
  patchCacheTick: PatchCacheTick;
  getCacheRows(series: {
    exchange: ExchangeId;
    marketType: MarketType;
    symbol: SymbolCode;
    interval: IntervalString;
  }): KlineBar[];
  updateLastPrice(candidate: KlineBar, interval: IntervalString): void;
  updateRealtimePrice(closePrice: number): void;
  handleBackfillCompleted(message: BackfillCompletedMessage): boolean;
  setWsStatus: Dispatch<SetStateAction<KlineWebSocketStatus>>;
}

export function useKlineStreamRuntime({
  symbol,
  exchange,
  marketType,
  trackedIntervals,
  intervalRef,
  seriesDataFeed,
  commitPatchedChartData,
  patchCacheTick,
  getCacheRows,
  updateLastPrice,
  updateRealtimePrice,
  handleBackfillCompleted,
  setWsStatus,
}: UseKlineStreamRuntimeOptions): void {
  const subscriptionRef = useRef<KlineStreamController | null>(null);
  const trackedIntervalsRef = useRef(trackedIntervals);

  useEffect(() => {
    trackedIntervalsRef.current = trackedIntervals;
  }, [trackedIntervals]);

  useEffect(() => {
    let active = true;
    let subscription: KlineStreamController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let pendingRepairInterval: ReturnType<typeof setInterval> | null = null;
    let heldWindowGapScanInterval: ReturnType<typeof setInterval> | null = null;
    let pollingInFlight = false;
    let pendingRepairPollingInFlight = false;
    let reconnectDelay = WS_RECONNECT_BASE_DELAY;
    let reconnectAttempts = 0;

    const stopPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        subscription?.sendPing();
      }, WS_PING_INTERVAL);
    };

    const startPolling = () => {
      recordPerfEvent("ws.kline.polling.start", { symbol, marketType, exchange });
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (!active) return;
        if (pollingInFlight) return;
        pollingInFlight = true;
        try {
          const currentIntv = intervalRef.current;
          const result = await seriesDataFeed.getLatest(
            { exchange, marketType, symbol, interval: currentIntv },
            { limit: 2, source: "polling-latest", commit: "patch-active" },
          );
          if (!active || result.stale || result.active === false || !result?.data?.length) return;

          const latestTick = result.data[result.data.length - 1];
          if (latestTick) updateLastPrice(latestTick, currentIntv);
          setWsStatus((prev) => (prev === "live" ? prev : "fallback"));
        } catch (pollErr) {
          console.warn("Polling fallback failed:", pollErr);
        } finally {
          pollingInFlight = false;
        }
      }, POLLING_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      reconnectAttempts += 1;
      if (reconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
        console.warn(`WS: exceeded ${WS_MAX_RECONNECT_ATTEMPTS} reconnect attempts, staying on polling fallback`);
        setWsStatus("fallback");
        return;
      }

      console.log(`WS: scheduling reconnect #${reconnectAttempts} in ${reconnectDelay}ms`);
      setWsStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_DELAY);
    };

    const connect = () => {
      if (!active) return;
      setWsStatus("connecting");

      if (subscription) {
        subscription.close();
        subscription = null;
      }

      try {
        subscription = seriesDataFeed.subscribeBars(
          { exchange, marketType, symbol },
          {
            intervals: trackedIntervalsRef.current,
            onOpen: () => {
              if (!active) return;
              markPerfOnce("ws.kline.open", { symbol, marketType, exchange });

              const isReconnection = reconnectAttempts > 0;
              reconnectDelay = WS_RECONNECT_BASE_DELAY;
              reconnectAttempts = 0;

              setWsStatus("live");
              markPerfOnce("ws.kline.live", {
                symbol,
                marketType,
                exchange,
                intervals: trackedIntervalsRef.current,
                source: "socket-open",
              });

              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }

              startPing();

              if (isReconnection) {
                const currentIntv = intervalRef.current;
                console.log(`[WS-Recovery] Reconnected, reloading recent bars for ${symbol}@${currentIntv}`);
                seriesDataFeed.getBars(
                  { exchange, marketType, symbol, interval: currentIntv },
                  { countBack: WS_RECOVERY_COUNT_BACK, source: "ws-reconnect-history" },
                )
                  .then((result) => {
                    if (
                      !active
                      || result.stale
                      || result.active === false
                      || !result?.data?.length
                    ) return;
                    const latest = result.data[result.data.length - 1];
                    if (latest) updateLastPrice(latest, currentIntv);
                    void seriesDataFeed.repairVisibleGaps(
                      { exchange, marketType, symbol, interval: currentIntv },
                      result.data,
                      null,
                      { source: "ws-reconnect-gap-planner" },
                    );
                    void seriesDataFeed.pollPendingRepairs(
                      { exchange, marketType, symbol, interval: currentIntv },
                      { force: true },
                    );
                    console.log(`[WS-Recovery] Reloaded ${result.data.length} bars after reconnect`);
                  })
                  .catch((err) => {
                    console.warn("[WS-Recovery] Failed to recover after reconnect:", err);
                  });
              }
            },
            onStreamStatus: (msg) => {
              if (!active) return;
              if (msg.interval === intervalRef.current) {
                if (msg.status === "live") {
                  setWsStatus("live");
                  markPerfOnce("ws.kline.live", {
                    symbol,
                    marketType,
                    exchange,
                    interval: msg.interval,
                    source: "stream-status",
                  });
                }
                if (msg.status === "reconnecting") setWsStatus("reconnecting");
              }
            },
            onBackfillCompleted: (msg) => {
              if (!active) return false;
              return handleBackfillCompleted(msg);
            },
            onKline: ({ interval: msgInterval, tick }) => {
              if (!active) return;
              const currentIntv = intervalRef.current;

              if (msgInterval === "1m" && tick.close != null) {
                updateRealtimePrice(tick.close);
              }

              if (msgInterval === currentIntv) {
                // The active interval shares one window store with the cache;
                // commitPatchedChartData applies the tick and keeps React
                // meta (barCount, coverage) in sync. Applying it twice via
                // patchCacheTick first would turn the commit into a NOOP.
                markPerfOnce("ws.kline.firstTick", { symbol, marketType, exchange, interval: currentIntv });
                commitPatchedChartData(symbol, currentIntv, [tick], { source: "kline-ws" });
                updateLastPrice(tick, currentIntv);
              } else {
                patchCacheTick(symbol, msgInterval, tick, { marketType, exchange });
              }
            },
            onParseError: (parseErr) => {
              console.error("WS parse failed:", parseErr);
            },
            onError: () => {
              if (!active) return;
              startPolling();
            },
            onClose: () => {
              if (!active) return;
              stopPing();
              startPolling();
              scheduleReconnect();
            },
          },
        );
        subscriptionRef.current = subscription;
      } catch (connectErr) {
        console.warn("WS initialization failed:", connectErr);
        startPolling();
        scheduleReconnect();
      }
    };

    connect();

    // Query-triggered repairs are intentionally internal backend work and may
    // not emit a browser completion event. Poll only exact ranges already
    // known to be pending; this never rescans or reloads the whole window.
    pendingRepairInterval = setInterval(() => {
      if (!active || pendingRepairPollingInFlight) return;
      const currentIntv = intervalRef.current;
      const series = { exchange, marketType, symbol, interval: currentIntv };
      if (seriesDataFeed.pendingRepairCount(series) === 0) return;
      pendingRepairPollingInFlight = true;
      void seriesDataFeed.pollPendingRepairs(series, { maxRequests: 2 })
        .finally(() => {
          pendingRepairPollingInFlight = false;
        });
    }, PENDING_REPAIR_POLL_INTERVAL_MS);

    heldWindowGapScanInterval = setInterval(() => {
      if (!active) return;
      const currentIntv = intervalRef.current;
      const series = { exchange, marketType, symbol, interval: currentIntv };
      const heldRows = getCacheRows(series);
      if (heldRows.length < 2) return;
      void seriesDataFeed.repairVisibleGaps(series, heldRows, null, {
        source: "ws-held-window-gap-scan",
      });
    }, HELD_WINDOW_GAP_SCAN_INTERVAL_MS);

    const initialFallbackTimer = setTimeout(() => {
      if (active && !pollInterval && !subscription?.isOpen()) {
        startPolling();
      }
    }, WS_INITIAL_FALLBACK_DELAY);

    return () => {
      active = false;
      clearTimeout(initialFallbackTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopPing();
      if (pollInterval) clearInterval(pollInterval);
      if (pendingRepairInterval) clearInterval(pendingRepairInterval);
      if (heldWindowGapScanInterval) clearInterval(heldWindowGapScanInterval);
      if (subscription) {
        subscription.close();
      }
      if (subscriptionRef.current === subscription) {
        subscriptionRef.current = null;
      }
    };
  }, [
    commitPatchedChartData,
    exchange,
    getCacheRows,
    handleBackfillCompleted,
    intervalRef,
    marketType,
    patchCacheTick,
    seriesDataFeed,
    setWsStatus,
    symbol,
    updateLastPrice,
    updateRealtimePrice,
  ]);

  useEffect(() => {
    subscriptionRef.current?.updateIntervals(trackedIntervals);
  }, [trackedIntervals]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let active = true;
    let hiddenAt: number | null = null;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      if (hiddenMs < TAB_RECOVERY_MIN_HIDDEN_MS) return;

      // Browsers throttle or drop WS ticks for hidden tabs while the backend
      // keeps ingesting, so the tail hole exists only client-side and no
      // backfill event will ever repair it. Pull the newest bars to catch up.
      const currentIntv = intervalRef.current;
      const intervalSecs = parseIntervalSeconds(currentIntv) || 60;
      const missedBars = Math.ceil(hiddenMs / 1000 / intervalSecs) + 5;
      const countBack = Math.max(50, Math.min(WS_RECOVERY_COUNT_BACK, missedBars));
      recordPerfEvent("ws.kline.tabRecovery", { symbol, marketType, exchange, interval: currentIntv, hiddenMs, countBack });
      seriesDataFeed.getBars(
        { exchange, marketType, symbol, interval: currentIntv },
        { countBack, source: "tab-visibility-recovery" },
      )
        .then((result) => {
          if (
            !active
            || result.stale
            || result.active === false
            || !result?.data?.length
          ) return;
          const latest = result.data.at(-1);
          if (latest) updateLastPrice(latest, currentIntv);
          void seriesDataFeed.repairVisibleGaps(
            { exchange, marketType, symbol, interval: currentIntv },
            result.data,
            null,
            { source: "tab-recovery-gap-planner" },
          );
          void seriesDataFeed.pollPendingRepairs(
            { exchange, marketType, symbol, interval: currentIntv },
            { force: true },
          );
        })
        .catch((err) => {
          console.warn("[TabRecovery] Tail catch-up failed:", err);
        });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [exchange, intervalRef, marketType, seriesDataFeed, symbol, updateLastPrice]);
}
