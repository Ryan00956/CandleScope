import { useCallback, useEffect, useRef } from "react";
import {
  fetchKlinesHistory,
  fetchLatestKlines,
  getMultiStreamUrl,
} from "../services/api";

const WS_RECONNECT_BASE_DELAY = 2_000;
const WS_RECONNECT_MAX_DELAY = 60_000;
const WS_MAX_RECONNECT_ATTEMPTS = 20;
const WS_PING_INTERVAL = 30_000;
const WS_INITIAL_FALLBACK_DELAY = 4_000;
const POLLING_INTERVAL_MS = 1_000;

export function useKlineStreamRuntime({
  symbol,
  exchange,
  marketType,
  trackedIntervals,
  intervalRef,
  getIntervalDays,
  commitMergedChartData,
  commitPatchedChartData,
  patchCacheTick,
  updateLastPrice,
  updateRealtimePrice,
  handleBackfillCompleted,
  setWsStatus,
}) {
  const socketRef = useRef(null);
  const liveSubscribedIntervalsRef = useRef(new Set());
  const trackedIntervalsRef = useRef(trackedIntervals);

  useEffect(() => {
    trackedIntervalsRef.current = trackedIntervals;
  }, [trackedIntervals]);

  const syncSocketSubscriptions = useCallback((socket, desiredIntervals) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const desired = new Set(desiredIntervals);
    const active = liveSubscribedIntervalsRef.current;
    const toSubscribe = desiredIntervals.filter((intv) => !active.has(intv));
    const toUnsubscribe = Array.from(active).filter((intv) => !desired.has(intv));

    if (toSubscribe.length > 0) {
      socket.send(JSON.stringify({
        action: "subscribe",
        intervals: toSubscribe,
      }));
      toSubscribe.forEach((intv) => active.add(intv));
    }

    if (toUnsubscribe.length > 0) {
      socket.send(JSON.stringify({
        action: "unsubscribe",
        intervals: toUnsubscribe,
      }));
      toUnsubscribe.forEach((intv) => active.delete(intv));
    }
  }, []);

  useEffect(() => {
    let active = true;
    let socket = null;
    let reconnectTimer = null;
    let pingTimer = null;
    let pollInterval = null;
    let pollingInFlight = false;
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
        if (socket && socket.readyState === WebSocket.OPEN) {
          try { socket.send("ping"); } catch { /* ignore */ }
        }
      }, WS_PING_INTERVAL);
    };

    const startPolling = () => {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (!active) return;
        if (pollingInFlight) return;
        pollingInFlight = true;
        try {
          const currentIntv = intervalRef.current;
          const result = await fetchLatestKlines(symbol, currentIntv, 2, marketType, exchange);
          if (!result?.data?.length) return;

          commitPatchedChartData(symbol, currentIntv, result.data, { source: "polling-latest" });
          const latestTick = result.data[result.data.length - 1];
          updateLastPrice(latestTick, currentIntv);
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

      if (socket) {
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }

      try {
        const url = getMultiStreamUrl(symbol, marketType, exchange);
        socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;

          const isReconnection = reconnectAttempts > 0;
          reconnectDelay = WS_RECONNECT_BASE_DELAY;
          reconnectAttempts = 0;

          liveSubscribedIntervalsRef.current = new Set();
          syncSocketSubscriptions(socket, trackedIntervalsRef.current);
          setWsStatus("live");

          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }

          startPing();

          if (isReconnection) {
            const currentIntv = intervalRef.current;
            const days = getIntervalDays(currentIntv, exchange);
            console.log(`[WS-Recovery] Reconnected, reloading full history for ${symbol}@${currentIntv}`);
            fetchKlinesHistory(symbol, currentIntv, days, marketType, exchange)
              .then((result) => {
                if (!active || !result?.data?.length) return;
                commitMergedChartData(symbol, currentIntv, result.data, { source: "ws-reconnect-history" });
                const latest = result.data[result.data.length - 1];
                updateLastPrice(latest, currentIntv);
                console.log(`[WS-Recovery] Reloaded ${result.data.length} bars after reconnect`);
              })
              .catch((err) => {
                console.warn("[WS-Recovery] Failed to recover after reconnect:", err);
              });
          }
        };

        socket.onmessage = (event) => {
          if (!active) return;
          try {
            if (event.data === "pong") return;

            const msg = JSON.parse(event.data);

            if (msg.type === "stream_status") {
              if (msg.interval === intervalRef.current) {
                if (msg.status === "live") setWsStatus("live");
                if (msg.status === "reconnecting") setWsStatus("reconnecting");
              }
              return;
            }

            if (
              msg.type === "subscribed" ||
              msg.type === "connected" ||
              msg.type === "warning" ||
              msg.type === "error"
            ) {
              return;
            }

            if (handleBackfillCompleted(msg)) return;

            if (msg.type !== "kline" || !msg.data) return;

            const msgInterval = msg.interval;
            const tick = msg.data;
            const currentIntv = intervalRef.current;

            if (msgInterval === "1m") {
              updateRealtimePrice(tick.close);
            }

            patchCacheTick(symbol, msgInterval, tick, { marketType, exchange });

            if (msgInterval === currentIntv) {
              commitPatchedChartData(symbol, currentIntv, [tick], { source: "kline-ws" });
              updateLastPrice(tick, currentIntv);
            }
          } catch (parseErr) {
            console.error("WS parse failed:", parseErr);
          }
        };

        socket.onerror = () => {
          if (!active) return;
          startPolling();
        };

        socket.onclose = () => {
          if (!active) return;
          stopPing();
          startPolling();
          scheduleReconnect();
        };
      } catch (connectErr) {
        console.warn("WS initialization failed:", connectErr);
        startPolling();
        scheduleReconnect();
      }
    };

    connect();

    const initialFallbackTimer = setTimeout(() => {
      if (active && !pollInterval && (!socket || socket.readyState !== WebSocket.OPEN)) {
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
      if (socket) {
        try { socket.close(); } catch { /* ignore */ }
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      liveSubscribedIntervalsRef.current = new Set();
    };
  }, [
    commitMergedChartData,
    commitPatchedChartData,
    exchange,
    getIntervalDays,
    handleBackfillCompleted,
    intervalRef,
    marketType,
    patchCacheTick,
    setWsStatus,
    symbol,
    syncSocketSubscriptions,
    updateLastPrice,
    updateRealtimePrice,
  ]);

  useEffect(() => {
    syncSocketSubscriptions(socketRef.current, trackedIntervals);
  }, [syncSocketSubscriptions, trackedIntervals]);
}
