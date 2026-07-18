import assert from "node:assert/strict";
import test from "node:test";

import {
  LiquidationStreamController,
  type LiquidationSocket,
} from "../liquidationStreamController.js";

const quality = {
  source_quality: "sampled_best_effort",
  source_exhaustive: false,
  sampling_mode: "latest_per_symbol_1000ms",
  lossy_snapshot: true,
  backfillable: false,
  exchange_update_interval_ms: 1000,
} as const;

class FakeSocket implements LiquidationSocket {
  readonly OPEN = 1;
  readyState = 1;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.readyState = 3; }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

function event() {
  return {
    exchange: "binance",
    market_type: "futures",
    symbol: "BTCUSDT",
    order_side: "SELL",
    position_side: "long",
    filled_quantity: 1,
    executed_notional: 25_000,
    trade_time_ms: 1_700_000_000_000,
    event_time_ms: 1_700_000_000_010,
    received_at_ms: 1_700_000_000_020,
    source: "websocket",
    fingerprint: "event-1",
    source_quality: "sampled_best_effort",
    source_exhaustive: false,
  };
}

test("liquidation stream becomes live only after the recent snapshot", () => {
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const notionals: number[] = [];
  const controller = new LiquidationStreamController({
    url: "ws://example/liquidations",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    socketFactory: () => socket,
    commandTimeoutMs: 0,
    onStatus: (status) => statuses.push(status),
    onEvents: (events) => notionals.push(...events.map((item) => item.executedNotional)),
  });

  controller.start();
  socket.message({ type: "connected", protocol: "liquidation.v1", ...quality });
  const command = JSON.parse(socket.sent[0] || "{}") as {
    request_id: string;
    streams: unknown[];
  };
  assert.equal(command.streams.length, 1);
  socket.message({
    type: "subscribed",
    protocol: "liquidation.v1",
    request_id: command.request_id,
    streams: [{
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "liquidation",
      params: {},
    }],
    ...quality,
  });
  assert.deepEqual(statuses, ["connecting"]);
  socket.message({
    type: "recent",
    protocol: "liquidation.v1",
    request_id: command.request_id,
    data: [event()],
    ...quality,
  });
  assert.deepEqual(statuses, ["connecting", "live"]);
  assert.deepEqual(notionals, [25_000]);
  controller.close();
});

test("liquidation delivery discontinuity requests resync and reconnects fail closed", () => {
  const socket = new FakeSocket();
  const timers: Array<() => void> = [];
  const statuses: string[] = [];
  let resyncs = 0;
  const controller = new LiquidationStreamController({
    url: "ws://example/liquidations",
    identity: { exchange: "binance", marketType: "futures", symbol: "BTCUSDT" },
    socketFactory: () => socket,
    commandTimeoutMs: 0,
    reconnectBaseMs: 10,
    reconnectMaxMs: 10,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
    onStatus: (status) => statuses.push(status),
    onResyncRequired: () => { resyncs += 1; },
  });
  controller.start();
  socket.message({
    type: "resync_required",
    protocol: "liquidation.v1",
    code: "LIQUIDATION_DELIVERY_DISCONTINUITY",
    sequence: 2,
    delivery_continuity: false,
    resync_required: true,
    dropped_before: 1,
    ...quality,
  });
  assert.equal(resyncs, 1);
  assert.equal(socket.closed, true);
  assert.equal(timers.length, 1);
  assert.deepEqual(statuses, ["connecting", "reconnecting"]);
  controller.close();
});
