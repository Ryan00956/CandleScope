import assert from "node:assert/strict";
import test from "node:test";
import { createTradeFlowStore } from "../tradeFlowStore.js";
import { TradeFlowStreamController } from "../tradeFlowStreamController.js";
import type { TradeFlowSocket } from "../tradeFlowStreamController.js";

class FakeSocket implements TradeFlowSocket {
  readonly OPEN = 1;
  readyState = 1;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  sent: string[] = [];
  closed = false;

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.readyState = 3; }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
  emitRaw(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent<string>);
  }
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

class FakeTimers {
  private nextId = 1;
  private readonly pending = new Map<ReturnType<typeof setTimeout>, {
    callback: () => void;
    delayMs: number;
  }>();

  readonly set = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const handle = this.nextId as unknown as ReturnType<typeof setTimeout>;
    this.nextId += 1;
    this.pending.set(handle, { callback, delayMs });
    return handle;
  };

  readonly clear = (handle: ReturnType<typeof setTimeout>): void => {
    this.pending.delete(handle);
  };

  delays(): number[] {
    return [...this.pending.values()].map((task) => task.delayMs);
  }

  runNext(delayMs?: number): void {
    const entry = [...this.pending.entries()].find(([, task]) => (
      delayMs === undefined || task.delayMs === delayMs
    ));
    assert.ok(entry, `expected a pending timer${delayMs === undefined ? "" : ` at ${delayMs}ms`}`);
    const [handle, task] = entry;
    this.pending.delete(handle);
    task.callback();
  }
}

const IDENTITY = Object.freeze({
  exchange: "binance",
  marketType: "futures",
  symbol: "BTCUSDT",
});

function subscribeRequestId(socket: FakeSocket): string {
  const command = JSON.parse(socket.sent.at(-1) || "{}") as { request_id?: unknown };
  if (typeof command.request_id !== "string") {
    assert.fail("expected the latest command to carry a string request_id");
  }
  return command.request_id;
}

function emitConnected(socket: FakeSocket): string {
  socket.emit({ type: "connected", protocol: "tradeflow.v1" });
  return subscribeRequestId(socket);
}

function emitSubscribed(socket: FakeSocket, requestId: string): void {
  socket.emit({
    type: "subscribed",
    protocol: "tradeflow.v1",
    request_id: requestId,
    streams: [{
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "agg_trade",
      params: {},
    }],
  });
}

function emitRecent(socket: FakeSocket, requestId: string, ids = [10]): void {
  socket.emit({
    type: "recent",
    protocol: "tradeflow.v1",
    request_id: requestId,
    data: ids.map(rawTrade),
  });
}

function rawTrade(id: number) {
  return {
    exchange: "binance",
    market_type: "futures",
    symbol: "BTCUSDT",
    agg_trade_id: id,
    price: 60_000,
    quantity: 0.1,
    quote_quantity: 6_000,
    trade_time_ms: 1_700_000_000_000 + id,
    event_time_ms: 1_700_000_000_000 + id,
    received_at_ms: 1_700_000_000_000 + id,
    is_buyer_maker: false,
    aggressor_side: "buy",
    source: "websocket",
    first_trade_id: id * 2,
    last_trade_id: id * 2 + 1,
  };
}

function createControllerStore() {
  let nextFrame = 0;
  return createTradeFlowStore({
    scheduler: {
      request() { nextFrame += 1; return nextFrame; },
      cancel() {},
    },
  });
}

test("TradeFlow controller validates recent-to-live handoff before publishing batches", () => {
  const frames: Array<() => void> = [];
  const store = createTradeFlowStore({
    scheduler: {
      request(callback) { frames.push(callback); return frames.length; },
      cancel() {},
    },
  });
  const socket = new FakeSocket();
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    store,
    socketFactory: () => socket,
  });

  controller.start();
  socket.emit({ type: "connected", protocol: "tradeflow.v1" });
  assert.equal(socket.sent.length, 1);
  const subscribe = JSON.parse(socket.sent[0] || "{}") as { request_id?: string };
  assert.ok(subscribe.request_id);
  socket.emit({
    type: "subscribed",
    protocol: "tradeflow.v1",
    request_id: subscribe.request_id,
    streams: [{
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "agg_trade",
      params: {},
    }],
  });
  socket.emit({
    type: "recent",
    protocol: "tradeflow.v1",
    request_id: subscribe.request_id,
    data: [rawTrade(10)],
  });
  socket.emit({
    type: "trade.batch",
    protocol: "tradeflow.v1",
    sequence: 7,
    continuity: true,
    resync_required: false,
    dropped_before: 0,
    data: [rawTrade(11), rawTrade(12)],
  });
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(store.getSnapshot().records.map((trade) => trade.aggTradeId), [10, 11, 12]);
  assert.equal(store.getSnapshot().status, "live");

  socket.emit({
    type: "trade.batch",
    protocol: "tradeflow.v1",
    // Global hub sequence gaps are expected for a symbol-filtered subscriber.
    sequence: 11,
    continuity: true,
    resync_required: false,
    dropped_before: 0,
    data: [rawTrade(13)],
  });
  frames.shift()?.();
  assert.deepEqual(store.getSnapshot().records.map((trade) => trade.aggTradeId), [10, 11, 12, 13]);
  assert.equal(store.getSnapshot().status, "live");

  controller.close();
  assert.equal(socket.closed, true);
});

test("SUBSCRIBE_FAILED retries on the same socket five times before becoming terminal", () => {
  const timers = new FakeTimers();
  const store = createControllerStore();
  const socket = new FakeSocket();
  let socketFactoryCalls = 0;
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: IDENTITY,
    store,
    socketFactory: () => { socketFactoryCalls += 1; return socket; },
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    commandTimeoutMs: 0,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  controller.start();
  let requestId = emitConnected(socket);
  const expectedDelays = [10, 20, 40, 40, 40];
  for (const delay of expectedDelays) {
    socket.emit({
      type: "error",
      request_id: requestId,
      code: "SUBSCRIBE_FAILED",
      detail: "temporarily unavailable",
    });
    assert.equal(socket.closed, false);
    assert.deepEqual(timers.delays(), [delay]);
    timers.runNext(delay);
    requestId = subscribeRequestId(socket);
  }

  assert.equal(socketFactoryCalls, 1);
  assert.equal(socket.sent.length, 6);
  socket.emit({
    type: "error",
    request_id: requestId,
    code: "SUBSCRIBE_FAILED",
    detail: "temporarily unavailable",
  });
  assert.equal(socket.closed, true);
  assert.equal(store.getSnapshot().status, "error");
  assert.match(store.getSnapshot().error || "", /自动重试已达上限 5 次/);
  assert.deepEqual(timers.delays(), []);
  assert.equal(socketFactoryCalls, 1);
});

test("SUBSCRIBE_FAILED must match the pending request id", () => {
  const timers = new FakeTimers();
  const store = createControllerStore();
  const socket = new FakeSocket();
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: IDENTITY,
    store,
    socketFactory: () => socket,
    commandTimeoutMs: 0,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  controller.start();
  emitConnected(socket);
  socket.emit({
    type: "error",
    request_id: "stale-request",
    code: "SUBSCRIBE_FAILED",
    detail: "temporarily unavailable",
  });

  assert.equal(socket.closed, true);
  assert.equal(store.getSnapshot().status, "error");
  assert.match(store.getSnapshot().error || "", /did not match/);
  assert.deepEqual(timers.delays(), []);
});

test("non-retryable server and protocol errors stop without reconnecting", () => {
  for (const emitFailure of [
    (socket: FakeSocket, requestId: string) => socket.emit({
      type: "error",
      request_id: requestId,
      code: "INVALID_SUBSCRIPTION",
      detail: "unsupported stream",
    }),
    (socket: FakeSocket) => socket.emitRaw("{"),
  ]) {
    const timers = new FakeTimers();
    const store = createControllerStore();
    const socket = new FakeSocket();
    const controller = new TradeFlowStreamController({
      url: "ws://example.test/api/v1/stream/trade-flow",
      identity: IDENTITY,
      store,
      socketFactory: () => socket,
      commandTimeoutMs: 0,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    controller.start();
    const requestId = emitConnected(socket);
    emitFailure(socket, requestId);
    assert.equal(socket.closed, true);
    assert.equal(store.getSnapshot().status, "error");
    assert.deepEqual(timers.delays(), []);
  }
});

test("recent handoffs do not reset the retry budget before ten stable seconds", () => {
  const timers = new FakeTimers();
  const store = createControllerStore();
  const sockets: FakeSocket[] = [];
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: IDENTITY,
    store,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    maxAutomaticRetries: 2,
    commandTimeoutMs: 0,
    stableAfterMs: 10_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  controller.start();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const socket = sockets.at(-1);
    assert.ok(socket);
    const requestId = emitConnected(socket);
    emitSubscribed(socket, requestId);
    emitRecent(socket, requestId);
    socket.emit({
      type: "resync_required",
      protocol: "tradeflow.v1",
      code: "TRADE_FLOW_DISCONTINUITY",
      dropped_before: 1,
    });
    if (attempt < 2) {
      assert.deepEqual(timers.delays(), [attempt === 0 ? 10 : 20]);
      timers.runNext();
    }
  }

  assert.equal(sockets.length, 3);
  assert.equal(store.getSnapshot().status, "error");
  assert.match(store.getSnapshot().error || "", /自动重试已达上限 2 次/);
  assert.deepEqual(timers.delays(), []);
});

test("ten stable seconds reset both retry count and reconnect delay", () => {
  const timers = new FakeTimers();
  const store = createControllerStore();
  const sockets: FakeSocket[] = [];
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: IDENTITY,
    store,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    maxAutomaticRetries: 1,
    commandTimeoutMs: 0,
    stableAfterMs: 10_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  controller.start();
  sockets[0]?.emitClose();
  assert.deepEqual(timers.delays(), [10]);
  timers.runNext(10);

  const recovered = sockets[1];
  assert.ok(recovered);
  const requestId = emitConnected(recovered);
  emitSubscribed(recovered, requestId);
  emitRecent(recovered, requestId);
  assert.deepEqual(timers.delays(), [10_000]);
  timers.runNext(10_000);

  recovered.emitClose();
  assert.deepEqual(timers.delays(), [10]);
  assert.equal(store.getSnapshot().status, "reconnecting");
  controller.close();
  assert.deepEqual(timers.delays(), []);
});

test("close clears every timer and late callbacks cannot revive the controller", () => {
  const timers = new FakeTimers();
  const store = createControllerStore();
  const sockets: FakeSocket[] = [];
  const controller = new TradeFlowStreamController({
    url: "ws://example.test/api/v1/stream/trade-flow",
    identity: IDENTITY,
    store,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    commandTimeoutMs: 500,
    stableAfterMs: 10_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  controller.start();
  const socket = sockets[0];
  assert.ok(socket);
  const requestId = emitConnected(socket);
  emitSubscribed(socket, requestId);
  emitRecent(socket, requestId);
  assert.deepEqual(timers.delays(), [10_000]);
  const lateMessage = socket.onmessage;
  const lateClose = socket.onclose;

  controller.close();
  assert.equal(socket.closed, true);
  assert.deepEqual(timers.delays(), []);
  lateMessage?.({ data: JSON.stringify({
    type: "resync_required",
    protocol: "tradeflow.v1",
    dropped_before: 1,
  }) } as MessageEvent<string>);
  lateClose?.({ code: 1006 } as CloseEvent);
  assert.deepEqual(timers.delays(), []);
  assert.equal(sockets.length, 1);
});
