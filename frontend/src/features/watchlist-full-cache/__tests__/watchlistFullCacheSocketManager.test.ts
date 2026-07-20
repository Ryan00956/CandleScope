import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchlistFullCacheSocketManager,
} from "../watchlistFullCacheSocketManager.js";
import type {
  WatchlistFullCacheSocketLike,
} from "../watchlistFullCacheSocketManager.js";
import {
  getFullCacheEntry,
  mergeFullCacheRows,
  resetWatchlistFullCache,
} from "../watchlistFullCacheStore.js";
import type { FullCacheSocketTarget } from "../watchlistFullCacheTypes.js";
import {
  epochSeconds,
  mustBeDefined,
} from "../../../test/testHelpers.js";

class FakeSocket implements WatchlistFullCacheSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

interface FakeTimer {
  id: number;
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  let nextId = 1;
  return {
    timers,
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback, delayMs, cancelled: false });
      return id;
    },
    cancel(handle: unknown): void {
      const timer = timers.find((candidate) => candidate.id === handle);
      if (timer) timer.cancelled = true;
    },
    runNext(): FakeTimer {
      const timer = mustBeDefined(timers.find((candidate) => !candidate.cancelled));
      timer.cancelled = true;
      timer.callback();
      return timer;
    },
    pending(): FakeTimer[] {
      return timers.filter((timer) => !timer.cancelled);
    },
  };
}

const TARGET: FullCacheSocketTarget = {
  symbolKey: "binance:spot:BTCUSDT",
  symbol: "BTCUSDT",
  exchange: "binance",
  marketType: "spot",
  intervals: ["1s", "1m"],
};

function sentMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function requestIdAt(socket: FakeSocket, index: number): string {
  const requestId = mustBeDefined(sentMessages(socket)[index]).request_id;
  if (typeof requestId !== "string") {
    throw new TypeError("Expected a string request_id");
  }
  return requestId;
}

function emitSubscribed(
  socket: FakeSocket,
  requestId: string,
  intervals: string[],
  activeIntervals: string[] = intervals,
  failed: unknown[] = [],
): void {
  socket.emitMessage(JSON.stringify({
    type: "subscribed",
    request_id: requestId,
    requested_intervals: [...intervals, ...failed.flatMap((item) => (
      item && typeof item === "object" && "interval" in item
        ? [String((item as { interval: unknown }).interval)]
        : []
    ))],
    intervals,
    failed,
    active_intervals: activeIntervals,
  }));
}

function emitKline(socket: FakeSocket, interval: string, time = 1): void {
  socket.emitMessage(JSON.stringify({
    type: "kline",
    interval,
    data: { time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  }));
}

test("socket manager waits for ACK and reconnects with backoff", () => {
  resetWatchlistFullCache();
  const sockets: FakeSocket[] = [];
  const timers = createFakeTimers();
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
    random: () => 0,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });

  manager.syncTargets([TARGET]);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "loading");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, false);
  const first = mustBeDefined(sockets[0]);
  first.emitOpen();
  assert.deepEqual(JSON.parse(mustBeDefined(first.sent[0])), {
    action: "subscribe",
    intervals: ["1s", "1m"],
    request_id: "watchlist-1-1",
  });
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "loading");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, false);

  emitSubscribed(first, requestIdAt(first, 0), ["1s", "1m"]);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "warm");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, true);
  emitKline(first, "1s");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "live");

  first.emitClose();
  const stale = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s"));
  assert.equal(stale.status, "stale");
  assert.equal(stale.subscribed, false);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.delayMs, 1_000);

  timers.runNext();
  const second = mustBeDefined(sockets[1]);
  second.emitOpen();
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "loading");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, false);
  emitSubscribed(second, requestIdAt(second, 0), ["1s", "1m"]);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "warm");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, true);

  second.onerror?.();
  assert.equal(second.closed, true);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "error");
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.delayMs, 2_000);
  timers.runNext();
  const third = mustBeDefined(sockets[2]);
  third.emitOpen();
  emitSubscribed(third, requestIdAt(third, 0), ["1s", "1m"]);
  emitKline(third, "1m");
  third.onerror?.();
  assert.equal(timers.pending()[0]?.delayMs, 1_000);

  manager.dispose();
  assert.equal(third.closed, true);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, false);
});

test("late events from an obsolete socket generation cannot stale the replacement", () => {
  resetWatchlistFullCache();
  const sockets: FakeSocket[] = [];
  const timers = createFakeTimers();
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
    random: () => 0,
  });

  manager.syncTargets([TARGET]);
  const obsolete = mustBeDefined(sockets[0]);
  obsolete.emitOpen();
  emitSubscribed(obsolete, requestIdAt(obsolete, 0), ["1s", "1m"]);

  manager.syncTargets([]);
  manager.syncTargets([TARGET]);
  const replacement = mustBeDefined(sockets[1]);
  replacement.emitOpen();
  emitSubscribed(replacement, requestIdAt(replacement, 0), ["1s", "1m"]);
  emitKline(replacement, "1m");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m")).status, "live");

  obsolete.emitClose();
  obsolete.onerror?.();
  const current = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m"));
  assert.equal(current.status, "live");
  assert.equal(current.subscribed, true);
  assert.equal(timers.pending().length, 0);

  manager.dispose();
});

test("socket manager routes BAR_AMENDED to a retained historical row", () => {
  resetWatchlistFullCache();
  mergeFullCacheRows(TARGET.symbolKey, "1m", [
    { time: epochSeconds(1), close: 1, is_closed: true },
    { time: epochSeconds(2), close: 2, is_closed: true },
    { time: epochSeconds(3), close: 3, is_closed: false },
  ]);
  const socket = new FakeSocket();
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
  });

  manager.syncTargets([{ ...TARGET, intervals: ["1m"] }]);
  socket.emitOpen();
  socket.emitMessage(JSON.stringify({
    type: "kline",
    event_type: "bar.amended",
    interval: "1m",
    data: {
      time: 2,
      open: 20,
      high: 21,
      low: 19,
      close: 20,
      volume: 100,
      is_closed: true,
    },
  }));

  const entry = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m"));
  assert.deepEqual(entry.rows.map((row) => row.close), [1, 20, 3]);
  manager.dispose();
});

test("socket manager unsubscribes intervals removed from a live target", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
  });

  manager.syncTargets([TARGET]);
  socket.emitOpen();
  emitSubscribed(socket, requestIdAt(socket, 0), ["1s", "1m"]);
  manager.syncTargets([{ ...TARGET, intervals: ["1m"] }]);

  assert.deepEqual(sentMessages(socket), [
    { action: "subscribe", intervals: ["1s", "1m"], request_id: "watchlist-1-1" },
    { action: "unsubscribe", intervals: ["1s"], request_id: "watchlist-1-2" },
  ]);
  socket.emitMessage(JSON.stringify({
    type: "unsubscribed",
    request_id: requestIdAt(socket, 1),
    intervals: ["1s"],
    active_intervals: ["1m"],
  }));
  const removed = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s"));
  const retained = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m"));
  assert.equal(removed.subscribed, false);
  assert.equal(removed.status, "stale");
  assert.equal(retained.subscribed, true);
  assert.equal(retained.status, "warm");

  manager.dispose();
});

test("socket manager subscribes only intervals added to a live target", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
  });

  manager.syncTargets([{ ...TARGET, intervals: ["1m"] }]);
  socket.emitOpen();
  emitSubscribed(socket, requestIdAt(socket, 0), ["1m"]);
  manager.syncTargets([{ ...TARGET, intervals: ["1m", "45m"] }]);

  assert.deepEqual(sentMessages(socket), [
    { action: "subscribe", intervals: ["1m"], request_id: "watchlist-1-1" },
    { action: "subscribe", intervals: ["45m"], request_id: "watchlist-1-2" },
  ]);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "45m")).status, "loading");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "45m")).subscribed, false);
  emitSubscribed(socket, requestIdAt(socket, 1), ["45m"], ["1m", "45m"]);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "45m")).status, "warm");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "45m")).subscribed, true);

  manager.dispose();
});

test("socket manager keeps partial subscription failures out of live state", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const target: FullCacheSocketTarget = {
    ...TARGET,
    symbolKey: "binance:futures:BTCUSDT",
    marketType: "futures",
    intervals: ["7s", "1m"],
  };
  const manager = createWatchlistFullCacheSocketManager({ createSocket: () => socket });

  manager.syncTargets([target]);
  socket.emitOpen();
  assert.deepEqual(sentMessages(socket), [{
    action: "subscribe",
    intervals: ["7s", "1m"],
    request_id: "watchlist-1-1",
  }]);
  socket.emitMessage(JSON.stringify({
    type: "warning",
    failed: [{ interval: "7s", error: "No exact realtime base interval" }],
  }));
  emitSubscribed(
    socket,
    requestIdAt(socket, 0),
    ["1m"],
    ["1m"],
    [{ interval: "7s", code: "no_exact_base", message: "No exact realtime base interval" }],
  );

  const failed = mustBeDefined(getFullCacheEntry(target.symbolKey, "7s"));
  const accepted = mustBeDefined(getFullCacheEntry(target.symbolKey, "1m"));
  assert.equal(failed.status, "error");
  assert.equal(failed.subscribed, false);
  assert.match(failed.lastError || "", /no_exact_base/);
  assert.equal(accepted.status, "warm");
  assert.equal(accepted.subscribed, true);

  emitKline(socket, "1m");
  assert.equal(mustBeDefined(getFullCacheEntry(target.symbolKey, "1m")).status, "live");
  manager.syncTargets([target]);
  assert.equal(socket.sent.length, 1);

  manager.dispose();
});

test("socket manager canonicalizes semantic aliases before subscribe and ACK", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const target = { ...TARGET, intervals: ["60m", "1h"] };
  const manager = createWatchlistFullCacheSocketManager({ createSocket: () => socket });

  manager.syncTargets([target]);
  socket.emitOpen();
  assert.deepEqual(sentMessages(socket), [{
    action: "subscribe",
    intervals: ["1h"],
    request_id: "watchlist-1-1",
  }]);
  emitSubscribed(socket, requestIdAt(socket, 0), ["60m"], ["60m"]);

  const canonical = mustBeDefined(getFullCacheEntry(target.symbolKey, "1h"));
  const alias = mustBeDefined(getFullCacheEntry(target.symbolKey, "60m"));
  assert.equal(canonical.key, alias.key);
  assert.equal(canonical.status, "warm");
  assert.equal(canonical.subscribed, true);

  manager.dispose();
});

test("socket manager keeps a cooldown recovery probe after bounded transient retries", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const timers = createFakeTimers();
  const target = { ...TARGET, intervals: ["45m"] };
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
    schedule: timers.schedule,
    cancel: timers.cancel,
    subscriptionRetryBaseMs: 100,
    subscriptionRetryLimit: 2,
    reconnectMaxMs: 1_000,
  });

  manager.syncTargets([target]);
  socket.emitOpen();
  const failure = [{
    interval: "45m",
    code: "stream_subscription_failed",
    message: "temporary ingestion failure",
  }];
  emitSubscribed(socket, requestIdAt(socket, 0), [], [], failure);
  assert.equal(timers.pending()[0]?.delayMs, 100);

  timers.runNext();
  assert.equal(socket.sent.length, 2);
  emitSubscribed(socket, requestIdAt(socket, 1), [], [], failure);
  assert.equal(timers.pending()[0]?.delayMs, 200);

  timers.runNext();
  assert.equal(socket.sent.length, 3);
  emitSubscribed(socket, requestIdAt(socket, 2), [], [], failure);
  assert.equal(timers.pending()[0]?.delayMs, 1_000);
  manager.syncTargets([target]);
  assert.equal(socket.sent.length, 3);

  const entry = mustBeDefined(getFullCacheEntry(target.symbolKey, "45m"));
  assert.equal(entry.status, "error");
  assert.equal(entry.subscribed, false);

  timers.runNext();
  assert.equal(socket.sent.length, 4, "cooldown probe must keep transient failure recoverable");
  emitSubscribed(socket, requestIdAt(socket, 3), ["45m"], ["45m"]);
  assert.equal(mustBeDefined(getFullCacheEntry(target.symbolKey, "45m")).subscribed, true);
  assert.equal(timers.pending().length, 0);
  manager.dispose();
});

test("socket manager clears transient rejection state after a retry succeeds", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const timers = createFakeTimers();
  const target = { ...TARGET, intervals: ["60m", "1h"] };
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
    schedule: timers.schedule,
    cancel: timers.cancel,
    subscriptionRetryBaseMs: 100,
    subscriptionRetryLimit: 2,
  });

  manager.syncTargets([target]);
  socket.emitOpen();
  emitSubscribed(socket, requestIdAt(socket, 0), [], [], [{
    interval: "60m",
    code: "stream_subscription_failed",
    message: "temporary ingestion failure",
  }]);
  timers.runNext();
  assert.deepEqual(sentMessages(socket)[1], {
    action: "subscribe",
    intervals: ["1h"],
    request_id: "watchlist-1-2",
  });

  emitSubscribed(socket, requestIdAt(socket, 1), ["60m"], ["60m"]);
  assert.equal(timers.pending().length, 0);
  const entry = mustBeDefined(getFullCacheEntry(target.symbolKey, "1h"));
  assert.equal(entry.status, "warm");
  assert.equal(entry.subscribed, true);
  assert.equal(entry.lastError, null);
  manager.dispose();
});

test("disabling the socket manager closes connections and cancels ACK retries", () => {
  resetWatchlistFullCache();
  const socket = new FakeSocket();
  const timers = createFakeTimers();
  const target = { ...TARGET, intervals: ["45m"] };
  const manager = createWatchlistFullCacheSocketManager({
    createSocket: () => socket,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  manager.syncTargets([target]);
  socket.emitOpen();
  emitSubscribed(socket, requestIdAt(socket, 0), [], [], [{
    interval: "45m",
    code: "stream_subscription_failed",
    message: "temporary ingestion failure",
  }]);
  assert.equal(timers.pending().length, 1);

  manager.syncTargets([target], false);
  assert.equal(socket.closed, true);
  assert.equal(timers.pending().length, 0);
  const entry = mustBeDefined(getFullCacheEntry(target.symbolKey, "45m"));
  assert.equal(entry.status, "stale");
  assert.equal(entry.subscribed, false);
  manager.dispose();
});
