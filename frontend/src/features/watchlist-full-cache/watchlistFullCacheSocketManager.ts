import { getMultiStreamUrl } from "../../services/api.js";
import { isJsonRecord, parseKlineBar } from "../../services/apiPayloadParsers.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  markFullCacheError,
  patchFullCacheRealtimeKline,
  setFullCacheEntryStatus,
  setFullCacheEntrySubscribed,
} from "./watchlistFullCacheStore.js";
import type {
  FullCacheSocketTarget,
  FullCacheStatus,
} from "./watchlistFullCacheTypes.js";

const SOCKET_OPEN = 1;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.25;

export interface WatchlistFullCacheSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

type TimerHandle = unknown;

export interface WatchlistFullCacheSocketManagerOptions {
  createSocket?: (target: FullCacheSocketTarget) => WatchlistFullCacheSocketLike;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  random?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface WatchlistFullCacheSocketManager {
  syncTargets(targets: FullCacheSocketTarget[], enabled?: boolean): void;
  dispose(): void;
}

interface SocketConnection {
  target: FullCacheSocketTarget;
  socket: WatchlistFullCacheSocketLike | null;
  generation: number;
  reconnectAttempt: number;
  reconnectTimer: TimerHandle | null;
}

function normalizeTarget(target: FullCacheSocketTarget): FullCacheSocketTarget {
  return {
    ...target,
    intervals: Array.from(new Set(target.intervals)),
  };
}

function sameTransportIdentity(
  left: FullCacheSocketTarget,
  right: FullCacheSocketTarget,
): boolean {
  return left.symbol === right.symbol
    && left.marketType === right.marketType
    && left.exchange === right.exchange;
}

function sameIntervals(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((interval, index) => interval === right[index]);
}

function addedIntervals(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((interval) => !previousSet.has(interval));
}

function markTargetStatus(target: FullCacheSocketTarget, status: FullCacheStatus): void {
  target.intervals.forEach((interval) => {
    setFullCacheEntryStatus(target.symbolKey, interval, status);
  });
}

function markTargetSubscribed(target: FullCacheSocketTarget, subscribed: boolean): void {
  target.intervals.forEach((interval) => {
    setFullCacheEntrySubscribed(target.symbolKey, interval, subscribed);
  });
}

function markRemovedIntervalsUnsubscribed(
  previous: FullCacheSocketTarget,
  next: FullCacheSocketTarget,
): string[] {
  const nextIntervals = new Set(next.intervals);
  const removedIntervals = previous.intervals.filter((interval) => !nextIntervals.has(interval));
  removedIntervals.forEach((interval) => {
    setFullCacheEntrySubscribed(previous.symbolKey, interval, false);
    setFullCacheEntryStatus(previous.symbolKey, interval, "stale");
  });
  return removedIntervals;
}

function parseSocketKline(value: unknown): KlineBar | null {
  const parsed = parseKlineBar(value, "watchlist-full-cache.websocket.data");
  const time = toEpochSeconds(parsed.time);
  return time == null ? null : { ...parsed, time };
}

export function createWatchlistFullCacheSocketManager(
  options: WatchlistFullCacheSocketManagerOptions = {},
): WatchlistFullCacheSocketManager {
  const createSocket = options.createSocket || ((target: FullCacheSocketTarget) => (
    new WebSocket(
      getMultiStreamUrl(target.symbol, target.marketType, target.exchange),
    ) as unknown as WatchlistFullCacheSocketLike
  ));
  const schedule = options.schedule || ((callback: () => void, delayMs: number) => (
    setTimeout(callback, delayMs)
  ));
  const cancel = options.cancel || ((handle: TimerHandle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const random = options.random || Math.random;
  const reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS);
  const reconnectMaxMs = Math.max(
    reconnectBaseMs,
    options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
  );
  const connections = new Map<string, SocketConnection>();
  let disposed = false;

  function isCurrent(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
  ): boolean {
    return !disposed
      && connections.get(connection.target.symbolKey) === connection
      && connection.socket === socket
      && connection.generation === generation;
  }

  function reconnectDelay(attempt: number): number {
    const exponential = Math.min(
      reconnectMaxMs,
      reconnectBaseMs * (2 ** Math.min(attempt, 16)),
    );
    const jitterSample = Math.min(1, Math.max(0, Number(random()) || 0));
    return Math.min(
      reconnectMaxMs,
      Math.round(exponential * (1 + jitterSample * RECONNECT_JITTER_RATIO)),
    );
  }

  function scheduleReconnect(connection: SocketConnection): void {
    if (disposed
      || connections.get(connection.target.symbolKey) !== connection
      || connection.reconnectTimer != null) return;
    const delayMs = reconnectDelay(connection.reconnectAttempt);
    connection.reconnectAttempt += 1;
    connection.reconnectTimer = schedule(() => {
      connection.reconnectTimer = null;
      if (disposed || connections.get(connection.target.symbolKey) !== connection) return;
      openSocket(connection);
    }, delayMs);
  }

  function handleSocketFailure(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    error: unknown,
  ): void {
    if (!isCurrent(connection, socket, generation)) return;
    connection.target.intervals.forEach((interval) => {
      markFullCacheError(connection.target.symbolKey, interval, error);
    });
    connection.socket = null;
    try { socket.close(); } catch { /* ignore */ }
    scheduleReconnect(connection);
  }

  function sendSubscription(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    intervals: string[] = connection.target.intervals,
  ): void {
    if (!isCurrent(connection, socket, generation)) return;
    try {
      socket.send(JSON.stringify({
        action: "subscribe",
        intervals,
      }));
      markTargetStatus(connection.target, "live");
    } catch (error) {
      handleSocketFailure(connection, socket, generation, error);
    }
  }

  function openSocket(connection: SocketConnection): void {
    if (disposed || connections.get(connection.target.symbolKey) !== connection) return;
    const generation = connection.generation + 1;
    connection.generation = generation;

    let socket: WatchlistFullCacheSocketLike;
    try {
      socket = createSocket(connection.target);
    } catch (error) {
      connection.target.intervals.forEach((interval) => {
        markFullCacheError(connection.target.symbolKey, interval, error);
      });
      scheduleReconnect(connection);
      return;
    }

    connection.socket = socket;
    socket.onopen = () => sendSubscription(connection, socket, generation);
    socket.onmessage = (event) => {
      if (!isCurrent(connection, socket, generation)) return;
      try {
        if (event.data === "pong") return;
        const message: unknown = JSON.parse(String(event.data));
        if (!isJsonRecord(message)
          || message.type !== "kline"
          || !message.data
          || typeof message.interval !== "string"
          || !connection.target.intervals.includes(message.interval)) return;
        const tick = parseSocketKline(message.data);
        if (!tick) return;
        // An open TCP/WebSocket handshake does not prove that the stream is
        // healthy. Reset backoff only after the server delivers a valid event.
        connection.reconnectAttempt = 0;
        patchFullCacheRealtimeKline(
          connection.target.symbolKey,
          message.interval,
          tick,
          { source: "ws" },
        );
      } catch (error) {
        connection.target.intervals.forEach((interval) => {
          markFullCacheError(connection.target.symbolKey, interval, error);
        });
      }
    };
    socket.onerror = () => {
      handleSocketFailure(
        connection,
        socket,
        generation,
        new Error("Watchlist full-cache WebSocket error"),
      );
    };
    socket.onclose = () => {
      if (!isCurrent(connection, socket, generation)) return;
      connection.socket = null;
      markTargetStatus(connection.target, "stale");
      scheduleReconnect(connection);
    };
  }

  function removeConnection(symbolKey: string): void {
    const connection = connections.get(symbolKey);
    if (!connection) return;
    connections.delete(symbolKey);
    if (connection.reconnectTimer != null) {
      cancel(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    markTargetSubscribed(connection.target, false);
    markTargetStatus(connection.target, "stale");
    const socket = connection.socket;
    connection.socket = null;
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  return {
    syncTargets(targets: FullCacheSocketTarget[], enabled = true): void {
      if (disposed) return;
      if (!enabled) {
        for (const symbolKey of Array.from(connections.keys())) removeConnection(symbolKey);
        return;
      }

      const normalizedTargets = new Map(
        targets.map((target) => {
          const normalized = normalizeTarget(target);
          return [normalized.symbolKey, normalized] as const;
        }),
      );

      for (const symbolKey of Array.from(connections.keys())) {
        if (!normalizedTargets.has(symbolKey)) removeConnection(symbolKey);
      }

      for (const target of normalizedTargets.values()) {
        const current = connections.get(target.symbolKey);
        if (current && !sameTransportIdentity(current.target, target)) {
          removeConnection(target.symbolKey);
        }

        const existing = connections.get(target.symbolKey);
        if (existing) {
          const previousTarget = existing.target;
          const intervalsChanged = !sameIntervals(previousTarget.intervals, target.intervals);
          const added = addedIntervals(previousTarget.intervals, target.intervals);
          const removedIntervals = markRemovedIntervalsUnsubscribed(previousTarget, target);
          const currentSocket = existing.socket;
          existing.target = target;
          if (removedIntervals.length > 0 && currentSocket?.readyState === SOCKET_OPEN) {
            try {
              currentSocket.send(JSON.stringify({
                action: "unsubscribe",
                intervals: removedIntervals,
              }));
            } catch (error) {
              handleSocketFailure(existing, currentSocket, existing.generation, error);
            }
          }
          markTargetSubscribed(target, true);
          if (intervalsChanged && added.length > 0 && existing.socket?.readyState === SOCKET_OPEN) {
            sendSubscription(existing, existing.socket, existing.generation, added);
          } else if (!existing.socket && existing.reconnectTimer == null) {
            openSocket(existing);
          }
          continue;
        }

        markTargetSubscribed(target, true);
        const connection: SocketConnection = {
          target,
          socket: null,
          generation: 0,
          reconnectAttempt: 0,
          reconnectTimer: null,
        };
        connections.set(target.symbolKey, connection);
        openSocket(connection);
      }
    },

    dispose(): void {
      if (disposed) return;
      for (const symbolKey of Array.from(connections.keys())) removeConnection(symbolKey);
      disposed = true;
    },
  };
}
