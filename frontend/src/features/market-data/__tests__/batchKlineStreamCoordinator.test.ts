import assert from "node:assert/strict";
import test from "node:test";

import type { KlineStreamSocket } from "../klineContracts.js";
import { BatchKlineStreamCoordinator } from "../feed/batchKlineStreamCoordinator.js";
import { resolveKlineBatchStreamEnabled } from "../klineBatchFeature.js";

class FakeSocket implements KlineStreamSocket {
  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

test("batch K-line flag is strict and default-off", () => {
  assert.equal(resolveKlineBatchStreamEnabled(), false);
  assert.equal(resolveKlineBatchStreamEnabled({ KLINE_BATCH_STREAM_ENABLED: "1" }), true);
  assert.equal(resolveKlineBatchStreamEnabled({ KLINE_BATCH_STREAM_ENABLED: "true" }), false);
});

test("different instruments share one batch socket with isolated stable client IDs", () => {
  const sockets: FakeSocket[] = [];
  const controls: Array<{ owner: string; type: string; active: readonly string[] }> = [];
  const ticks: Array<{ owner: string; interval: string }> = [];
  const coordinator = new BatchKlineStreamCoordinator({
    url: "ws://test/stream/klines_batch",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const btc = coordinator.subscribe(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      intervals: ["1m"],
      onControlMessage: (message) => controls.push({
        owner: "btc",
        type: message.type,
        active: message.active_intervals || [],
      }),
      onKline: (event) => ticks.push({ owner: "btc", interval: event.interval }),
    },
  );
  const eth = coordinator.subscribe(
    { exchange: "okx", marketType: "spot", symbol: "ETH-USDT" },
    {
      intervals: ["5m"],
      onControlMessage: (message) => controls.push({
        owner: "eth",
        type: message.type,
        active: message.active_intervals || [],
      }),
      onKline: (event) => ticks.push({ owner: "eth", interval: event.interval }),
    },
  );

  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  socket.open();
  const subscribe = JSON.parse(socket.sent[0]!) as {
    action: string;
    items: Array<{ clientId: string; symbol: string }>;
  };
  assert.equal(subscribe.action, "subscribe");
  assert.deepEqual(subscribe.items.map((item) => item.symbol), ["BTCUSDT", "ETH-USDT"]);
  assert.equal(new Set(subscribe.items.map((item) => item.clientId)).size, 2);

  const btcId = subscribe.items[0]!.clientId;
  const ethId = subscribe.items[1]!.clientId;
  socket.message({
    type: "subscription_ack",
    action: "subscribe",
    ok: true,
    client_id: btcId,
    active_intervals: ["1m"],
  });
  socket.message({
    type: "kline",
    protocol: "candlescope.kline-batch/1",
    client_id: ethId,
    exchange: "okx",
    market_type: "spot",
    symbol: "ETH-USDT",
    interval: "5m",
    data: { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 },
  });
  assert.deepEqual(controls, [{ owner: "btc", type: "subscribed", active: ["1m"] }]);
  assert.deepEqual(ticks, [{ owner: "eth", interval: "5m" }]);

  btc.updateIntervals(["15m"]);
  const update = JSON.parse(socket.sent.at(-1)!) as {
    action: string;
    items: Array<{ clientId: string; intervals: string[] }>;
  };
  assert.equal(update.action, "update");
  assert.equal(update.items[0]!.clientId, btcId);
  assert.deepEqual(update.items[0]!.intervals, ["15m"]);
  assert.deepEqual(coordinator.diagnostics(), {
    mode: "batch",
    physicalStreams: 1,
    open: true,
    logicalSubscribers: 2,
    logicalSubscriptions: 2,
    clientIds: [btcId, ethId].sort(),
  });

  btc.close();
  assert.equal(socket.closed, false);
  eth.close();
  assert.equal(socket.closed, true);
  assert.equal(coordinator.activePhysicalStreamCount(), 0);
});
