import { getMultiStreamUrl } from "../../services/api.js";
import { isJsonRecord, parseKlineBar } from "../../services/apiPayloadParsers.js";
import { canonicalizeIntervalValue } from "../../utils/intervals.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import {
  getFullCacheEntry,
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
const DEFAULT_SUBSCRIPTION_RETRY_BASE_MS = 1_000;
const DEFAULT_SUBSCRIPTION_RETRY_LIMIT = 3;
const RECONNECT_JITTER_RATIO = 0.25;
const PERMANENT_SUBSCRIPTION_FAILURE_CODES = new Set([
  "invalid_interval",
  "unknown_exchange",
  "kline_channel_unavailable",
  "purpose_unsupported",
  "no_native_intervals",
  "no_exact_base",
]);

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
  subscriptionRetryBaseMs?: number;
  subscriptionRetryLimit?: number;
}

export interface WatchlistFullCacheSocketManager {
  syncTargets(targets: FullCacheSocketTarget[], enabled?: boolean): void;
  dispose(): void;
}

interface SocketConnection {
  target: FullCacheSocketTarget;
  socket: WatchlistFullCacheSocketLike | null;
  generation: number;
  requestSequence: number;
  reconnectAttempt: number;
  reconnectTimer: TimerHandle | null;
  activeIntervals: Set<string>;
  rejectedIntervals: Set<string>;
  subscriptionRetryAttempts: Map<string, number>;
  subscriptionRetryTimers: Map<string, TimerHandle>;
}

function normalizeTarget(target: FullCacheSocketTarget): FullCacheSocketTarget {
  const intervals = target.intervals
    .map((interval) => canonicalizeIntervalValue(interval))
    .filter((interval): interval is string => Boolean(interval));
  return {
    ...target,
    intervals: Array.from(new Set(intervals)),
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

function markIntervalsPending(target: FullCacheSocketTarget, intervals: readonly string[]): void {
  intervals.forEach((interval) => {
    setFullCacheEntrySubscribed(target.symbolKey, interval, false);
    setFullCacheEntryStatus(target.symbolKey, interval, "loading", { source: "ws" });
  });
}

function normalizedMessageIntervals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const intervals = value
    .map((interval) => canonicalizeIntervalValue(interval))
    .filter((interval): interval is string => Boolean(interval));
  return Array.from(new Set(intervals));
}

interface SubscriptionFailure {
  code: string;
  interval: string;
  message: string;
}

function subscriptionFailures(value: unknown): SubscriptionFailure[] {
  if (!Array.isArray(value)) return [];
  const failures: SubscriptionFailure[] = [];
  value.forEach((candidate) => {
    if (!isJsonRecord(candidate)) return;
    const interval = canonicalizeIntervalValue(candidate.interval);
    if (!interval) return;
    const code = typeof candidate.code === "string" ? candidate.code : "subscription_failed";
    const detail = typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.error === "string"
        ? candidate.error
        : "Interval subscription failed";
    failures.push({ code, interval, message: `${code}: ${detail}` });
  });
  return failures;
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

function socketEventType(message: Record<string, unknown>): string | null {
  if (typeof message.event_type === "string") return message.event_type;
  if (typeof message.eventType === "string") return message.eventType;
  return null;
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
  const subscriptionRetryBaseMs = Math.max(
    1,
    options.subscriptionRetryBaseMs ?? DEFAULT_SUBSCRIPTION_RETRY_BASE_MS,
  );
  const subscriptionRetryLimit = Math.max(
    0,
    Math.floor(options.subscriptionRetryLimit ?? DEFAULT_SUBSCRIPTION_RETRY_LIMIT),
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

  function cancelSubscriptionRetry(connection: SocketConnection, interval: string): void {
    const handle = connection.subscriptionRetryTimers.get(interval);
    if (handle == null) return;
    cancel(handle);
    connection.subscriptionRetryTimers.delete(interval);
  }

  function cancelAllSubscriptionRetries(connection: SocketConnection): void {
    for (const handle of connection.subscriptionRetryTimers.values()) cancel(handle);
    connection.subscriptionRetryTimers.clear();
  }

  function handleSocketFailure(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    error: unknown,
  ): void {
    if (!isCurrent(connection, socket, generation)) return;
    cancelAllSubscriptionRetries(connection);
    markTargetSubscribed(connection.target, false);
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
    const requestedIntervals = intervals
      .map((interval) => canonicalizeIntervalValue(interval))
      .filter((interval): interval is string => (
        Boolean(interval)
        && connection.target.intervals.includes(interval)
        && !connection.activeIntervals.has(interval)
        && !connection.rejectedIntervals.has(interval)
      ));
    if (requestedIntervals.length === 0) return;
    connection.requestSequence += 1;
    const requestId = `watchlist-${generation}-${connection.requestSequence}`;
    try {
      socket.send(JSON.stringify({
        action: "subscribe",
        intervals: requestedIntervals,
        request_id: requestId,
      }));
      markIntervalsPending(connection.target, requestedIntervals);
    } catch (error) {
      handleSocketFailure(connection, socket, generation, error);
    }
  }

  function sendUnsubscription(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    intervals: string[],
  ): void {
    if (!isCurrent(connection, socket, generation)) return;
    const requestedIntervals = Array.from(new Set(
      intervals
        .map((interval) => canonicalizeIntervalValue(interval))
        .filter((interval): interval is string => Boolean(interval)),
    ));
    if (requestedIntervals.length === 0) return;
    requestedIntervals.forEach((interval) => connection.activeIntervals.delete(interval));
    requestedIntervals.forEach((interval) => {
      cancelSubscriptionRetry(connection, interval);
      connection.subscriptionRetryAttempts.delete(interval);
      connection.rejectedIntervals.delete(interval);
    });
    connection.requestSequence += 1;
    try {
      socket.send(JSON.stringify({
        action: "unsubscribe",
        intervals: requestedIntervals,
        request_id: `watchlist-${generation}-${connection.requestSequence}`,
      }));
    } catch (error) {
      handleSocketFailure(connection, socket, generation, error);
    }
  }

  function scheduleSubscriptionRetry(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    interval: string,
  ): void {
    if (!isCurrent(connection, socket, generation)
      || connection.activeIntervals.has(interval)
      || connection.rejectedIntervals.has(interval)
      || connection.subscriptionRetryTimers.has(interval)) return;
    const failures = (connection.subscriptionRetryAttempts.get(interval) || 0) + 1;
    connection.subscriptionRetryAttempts.set(interval, failures);
    const exhaustedFastRetries = failures > subscriptionRetryLimit;
    if (exhaustedFastRetries) {
      // A transient ACK failure must not become a permanent rejection while
      // the socket remains open. After the bounded fast-retry burst, keep a
      // low-frequency recovery probe alive until success, removal, or close.
      connection.subscriptionRetryAttempts.set(interval, subscriptionRetryLimit);
    }
    const delayMs = exhaustedFastRetries
      ? reconnectMaxMs
      : Math.min(
        reconnectMaxMs,
        subscriptionRetryBaseMs * (2 ** Math.min(failures - 1, 16)),
      );
    const handle = schedule(() => {
      connection.subscriptionRetryTimers.delete(interval);
      if (!isCurrent(connection, socket, generation)
        || socket.readyState !== SOCKET_OPEN
        || !connection.target.intervals.includes(interval)
        || connection.activeIntervals.has(interval)
        || connection.rejectedIntervals.has(interval)) return;
      sendSubscription(connection, socket, generation, [interval]);
    }, delayMs);
    connection.subscriptionRetryTimers.set(interval, handle);
  }

  function markSubscriptionFailure(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    failure: SubscriptionFailure,
  ): void {
    if (!connection.target.intervals.includes(failure.interval)) return;
    connection.activeIntervals.delete(failure.interval);
    setFullCacheEntrySubscribed(connection.target.symbolKey, failure.interval, false);
    markFullCacheError(
      connection.target.symbolKey,
      failure.interval,
      new Error(failure.message),
    );
    if (PERMANENT_SUBSCRIPTION_FAILURE_CODES.has(failure.code)) {
      cancelSubscriptionRetry(connection, failure.interval);
      connection.rejectedIntervals.add(failure.interval);
      return;
    }
    scheduleSubscriptionRetry(connection, socket, generation, failure.interval);
  }

  function handleControlMessage(
    connection: SocketConnection,
    socket: WatchlistFullCacheSocketLike,
    generation: number,
    message: Record<string, unknown>,
  ): void {
    const messageType = message.type;
    if (messageType !== "subscribed"
      && messageType !== "unsubscribed"
      && messageType !== "warning") return;

    const failures = subscriptionFailures(message.failed);
    if (messageType === "warning") {
      failures.forEach((failure) => {
        if (!connection.target.intervals.includes(failure.interval)) return;
        markFullCacheError(
          connection.target.symbolKey,
          failure.interval,
          new Error(failure.message),
        );
      });
      return;
    }

    const acknowledged = normalizedMessageIntervals(message.intervals);
    const requested = normalizedMessageIntervals(message.requested_intervals);
    const hasActiveSnapshot = Array.isArray(message.active_intervals);
    if (hasActiveSnapshot) {
      connection.activeIntervals = new Set(normalizedMessageIntervals(message.active_intervals));
    } else if (messageType === "subscribed") {
      acknowledged.forEach((interval) => connection.activeIntervals.add(interval));
    } else {
      acknowledged.forEach((interval) => connection.activeIntervals.delete(interval));
    }

    connection.target.intervals.forEach((interval) => {
      if (connection.activeIntervals.has(interval)) {
        cancelSubscriptionRetry(connection, interval);
        connection.subscriptionRetryAttempts.delete(interval);
        connection.rejectedIntervals.delete(interval);
        setFullCacheEntrySubscribed(connection.target.symbolKey, interval, true);
        const current = getFullCacheEntry(connection.target.symbolKey, interval);
        if (current?.status !== "live") {
          setFullCacheEntryStatus(connection.target.symbolKey, interval, "warm", {
            source: "ws",
            lastError: null,
          });
        }
        return;
      }
      const failure = failures.find((candidate) => candidate.interval === interval);
      if (messageType === "subscribed" && failure) {
        markSubscriptionFailure(connection, socket, generation, failure);
        return;
      }
      if (messageType === "subscribed" && requested.includes(interval)) {
        markSubscriptionFailure(connection, socket, generation, {
          code: "subscription_not_acknowledged",
          interval,
          message: "subscription_not_acknowledged: Interval missing from active subscription ACK",
        });
        return;
      }
      if (hasActiveSnapshot || acknowledged.includes(interval)) {
        setFullCacheEntrySubscribed(connection.target.symbolKey, interval, false);
        const current = getFullCacheEntry(connection.target.symbolKey, interval);
        if (current?.status !== "error") {
          setFullCacheEntryStatus(connection.target.symbolKey, interval, "stale");
        }
      }
    });
  }

  function openSocket(connection: SocketConnection): void {
    if (disposed || connections.get(connection.target.symbolKey) !== connection) return;
    const generation = connection.generation + 1;
    connection.generation = generation;
    connection.activeIntervals.clear();
    connection.rejectedIntervals.clear();
    connection.subscriptionRetryAttempts.clear();
    cancelAllSubscriptionRetries(connection);
    markTargetSubscribed(connection.target, false);

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
        if (!isJsonRecord(message)) return;
        if (message.type !== "kline") {
          handleControlMessage(connection, socket, generation, message);
          return;
        }
        const interval = canonicalizeIntervalValue(message.interval);
        if (!message.data || !interval || !connection.target.intervals.includes(interval)) return;
        const tick = parseSocketKline(message.data);
        if (!tick) return;
        // An open TCP/WebSocket handshake does not prove that the stream is
        // healthy. Reset backoff only after the server delivers a valid event.
        connection.reconnectAttempt = 0;
        connection.activeIntervals.add(interval);
        cancelSubscriptionRetry(connection, interval);
        connection.subscriptionRetryAttempts.delete(interval);
        connection.rejectedIntervals.delete(interval);
        setFullCacheEntrySubscribed(connection.target.symbolKey, interval, true);
        patchFullCacheRealtimeKline(
          connection.target.symbolKey,
          interval,
          tick,
          { source: "ws", eventType: socketEventType(message) },
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
      connection.activeIntervals.clear();
      cancelAllSubscriptionRetries(connection);
      markTargetSubscribed(connection.target, false);
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
    cancelAllSubscriptionRetries(connection);
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
          removedIntervals.forEach((interval) => {
            cancelSubscriptionRetry(existing, interval);
            existing.subscriptionRetryAttempts.delete(interval);
            existing.rejectedIntervals.delete(interval);
            existing.activeIntervals.delete(interval);
          });
          added.forEach((interval) => {
            cancelSubscriptionRetry(existing, interval);
            existing.subscriptionRetryAttempts.delete(interval);
            existing.rejectedIntervals.delete(interval);
          });
          const currentSocket = existing.socket;
          existing.target = target;
          if (removedIntervals.length > 0 && currentSocket?.readyState === SOCKET_OPEN) {
            sendUnsubscription(
              existing,
              currentSocket,
              existing.generation,
              removedIntervals,
            );
          }
          if (intervalsChanged && added.length > 0 && existing.socket?.readyState === SOCKET_OPEN) {
            sendSubscription(existing, existing.socket, existing.generation, added);
          } else if (!existing.socket && existing.reconnectTimer == null) {
            openSocket(existing);
          }
          continue;
        }

        markIntervalsPending(target, target.intervals);
        const connection: SocketConnection = {
          target,
          socket: null,
          generation: 0,
          requestSequence: 0,
          reconnectAttempt: 0,
          reconnectTimer: null,
          activeIntervals: new Set(),
          rejectedIntervals: new Set(),
          subscriptionRetryAttempts: new Map(),
          subscriptionRetryTimers: new Map(),
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
