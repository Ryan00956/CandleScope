import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketStreamController,
  type AdvancedMarketSocket,
} from "../marketStreamController.js";

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

function subscribeAck(socket: FakeSocket): Record<string, unknown> {
  const subscribe = JSON.parse(socket.sent[0] || "{}") as {
    request_id?: string;
    streams?: Array<Record<string, unknown>>;
  };
  return {
    type: "subscribed",
    request_id: subscribe.request_id,
    streams: (subscribe.streams || []).map((stream) => ({ ...stream, params: {} })),
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
