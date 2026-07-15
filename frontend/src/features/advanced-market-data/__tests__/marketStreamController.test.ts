import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketStreamController,
  type AdvancedMarketSocket,
} from "../marketStreamController.js";
import type {
  AdvancedMarketChannel,
  MarketStateRecord,
} from "../advancedMarketDataTypes.js";

const SUMMARY_CHANNELS = ["mark_price", "index_price", "basis"] as const;

interface WireCommand {
  action?: "subscribe" | "unsubscribe";
  request_id?: string;
  streams?: Array<Record<string, unknown> & { channel?: AdvancedMarketChannel }>;
}

class FakeSocket implements AdvancedMarketSocket {
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
  serverClose(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
}

function commandAt(socket: FakeSocket, index: number): WireCommand {
  return JSON.parse(socket.sent[index] || "{}") as WireCommand;
}

function commandChannels(socket: FakeSocket, index: number): Array<AdvancedMarketChannel | undefined> {
  return (commandAt(socket, index).streams || []).map((stream) => stream.channel);
}

function commandAck(socket: FakeSocket, index: number): Record<string, unknown> {
  const command = commandAt(socket, index);
  assert.ok(command.action === "subscribe" || command.action === "unsubscribe");
  return {
    type: command.action === "subscribe" ? "subscribed" : "unsubscribed",
    request_id: command.request_id,
    streams: (command.streams || []).map((stream) => ({ ...stream, params: {} })),
  };
}

function subscribeAck(socket: FakeSocket): Record<string, unknown> {
  return commandAck(socket, 0);
}

function marketRecord(
  channel: AdvancedMarketChannel,
  data: Record<string, unknown>,
): MarketStateRecord {
  return {
    key: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel,
      params: {},
    },
    topic: `binance:futures:BTCUSDT@${channel}`,
    channel,
    event_time_ms: 1_000,
    received_at_ms: 1_010,
    source: "websocket",
    sequence: null,
    revision: 1,
    data,
  };
}

test("socket stays connecting after open until the matching subscribed ack", () => {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
  });

  controller.start();
  sockets[0]?.open();
  assert.deepEqual(statuses, ["connecting"]);

  sockets[0]?.message({ type: "connected", protocol: "market.v1" });
  assert.deepEqual(statuses, ["connecting"]);

  const subscribe = JSON.parse(sockets[0]?.sent[0] || "{}") as Record<string, unknown>;
  assert.equal(subscribe.action, "subscribe");
  assert.equal((subscribe.streams as unknown[]).length, 5);
  sockets[0]?.message(subscribeAck(sockets[0] as FakeSocket));
  assert.deepEqual(statuses, ["connecting", "live"]);

  controller.close();
});

test("subscribe protocol error closes the socket and reconnects only once", () => {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  const statuses: string[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    commandTimeoutMs: 0,
    setTimer: (callback, delayMs) => {
      scheduled.push(callback);
      delays.push(delayMs);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });

  controller.start();
  sockets[0]?.open();
  const subscribe = JSON.parse(sockets[0]?.sent[0] || "{}") as { request_id?: string };
  sockets[0]?.message({
    type: "error",
    request_id: subscribe.request_id,
    code: "SUBSCRIBE_FAILED",
    detail: "temporarily unavailable",
  });
  assert.equal(sockets[0]?.closed, true);
  assert.deepEqual(delays, [10]);
  assert.equal(scheduled.length, 1);

  // A delayed close/error from the failed socket must not create another timer.
  sockets[0]?.serverClose();
  assert.equal(scheduled.length, 1);
  scheduled[0]?.();
  assert.equal(sockets.length, 2);
  sockets[1]?.open();
  sockets[1]?.message({ type: "error", code: "SUBSCRIBE_FAILED" });
  assert.deepEqual(delays, [10, 20]);
  assert.ok(statuses.includes("reconnecting"));

  controller.close();
});

test("missing command ack reconnects and applies the latest desired channels", () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const errors: unknown[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    channels: SUMMARY_CHANNELS,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onError: (error) => errors.push(error),
    reconnectBaseMs: 10,
    reconnectMaxMs: 10,
    commandTimeoutMs: 25,
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });

  controller.start();
  const firstSocket = sockets[0] as FakeSocket;
  firstSocket.open();
  assert.deepEqual(commandChannels(firstSocket, 0), [...SUMMARY_CHANNELS]);
  assert.equal(timers[0]?.delayMs, 25);

  controller.setChannels([...SUMMARY_CHANNELS, "open_interest"]);
  timers[0]?.callback();
  assert.equal(firstSocket.closed, true);
  assert.match(String(errors[0]), /acknowledgement timed out after 25ms/);
  assert.equal(timers[1]?.delayMs, 10);

  timers[1]?.callback();
  assert.equal(sockets.length, 2);
  const secondSocket = sockets[1] as FakeSocket;
  secondSocket.open();
  assert.deepEqual(
    commandChannels(secondSocket, 0),
    [...SUMMARY_CHANNELS, "open_interest"],
  );
  secondSocket.message(commandAck(secondSocket, 0));
  assert.equal(timers[2]?.delayMs, 25);
  timers[2]?.callback();
  assert.equal(secondSocket.closed, false);

  controller.close();
});

test("matching subscribed ack enters live and active close releases without reconnect", () => {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  const statuses: string[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
    commandTimeoutMs: 0,
    setTimer: (callback) => {
      scheduled.push(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });

  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(subscribeAck(sockets[0] as FakeSocket));
  assert.equal(statuses.at(-1), "live");

  controller.close();
  const unsubscribe = JSON.parse(sockets[0]?.sent.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(unsubscribe.action, "unsubscribe");
  assert.equal(sockets[0]?.closed, true);
  sockets[0]?.serverClose();
  assert.equal(scheduled.length, 0);
});

test("setChannels incrementally subscribes and unsubscribes on the existing socket", () => {
  const sockets: FakeSocket[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    channels: SUMMARY_CHANNELS,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  assert.deepEqual(commandChannels(socket, 0), [...SUMMARY_CHANNELS]);
  socket.message(commandAck(socket, 0));

  controller.setChannels([...SUMMARY_CHANNELS, "funding_rate"]);
  assert.equal(sockets.length, 1);
  assert.equal(commandAt(socket, 1).action, "subscribe");
  assert.deepEqual(commandChannels(socket, 1), ["funding_rate"]);
  socket.message(commandAck(socket, 1));

  controller.setChannels(SUMMARY_CHANNELS);
  assert.equal(sockets.length, 1);
  assert.equal(commandAt(socket, 2).action, "unsubscribe");
  assert.deepEqual(commandChannels(socket, 2), ["funding_rate"]);
  socket.message(commandAck(socket, 2));

  controller.close();
  assert.equal(commandAt(socket, 3).action, "unsubscribe");
  assert.deepEqual(commandChannels(socket, 3), [...SUMMARY_CHANNELS]);
  assert.equal(socket.closed, true);
});

test("setChannels coalesces target changes while a channel command ack is pending", () => {
  const sockets: FakeSocket[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    channels: SUMMARY_CHANNELS,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message(commandAck(socket, 0));

  controller.setChannels([...SUMMARY_CHANNELS, "funding_rate"]);
  controller.setChannels([...SUMMARY_CHANNELS, "open_interest"]);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(commandChannels(socket, 1), ["funding_rate"]);

  socket.message(commandAck(socket, 1));
  assert.equal(commandAt(socket, 2).action, "unsubscribe");
  assert.deepEqual(commandChannels(socket, 2), ["funding_rate"]);

  controller.setChannels([...SUMMARY_CHANNELS, "funding_rate", "open_interest"]);
  assert.equal(socket.sent.length, 3);
  socket.message(commandAck(socket, 2));
  assert.equal(commandAt(socket, 3).action, "subscribe");
  assert.deepEqual(commandChannels(socket, 3), ["funding_rate", "open_interest"]);

  socket.message(commandAck(socket, 3));
  controller.close();
  assert.equal(sockets.length, 1);
  assert.equal(commandAt(socket, 4).action, "unsubscribe");
  assert.deepEqual(
    commandChannels(socket, 4),
    [...SUMMARY_CHANNELS, "funding_rate", "open_interest"],
  );
});

test("active summary updates continue while an incremental subscription is pending", () => {
  const sockets: FakeSocket[] = [];
  const records: MarketStateRecord[][] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    channels: SUMMARY_CHANNELS,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onRecords: (nextRecords) => records.push(nextRecords),
  });

  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message(commandAck(socket, 0));
  controller.setChannels([...SUMMARY_CHANNELS, "funding_rate"]);

  socket.message({
    type: "update",
    protocol: "market.v1",
    data: [marketRecord("mark_price", { mark_price: 100 })],
  });
  assert.equal(sockets.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.[0]?.channel, "mark_price");

  socket.message(commandAck(socket, 1));
  controller.close();
});

test("close during a pending subscribe only releases confirmed active channels", () => {
  const sockets: FakeSocket[] = [];
  const controller = new MarketStreamController({
    url: "ws://example/market",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    channels: SUMMARY_CHANNELS,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  controller.start();
  const socket = sockets[0] as FakeSocket;
  socket.open();
  socket.message(commandAck(socket, 0));
  controller.setChannels([...SUMMARY_CHANNELS, "open_interest"]);
  assert.deepEqual(commandChannels(socket, 1), ["open_interest"]);

  controller.close();
  assert.equal(commandAt(socket, 2).action, "unsubscribe");
  assert.deepEqual(commandChannels(socket, 2), [...SUMMARY_CHANNELS]);
  assert.equal(socket.closed, true);
});
