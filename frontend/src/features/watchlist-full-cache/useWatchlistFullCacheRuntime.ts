import { useEffect, useMemo, useRef } from "react";
import { fetchLatestKlines, getMultiStreamUrl } from "../../services/api.js";
import { isJsonRecord, parseKlineBar } from "../../services/apiPayloadParsers.js";
import type { TransportKlineBar } from "../../services/apiPayloadParsers.js";
import { symbolKey } from "../../utils/symbolKey.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  buildFullCachePreloadJobs,
  buildWatchlistFullSocketTargets,
  buildWatchlistFullCacheTargets,
} from "./watchlistFullCachePolicy.js";
import {
  ensureFullCacheEntry,
  markFullCacheError,
  mergeFullCacheRows,
  patchFullCacheRealtimeKline,
  setFullCacheEntryStatus,
} from "./watchlistFullCacheStore.js";
import type {
  FullCacheSocketTarget,
  FullCacheStatus,
  FullCacheTarget,
  FullCacheTargetOptions,
} from "./watchlistFullCacheTypes.js";

const PRELOAD_LIMIT = 500;
const MAX_PRELOAD_JOBS = 16;
const MAX_PRELOAD_CONCURRENCY = 2;

export interface UseWatchlistFullCacheRuntimeOptions extends FullCacheTargetOptions {
  enabled?: boolean;
}

export interface WatchlistFullCacheRuntime {
  targets: FullCacheTarget[];
}

function markTargetStatus(target: FullCacheSocketTarget, status: FullCacheStatus): void {
  target.intervals.forEach((interval) => {
    setFullCacheEntryStatus(target.symbolKey, interval, status);
  });
}

function closeAllSockets(sockets: Map<string, WebSocket>): void {
  for (const socket of sockets.values()) {
    try { socket.close(); } catch { /* ignore */ }
  }
  sockets.clear();
}

function parseSocketKline(value: unknown): KlineBar | null {
  const parsed = parseKlineBar(value, "watchlist-full-cache.websocket.data");
  const time = toEpochSeconds(parsed.time);
  return time == null ? null : { ...parsed, time };
}

function normalizeHttpRows(rows: TransportKlineBar[]): KlineBar[] {
  return rows.flatMap((row) => {
    const time = toEpochSeconds(row.time);
    return time == null ? [] : [{ ...row, time }];
  });
}

function attachSocketHandlers(
  socket: WebSocket,
  target: FullCacheSocketTarget,
  sockets: Map<string, WebSocket>,
): void {
  socket.onopen = () => {
    socket.send(JSON.stringify({ action: "subscribe", intervals: target.intervals }));
    markTargetStatus(target, "live");
  };

  socket.onmessage = (event) => {
    try {
      if (event.data === "pong") return;
      const message: unknown = JSON.parse(String(event.data));
      if (!isJsonRecord(message)
        || message.type !== "kline"
        || !message.data
        || typeof message.interval !== "string") return;
      const tick = parseSocketKline(message.data);
      if (!tick) return;
      patchFullCacheRealtimeKline(target.symbolKey, message.interval, tick, {
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
}: UseWatchlistFullCacheRuntimeOptions = {}): WatchlistFullCacheRuntime {
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());
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
        ...(currentExchange === undefined ? {} : { exchange: currentExchange }),
        ...(currentInterval === undefined ? {} : { interval: currentInterval }),
        ...(currentMarketType === undefined ? {} : { marketType: currentMarketType }),
        ...(currentSymbol === undefined ? {} : { symbol: currentSymbol }),
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
        ...(currentExchange === undefined ? {} : { exchange: currentExchange }),
        interval: null,
        ...(currentMarketType === undefined ? {} : { marketType: currentMarketType }),
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
        if (socket) attachSocketHandlers(socket, target, sockets);
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: "subscribe", intervals: target.intervals }));
        }
        continue;
      }

      let socket: WebSocket;
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

    async function runWorker(): Promise<void> {
      while (!controller.signal.aborted && index < jobs.length) {
        const job = jobs[index];
        index += 1;
        if (!job) continue;
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
          mergeFullCacheRows(job.symbolKey, job.interval, normalizeHttpRows(result?.data || []), {
            status: "warm",
            source: typeof result?.source === "string" ? result.source : "latest",
          });
        } catch (error) {
          if (!controller.signal.aborted) markFullCacheError(job.symbolKey, job.interval, error);
        }
      }
    }

    const workerCount = Math.min(MAX_PRELOAD_CONCURRENCY, jobs.length);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      void runWorker();
    }

    return () => controller.abort();
  }, [currentSymbolKey, enabled, targets]);

  return {
    targets,
  };
}
