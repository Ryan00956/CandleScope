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
  resetWatchlistFullCache,
} from "../watchlistFullCacheStore.js";
import type { FullCacheSocketTarget } from "../watchlistFullCacheTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

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

test("socket manager reconnects with backoff while preserving subscription protection", () => {
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
  const first = mustBeDefined(sockets[0]);
  first.emitOpen();
  assert.deepEqual(JSON.parse(mustBeDefined(first.sent[0])), {
    action: "subscribe",
    intervals: ["1s", "1m"],
  });
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "live");

  first.emitClose();
  const stale = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s"));
  assert.equal(stale.status, "stale");
  assert.equal(stale.subscribed, true);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.delayMs, 1_000);

  timers.runNext();
  const second = mustBeDefined(sockets[1]);
  second.emitOpen();
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "live");
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).subscribed, true);

  second.onerror?.();
  assert.equal(second.closed, true);
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s")).status, "error");
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.delayMs, 2_000);
  timers.runNext();
  const third = mustBeDefined(sockets[2]);
  third.emitOpen();
  third.emitMessage(JSON.stringify({
    type: "kline",
    interval: "1m",
    data: { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  }));
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

  manager.syncTargets([]);
  manager.syncTargets([TARGET]);
  const replacement = mustBeDefined(sockets[1]);
  replacement.emitOpen();
  assert.equal(mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m")).status, "live");

  obsolete.emitClose();
  obsolete.onerror?.();
  const current = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m"));
  assert.equal(current.status, "live");
  assert.equal(current.subscribed, true);
  assert.equal(timers.pending().length, 0);

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
  manager.syncTargets([{ ...TARGET, intervals: ["1m"] }]);

  assert.deepEqual(socket.sent.map((message): unknown => JSON.parse(message) as unknown), [
    { action: "subscribe", intervals: ["1s", "1m"] },
    { action: "unsubscribe", intervals: ["1s"] },
    { action: "subscribe", intervals: ["1m"] },
  ]);
  const removed = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1s"));
  const retained = mustBeDefined(getFullCacheEntry(TARGET.symbolKey, "1m"));
  assert.equal(removed.subscribed, false);
  assert.equal(removed.status, "stale");
  assert.equal(retained.subscribed, true);
  assert.equal(retained.status, "live");

  manager.dispose();
});
