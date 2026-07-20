import assert from "node:assert/strict";
import test from "node:test";

import { loadOrderBookPreferences } from "../orderBookPreferencesStore.js";
import {
  aggregateOrderBookLevels,
  omitIncompleteOuterBucket,
  orderBookPresentation,
  resolvePriceStep,
} from "../orderBookAggregation.js";
import { parseOrderBookSocketMessage } from "../orderBookParser.js";
import { buildOrderBookRows } from "../orderBookRows.js";
import { createOrderBookStore } from "../orderBookStore.js";
import {
  OrderBookStreamController,
  type OrderBookSocket,
} from "../orderBookStreamController.js";
import type { OrderBookBook, OrderBookExternalStore } from "../orderBookTypes.js";

function wireRecord(
  mode: "partial" | "full",
  revision = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const full = mode === "full";
  return {
    key: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: full ? "full_depth" : "depth",
      params: full
        ? { mode: "full", snapshot_limit: "1000", update_interval_ms: "250" }
        : { mode: "partial", depth_levels: "20", update_interval_ms: "250" },
    },
    topic: `binance:futures:BTCUSDT@${full ? "full_depth" : "depth"}`,
    channel: full ? "full_depth" : "depth",
    event_time_ms: 1_700_000_000_000 + revision,
    received_at_ms: 1_700_000_000_010 + revision,
    source: "websocket",
    sequence: revision,
    revision,
    data: {
      mode: full ? "full_depth_reconstructed" : undefined,
      state: "live",
      live: true,
      bids: [[100, 1], [99, 2]],
      asks: [[101, 1.5], [102, 3]],
      best_bid_price: 100,
      best_ask_price: 101,
      mid_price: 100.5,
      spread: 1,
      spread_bps: 99.5024875622,
      update_interval_ms: 250,
      notional_imbalance: full ? undefined : -0.1,
      depth_levels: full ? undefined : 20,
      output_limit: full ? 100 : undefined,
      book_bid_levels: full ? 2 : undefined,
      book_ask_levels: full ? 2 : undefined,
      price_tick_size: 0.1,
      price_step: full ? 1 : 0.1,
      price_grouping: full ? "auto" : "raw",
      aggregation_applied: full,
      bucket_bid_levels: full ? 2 : undefined,
      bucket_ask_levels: full ? 2 : undefined,
      ...overrides,
    },
  };
}

function parsedBook(mode: "partial" | "full", revision = 1): OrderBookBook {
  const parsed = parseOrderBookSocketMessage({
    type: mode === "full" ? "full_order_book.snapshot" : "order_book.snapshot",
    state: mode === "full" ? "live" : undefined,
    data: wireRecord(mode, revision),
  }, mode);
  assert.equal(parsed.kind, "records");
  return parsed.records[0] as OrderBookBook;
}

test("parser validates sorted positive levels and recognizes P4 stale snapshots", () => {
  const partial = parsedBook("partial");
  assert.equal(partial.identity.symbol, "BTCUSDT");
  assert.equal(partial.depthLevels, 20);
  assert.equal(partial.notionalImbalance, -0.1);
  assert.equal(partial.priceTickSize, 0.1);
  assert.equal(partial.priceGrouping, "raw");

  assert.throws(() => parseOrderBookSocketMessage({
    type: "order_book.snapshot",
    data: wireRecord("partial", 2, { bids: [[99, 1], [100, 1]] }),
  }, "partial"), /strictly price-sorted/);

  const stale = parseOrderBookSocketMessage({
    type: "snapshot",
    data: [wireRecord("full", 3, {
      state: "stale",
      live: false,
      stale: true,
      stale_reason: "sequence_gap_resync",
      bids: [],
      asks: [],
    })],
  }, "full");
  assert.deepEqual(stale, {
    kind: "stale",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    message: "sequence_gap_resync",
  });
});

test("row projection keeps cumulative depth from best price outward", () => {
  const rows = buildOrderBookRows(
    [[100, 1], [99, 2]],
    [[101, 1.5], [102, 3]],
  );
  assert.deepEqual(rows.bids.map((row) => row.cumulative), [1, 3]);
  assert.deepEqual(rows.asks.map((row) => row.cumulative), [1.5, 4.5]);
  assert.deepEqual(rows.bids.map((row) => row.slot), [0, 1]);
  assert.deepEqual(rows.asks.map((row) => row.slot), [0, 1]);
  assert.equal(rows.maxCumulative, 4.5);

  const shifted = buildOrderBookRows(
    [[101, 1], [100, 2]],
    [[102, 1.5], [103, 3]],
  );
  assert.deepEqual(shifted.bids.map((row) => row.slot), [0, 1]);
  assert.deepEqual(shifted.asks.map((row) => row.slot), [0, 1]);
});

test("price grouping rounds bids down, asks up, and keeps raw spread metrics", () => {
  assert.deepEqual(
    aggregateOrderBookLevels([[100.9, 1], [100.2, 2], [99.8, 3]], "bids", 1),
    [[100, 3], [99, 3]],
  );
  assert.deepEqual(
    aggregateOrderBookLevels([[101.1, 4], [101.9, 5], [102.2, 6]], "asks", 1),
    [[102, 9], [103, 6]],
  );
  assert.deepEqual(
    omitIncompleteOuterBucket([[100, 3], [99, 3]]),
    [[100, 3]],
  );
  assert.deepEqual(omitIncompleteOuterBucket([[100, 3]]), [[100, 3]]);
  assert.equal(resolvePriceStep(0.1, 60_000, "auto"), 1);

  const partial = parsedBook("partial");
  const presentation = orderBookPresentation(partial, "10");
  assert.equal(presentation.priceStep, 1);
  assert.equal(presentation.aggregationApplied, true);
  assert.deepEqual(presentation.bids, [[100, 1]]);
  assert.deepEqual(presentation.asks, [[101, 1.5]]);
  assert.equal(partial.midPrice, 100.5);
});

test("latest-only store coalesces frames and stale status cancels pending books", () => {
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const store = createOrderBookStore({
    request: (callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancel: (handle) => { frames.delete(handle); },
  });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  store.publishBook(parsedBook("partial", 1));
  store.publishBook(parsedBook("partial", 2));
  assert.equal(store.getSnapshot().book, null);
  frames.get(1)?.();
  assert.equal(store.getSnapshot().book?.revision, 2);
  assert.equal(notifications, 1);

  store.publishBook(parsedBook("partial", 3));
  store.publishStatus("stale", { message: "silent", clearBook: true });
  assert.equal(store.getSnapshot().status, "stale");
  assert.equal(store.getSnapshot().book, null);
  assert.equal(frames.has(2), false);
});

test("preference loading clamps height and rejects corrupt enum values", () => {
  const values = new Map<string, string>([
    ["candlescope-order-book-height", "9999"],
    ["candlescope-order-book-collapsed", "true"],
    ["candlescope-order-book-mode", "delta"],
    ["candlescope-order-book-partial-depth", "50"],
    ["candlescope-order-book-interval-ms", "100"],
    ["candlescope-order-book-full-output-limit", "50"],
    ["candlescope-order-book-partial-price-grouping", "100"],
    ["candlescope-order-book-full-price-grouping", "1000"],
  ]);
  const preferences = loadOrderBookPreferences({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
  assert.deepEqual(preferences, {
    height: 640,
    collapsed: true,
    mode: "partial",
    partialDepth: 20,
    updateIntervalMs: 100,
    fullOutputLimit: 50,
    partialPriceGrouping: "auto",
    fullPriceGrouping: "1000",
  });
});

class FakeSocket implements OrderBookSocket {
  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  sent: string[] = [];
  closed = false;

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(new Event("open")); }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

function flushableStore(): { store: OrderBookExternalStore; flush(): void } {
  let pending: (() => void) | null = null;
  return {
    store: createOrderBookStore({
      request: (callback) => { pending = callback; return 1; },
      cancel: () => { pending = null; },
    }),
    flush: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
  };
}

test("P4 controller verifies immutable subscription, publishes live, and clears on stale", () => {
  const socket = new FakeSocket();
  const { store, flush } = flushableStore();
  const activeTimers = new Map<number, () => void>();
  let timerId = 0;
  const controller = new OrderBookStreamController({
    url: "ws://example/api/v1/stream/full-order-book",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    mode: "full",
    partialDepth: 20,
    updateIntervalMs: 250,
    fullOutputLimit: 100,
    fullPriceGrouping: "auto",
    store,
    socketFactory: () => socket,
    setTimer: (callback) => {
      timerId += 1;
      activeTimers.set(timerId, callback);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => { activeTimers.delete(handle as unknown as number); },
  });

  controller.start();
  assert.equal(store.getSnapshot().status, "connecting");
  socket.open();
  socket.message({ type: "connected", protocol: "orderbook.full.v1" });
  const subscribe = JSON.parse(socket.sent[0] || "{}") as {
    request_id: string;
    streams: Array<Record<string, unknown> & { params: Record<string, unknown> }>;
  };
  assert.equal(subscribe.streams[0]?.params.output_limit, 100);
  assert.equal(subscribe.streams[0]?.params.price_grouping, "auto");
  const acknowledged = structuredClone(subscribe.streams[0] as Record<string, unknown>) as Record<string, unknown> & { params: Record<string, unknown> };
  delete acknowledged.params.output_limit;
  delete acknowledged.params.price_grouping;
  acknowledged.output_limit = 100;
  acknowledged.price_grouping = "auto";
  socket.message({
    type: "subscribed",
    request_id: subscribe.request_id,
    streams: [acknowledged],
  });
  socket.message({
    type: "full_order_book.snapshot",
    state: "live",
    data: wireRecord("full", 5),
  });
  flush();
  assert.equal(store.getSnapshot().status, "live");
  assert.equal(store.getSnapshot().book?.revision, 5);

  socket.message({
    type: "full_order_book.status",
    state: "stale",
    data: wireRecord("full", 6, {
      state: "stale",
      live: false,
      stale: true,
      stale_reason: "sequence_gap_resync",
      bids: [],
      asks: [],
    }),
  });
  assert.equal(store.getSnapshot().status, "stale");
  assert.equal(store.getSnapshot().book, null);
  assert.equal(store.getSnapshot().message, "检测到序列缺口，正在重新同步");

  controller.close();
  const unsubscribe = JSON.parse(socket.sent.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(unsubscribe.action, "unsubscribe");
  assert.equal(socket.closed, true);
});

test("P3 controller clears a snapshot when its client freshness watchdog expires", () => {
  const socket = new FakeSocket();
  const { store, flush } = flushableStore();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const controller = new OrderBookStreamController({
    url: "ws://example/api/v1/stream/order-book",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    mode: "partial",
    partialDepth: 20,
    updateIntervalMs: 250,
    fullOutputLimit: 100,
    fullPriceGrouping: "auto",
    staleAfterMs: 1_234,
    store,
    socketFactory: () => socket,
    setTimer: (callback, delay) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => { timers.delete(handle as unknown as number); },
  });

  controller.start();
  socket.open();
  socket.message({ type: "connected", protocol: "orderbook.v1" });
  const subscribe = JSON.parse(socket.sent[0] || "{}") as {
    request_id: string;
    streams: Array<Record<string, unknown>>;
  };
  socket.message({
    type: "subscribed",
    request_id: subscribe.request_id,
    streams: subscribe.streams,
  });
  socket.message({ type: "order_book.snapshot", data: wireRecord("partial", 7) });
  flush();
  assert.equal(store.getSnapshot().status, "live");

  const watchdog = [...timers.values()].find((timer) => timer.delay === 1_234);
  assert.ok(watchdog);
  watchdog.callback();
  assert.equal(store.getSnapshot().status, "stale");
  assert.equal(store.getSnapshot().book, null);
  controller.close();
});

test("spot controller subscribes with the native market identity and cadence", () => {
  const socket = new FakeSocket();
  const { store } = flushableStore();
  const controller = new OrderBookStreamController({
    url: "ws://example/api/v1/stream/order-book",
    identity: { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    mode: "partial",
    partialDepth: 20,
    updateIntervalMs: 1000,
    fullOutputLimit: 100,
    fullPriceGrouping: "auto",
    store,
    socketFactory: () => socket,
  });

  controller.start();
  socket.open();
  socket.message({ type: "connected", protocol: "orderbook.v1" });
  const subscribe = JSON.parse(socket.sent[0] || "{}") as {
    streams: Array<{
      market_type?: unknown;
      params?: Record<string, unknown>;
    }>;
  };

  assert.equal(subscribe.streams[0]?.market_type, "spot");
  assert.equal(subscribe.streams[0]?.params?.update_interval_ms, 1000);
  controller.close();
});
