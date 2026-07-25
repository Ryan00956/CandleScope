import assert from "node:assert/strict";
import test from "node:test";

import {
  IndicatorStreamConnection,
  type IndicatorStreamSocket,
  type IndicatorStreamSubscription,
} from "../indicatorStreamConnection.js";
import type { IndicatorWsMessage } from "../indicatorTypes.js";

class FakeSocket implements IndicatorStreamSocket {
  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  closed = false;
  sent: string[] = [];

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = this.OPEN; this.onopen?.(new Event("open")); }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<unknown>);
  }
  serverClose(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
}

interface ScheduledTimer {
  active: boolean;
  callback: () => void;
  delayMs: number;
}

function createTimers() {
  const timers: ScheduledTimer[] = [];
  return {
    timers,
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      const scheduled = timers[Number(timer) - 1];
      if (scheduled) scheduled.active = false;
    },
    setTimer: (callback: () => void, delayMs: number) => {
      timers.push({ active: true, callback, delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    run(timerIndex: number) {
      const timer = timers[timerIndex];
      assert.ok(timer?.active, `Timer ${timerIndex} must be active`);
      timer.active = false;
      timer.callback();
    },
  };
}

function subscription(
  signature = "vol:v1",
  symbol = "BTCUSDT",
  historyLimit = 100,
): IndicatorStreamSubscription {
  return {
    clientId: "vol",
    signature,
    message: {
      action: "subscribe",
      clientId: "vol",
      kind: "builtin",
      exchange: "binance",
      marketType: "futures",
      symbol,
      interval: "1d",
      displayName: "VOL",
      name: "VOL",
      params: {},
      historyLimit,
    },
  };
}

function wireMessage(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] || "{}") as Record<string, unknown>;
}

test("first forming preview is delivered before its subscribe acknowledgement", () => {
  const sockets: FakeSocket[] = [];
  const received: IndicatorWsMessage[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => received.push(message),
    subscriptionAckTimeoutMs: 0,
  });

  controller.setSubscriptions([subscription()]);
  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  assert.equal(wireMessage(socket, 0).action, "subscribe");

  socket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 12 },
    barTime: 1_700_000_000,
  });
  socket.message({
    type: "indicator.subscribed",
    clientId: "vol",
    interval: "1d",
  });

  assert.deepEqual(received.map((message) => message.type), [
    "indicator.preview",
    "indicator.subscribed",
  ]);
  controller.close();
});

test("an explicit same-signature seed refresh sends the newer history limit without reconnecting", () => {
  const sockets: FakeSocket[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    subscriptionAckTimeoutMs: 0,
  });

  controller.setSubscriptions([subscription("boll:v1", "BTCUSDT", 20)]);
  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });

  controller.setSubscriptions([subscription("boll:v1", "BTCUSDT", 2_000)]);
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.length, 1);

  assert.equal(controller.forceResubscribe(), true);
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.length, 2);
  assert.equal(wireMessage(socket, 1).historyLimit, 2_000);
  controller.close();
});

test("messages retain wire signature and socket generation across a same-client replacement", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const received: Array<{
    generation: number;
    signature: string | undefined;
    type: IndicatorWsMessage["type"];
  }> = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message, context) => received.push({
      generation: context.wsGeneration,
      signature: context.subscriptionSignature,
      type: message.type,
    }),
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    subscriptionAckTimeoutMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription("vol:v1")]);
  controller.start();
  const firstSocket = sockets[0] as FakeSocket;
  firstSocket.open();
  firstSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 10 },
    barTime: 1_700_000_000,
  });
  firstSocket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });

  controller.setSubscriptions([subscription("vol:v2")]);
  timers.run(0);
  const secondSocket = sockets[1] as FakeSocket;
  secondSocket.open();
  secondSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 20 },
    barTime: 1_700_000_060,
  });
  secondSocket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });

  assert.deepEqual(received, [
    { generation: 1, signature: "vol:v1", type: "indicator.preview" },
    { generation: 1, signature: "vol:v1", type: "indicator.subscribed" },
    { generation: 2, signature: "vol:v2", type: "indicator.preview" },
    { generation: 2, signature: "vol:v2", type: "indicator.subscribed" },
  ]);
  controller.close();
});

test("missing acknowledgement retries the identical subscription then reconnects", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const errors: unknown[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onError: (error) => errors.push(error),
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    subscriptionAckTimeoutMs: 10,
    maxSubscriptionAttempts: 2,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription()]);
  controller.start();
  const firstSocket = sockets[0] as FakeSocket;
  firstSocket.open();
  assert.equal(timers.timers[0]?.delayMs, 10);

  timers.run(0);
  assert.equal(firstSocket.sent.length, 2);
  assert.deepEqual(wireMessage(firstSocket, 1), wireMessage(firstSocket, 0));
  assert.equal(timers.timers[1]?.delayMs, 10);

  timers.run(1);
  assert.equal(firstSocket.closed, true);
  assert.match(String(errors[0]), /acknowledgement timed out/);
  assert.equal(timers.timers[2]?.delayMs, 5);

  timers.run(2);
  const secondSocket = sockets[1] as FakeSocket;
  secondSocket.open();
  assert.equal(wireMessage(secondSocket, 0).action, "subscribe");
  controller.close();
});

test("a failed subscription acknowledgement settles without retry and isolates the next config", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const received: IndicatorWsMessage[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => received.push(message),
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    subscriptionAckTimeoutMs: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription("vol:v1", "BTCUSDT")]);
  controller.start();
  const failedSocket = sockets[0] as FakeSocket;
  failedSocket.open();
  failedSocket.message({
    type: "indicator.subscribed",
    clientId: "vol",
    interval: "1d",
    subscriptionStatus: "failed",
    realtimeStatus: "unavailable",
    ok: false,
    failure: { code: "INDICATOR_STREAM_SUBSCRIPTION_FAILED", message: "unavailable" },
  });

  assert.deepEqual(received.map((message) => message.type), ["indicator.subscribed"]);
  assert.equal(failedSocket.sent.length, 1);
  assert.equal(timers.timers.filter((timer) => timer.active).length, 0);

  controller.setSubscriptions([subscription("vol:v2", "ETHUSDT")]);
  assert.equal(failedSocket.closed, true);
  timers.run(timers.timers.length - 1);
  const freshSocket = sockets[1] as FakeSocket;
  freshSocket.open();
  assert.equal(wireMessage(freshSocket, 0).symbol, "ETHUSDT");
  controller.close();
});

test("a superseded in-flight subscription gets a fresh socket and stale previews are ignored", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const received: IndicatorWsMessage[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => received.push(message),
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    subscriptionAckTimeoutMs: 20,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription("vol:v1", "BTCUSDT")]);
  controller.start();
  const staleSocket = sockets[0] as FakeSocket;
  staleSocket.open();

  controller.setSubscriptions([subscription("vol:v2", "ETHUSDT")]);
  assert.equal(staleSocket.closed, true);
  assert.equal(timers.timers.at(-1)?.delayMs, 5);

  staleSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 999 },
    barTime: 1_700_000_000,
  });
  assert.equal(received.length, 0);

  timers.run(timers.timers.length - 1);
  const freshSocket = sockets[1] as FakeSocket;
  freshSocket.open();
  assert.equal(wireMessage(freshSocket, 0).symbol, "ETHUSDT");
  freshSocket.message({
    type: "indicator.subscribed",
    clientId: "vol",
    interval: "1d",
  });
  freshSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 21 },
    barTime: 1_700_086_400,
  });
  assert.deepEqual(received.map((message) => message.type), [
    "indicator.subscribed",
    "indicator.preview",
  ]);
  controller.close();
});

test("changing an acknowledged client configuration isolates late old acknowledgements and previews", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const received: IndicatorWsMessage[] = [];
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => received.push(message),
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    subscriptionAckTimeoutMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription("vol:v1", "BTCUSDT")]);
  controller.start();
  const staleSocket = sockets[0] as FakeSocket;
  staleSocket.open();
  staleSocket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });
  assert.deepEqual(received.map((message) => message.type), ["indicator.subscribed"]);

  controller.setSubscriptions([subscription("vol:v2", "ETHUSDT")]);
  assert.equal(staleSocket.closed, true);
  assert.equal(timers.timers[0]?.delayMs, 5);

  // Both frames are valid for the old subscription, but neither may reach the
  // new configuration while the same clientId is being replaced.
  staleSocket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });
  staleSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { vol: 999 },
    barTime: 1_700_000_000,
  });
  assert.deepEqual(received.map((message) => message.type), ["indicator.subscribed"]);

  timers.run(0);
  const freshSocket = sockets[1] as FakeSocket;
  freshSocket.open();
  assert.equal(wireMessage(freshSocket, 0).symbol, "ETHUSDT");
  freshSocket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });
  freshSocket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { vol: 21 },
    barTime: 1_700_086_400,
  });
  assert.deepEqual(received.map((message) => message.type), [
    "indicator.subscribed",
    "indicator.subscribed",
    "indicator.preview",
  ]);
  controller.close();
});

test("unexpected closes reconnect with bounded backoff and restore the desired subscription", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    subscriptionAckTimeoutMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription()]);
  controller.start();
  const firstSocket = sockets[0] as FakeSocket;
  firstSocket.open();
  firstSocket.serverClose();
  assert.equal(timers.timers[0]?.delayMs, 5);

  timers.run(0);
  const secondSocket = sockets[1] as FakeSocket;
  secondSocket.open();
  assert.equal(wireMessage(secondSocket, 0).action, "subscribe");
  secondSocket.serverClose();
  assert.equal(timers.timers[1]?.delayMs, 10);
  controller.close();
});

test("a sequence gap forces an idempotent hosted resubscribe", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    sequenceGapResubscribeMs: 7,
    subscriptionAckTimeoutMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription()]);
  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message({
    type: "indicator.subscribed",
    clientId: "vol",
    interval: "1d",
    seq: 1,
  });
  socket.message({
    type: "indicator.preview",
    clientId: "vol",
    values: { volume: 12 },
    barTime: 1_700_000_000,
    seq: 3,
  });

  assert.equal(timers.timers[0]?.delayMs, 7);
  timers.run(0);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(wireMessage(socket, 1), wireMessage(socket, 0));
  controller.close();
});

test("close releases active indicator clients and never schedules a reconnect", () => {
  const sockets: FakeSocket[] = [];
  const timers = createTimers();
  const controller = new IndicatorStreamConnection({
    url: "ws://example/indicators",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    subscriptionAckTimeoutMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.setSubscriptions([subscription()]);
  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message({ type: "indicator.subscribed", clientId: "vol", interval: "1d" });
  controller.close();

  assert.equal(wireMessage(socket, 1).action, "unsubscribe");
  assert.equal(wireMessage(socket, 1).clientId, "vol");
  socket.serverClose();
  assert.equal(timers.timers.length, 0);
});
