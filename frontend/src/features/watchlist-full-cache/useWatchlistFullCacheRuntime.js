import { useEffect, useMemo, useRef } from "react";
import { fetchLatestKlines, getMultiStreamUrl } from "../../services/api";
import { symbolKey } from "../../utils/symbolKey";
import {
  buildFullCachePreloadJobs,
  buildWatchlistFullSocketTargets,
  buildWatchlistFullCacheTargets,
} from "./watchlistFullCachePolicy";
import {
  ensureFullCacheEntry,
  markFullCacheError,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  setFullCacheEntryStatus,
} from "./watchlistFullCacheStore";

const PRELOAD_LIMIT = 500;
const MAX_PRELOAD_JOBS = 16;
const MAX_PRELOAD_CONCURRENCY = 2;

function markTargetStatus(target, status) {
  target.intervals.forEach((interval) => {
    setFullCacheEntryStatus(target.symbolKey, interval, status);
  });
}

function closeAllSockets(sockets) {
  for (const socket of sockets.values()) {
    try { socket.close(); } catch { /* ignore */ }
  }
  sockets.clear();
}

function attachSocketHandlers(socket, target, sockets) {
  socket.onopen = () => {
    socket.send(JSON.stringify({ action: "subscribe", intervals: target.intervals }));
    markTargetStatus(target, "live");
  };

  socket.onmessage = (event) => {
    try {
      if (event.data === "pong") return;
      const message = JSON.parse(event.data);
      if (message.type !== "kline" || !message.data || !message.interval) return;
      patchFullCacheRealtimeKline(target.symbolKey, message.interval, message.data, {
        source: "ws",
      });
    } catch (error) {
      target.intervals.forEach((interval) => markFullCacheError(target.symbolKey, interval, error));
    }
  };

  socket.onerror = () => {
    target.intervals.forEach((interval) => setFullCacheEntryStatus(target.symbolKey, interval, "error"));
  };

  socket.onclose = () => {
    markTargetStatus(target, "stale");
    if (sockets.get(target.symbolKey) === socket) {
      sockets.delete(target.symbolKey);
    }
  };
}

export function useWatchlistFullCacheRuntime({
  watchlists = [],
  subscriptionTiers = {},
  exchangeCatalog = null,
  nativeIntervals = [],
  customIntervalRecords = [],
  currentSession = {},
  enabled = true,
} = {}) {
  const socketsRef = useRef(new Map());
  const {
    symbol: currentSymbol,
    exchange: currentExchange,
    marketType: currentMarketType,
    interval: currentInterval,
  } = currentSession;
  const currentSymbolKey = useMemo(
    () => symbolKey(currentSymbol, currentMarketType, currentExchange),
    [currentExchange, currentMarketType, currentSymbol],
  );

  const targets = useMemo(
    () => buildWatchlistFullCacheTargets({
      watchlists,
      subscriptionTiers,
      exchangeCatalog,
      nativeIntervals,
      customIntervalRecords,
      currentSession: {
        exchange: currentExchange,
        interval: currentInterval,
        marketType: currentMarketType,
        symbol: currentSymbol,
        symbolKey: currentSymbolKey,
      },
    }),
    [
      currentExchange,
      currentInterval,
      currentMarketType,
      currentSymbol,
      currentSymbolKey,
      customIntervalRecords,
      exchangeCatalog,
      nativeIntervals,
      subscriptionTiers,
      watchlists,
    ],
  );

  const socketTargets = useMemo(
    () => buildWatchlistFullSocketTargets({
      watchlists,
      subscriptionTiers,
      exchangeCatalog,
      nativeIntervals,
      customIntervalRecords,
      currentSession: {
        exchange: currentExchange,
        interval: null,
        marketType: currentMarketType,
        symbol: null,
        symbolKey: null,
      },
    }),
    [
      currentExchange,
      currentMarketType,
      customIntervalRecords,
      exchangeCatalog,
      nativeIntervals,
      subscriptionTiers,
      watchlists,
    ],
  );

  useEffect(() => {
    const sockets = socketsRef.current;
    return () => closeAllSockets(sockets);
  }, []);

  useEffect(() => {
    const sockets = socketsRef.current;
    if (!enabled) {
      closeAllSockets(sockets);
      return undefined;
    }

    const activeSymbolKeys = new Set(socketTargets.map((target) => target.symbolKey));

    for (const [symbolKeyValue, socket] of sockets.entries()) {
      if (!activeSymbolKeys.has(symbolKeyValue)) {
        try { socket.close(); } catch { /* ignore */ }
        sockets.delete(symbolKeyValue);
      }
    }

    for (const target of socketTargets) {
      target.intervals.forEach((interval) => {
        ensureFullCacheEntry(target.symbolKey, interval);
      });

      if (sockets.has(target.symbolKey)) {
        const socket = sockets.get(target.symbolKey);
        attachSocketHandlers(socket, target, sockets);
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: "subscribe", intervals: target.intervals }));
        }
        continue;
      }

      let socket = null;
      try {
        socket = new WebSocket(getMultiStreamUrl(target.symbol, target.marketType, target.exchange));
      } catch (error) {
        target.intervals.forEach((interval) => markFullCacheError(target.symbolKey, interval, error));
        continue;
      }

      sockets.set(target.symbolKey, socket);
      attachSocketHandlers(socket, target, sockets);
    }

    return undefined;
  }, [enabled, socketTargets]);

  useEffect(() => {
    if (!enabled || targets.length === 0) return undefined;
    const controller = new AbortController();
    const jobs = buildFullCachePreloadJobs(targets, {
      currentSymbolKey,
      maxJobs: MAX_PRELOAD_JOBS,
    });
    let index = 0;

    async function runWorker() {
      while (!controller.signal.aborted && index < jobs.length) {
        const job = jobs[index];
        index += 1;
        setFullCacheEntryStatus(job.symbolKey, job.interval, "loading", { source: "latest" });
        try {
          const result = await fetchLatestKlines(
            job.symbol,
            job.interval,
            PRELOAD_LIMIT,
            job.marketType,
            job.exchange,
            "watchlist-full-cache",
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          mergeFullCacheRows(job.symbolKey, job.interval, result?.data || [], {
            status: "warm",
            source: result?.source || "latest",
          });
        } catch (error) {
          if (!controller.signal.aborted) markFullCacheError(job.symbolKey, job.interval, error);
        }
      }
    }

    const workerCount = Math.min(MAX_PRELOAD_CONCURRENCY, jobs.length);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      runWorker();
    }

    return () => controller.abort();
  }, [currentSymbolKey, enabled, targets]);

  return {
    targets,
  };
}
