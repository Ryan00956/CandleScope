import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayEvent, parseReplaySessionResponse } from "../replayParser.js";
import { BASE_TIME_MS, replayDeltaEvent, replayFill, replaySessionResponse } from "./fixtures.js";

interface MutableSnapshotFixture {
  components: {
    orders: unknown[];
    fills: unknown[];
    closed_trades: unknown[];
    warnings: unknown[];
  };
}

interface MutableDeltaFixture {
  virtual_time_ms: number;
  data: {
    projection: {
      bar_update: { action: string; source_sequence: number } | null;
      orders: unknown[];
      fills: unknown[];
      warnings: unknown[];
    };
  };
}

function replayOrder(sourceSequence: number) {
  return {
    order_id: "order-0001",
    client_order_id: "client-0001",
    side: "BUY",
    order_type: "MARKET",
    quantity: "1",
    reduce_only: false,
    limit_price: null,
    stop_price: null,
    status: "PENDING",
    filled_quantity: "0",
    remaining_quantity: "1",
    average_fill_price: null,
    accepted_source_sequence: sourceSequence,
    created_time_ms: BASE_TIME_MS + 59_999,
    ordinal: 1,
    reserved_margin: "0",
    status_reason: null,
    status_history: ["PENDING"],
    model_version: "paper-linear.v1",
  };
}

test("snapshot parser rejects a bar published beyond the public cursor", () => {
  const response = structuredClone(replaySessionResponse());
  const snapshot = response.snapshot;
  const builder = snapshot.components.bar_builder;
  const bar = builder.closed_bars[0];
  assert.ok(bar);
  bar.open_time_ms = snapshot.cursor.virtual_time_ms + 1;
  bar.close_time_ms = bar.open_time_ms + 59_999;
  bar.first_base_open_ms = bar.open_time_ms;
  bar.last_base_open_ms = bar.open_time_ms;
  assert.throws(() => parseReplaySessionResponse(response), /unrevealed bar time/);
});

test("delta parser rejects source events and fills beyond virtual time", () => {
  const futureSource = structuredClone(replayDeltaEvent());
  futureSource.data.source_event.close_time_ms = futureSource.virtual_time_ms + 1;
  assert.throws(() => parseReplayEvent(futureSource), /unrevealed source event/);

  const futureFill = replayDeltaEvent({ fills: [replayFill(9_000_000_000_000)] });
  assert.throws(() => parseReplayEvent(futureFill), /future fill/);
});

test("snapshot parser rejects every broker artifact causally newer than the source cursor", () => {
  const mutations = [
    (snapshot: MutableSnapshotFixture) => {
      snapshot.components.orders = [replayOrder(1)];
    },
    (snapshot: MutableSnapshotFixture) => {
      snapshot.components.fills = [{ ...replayFill(BASE_TIME_MS + 59_999), source_sequence: 1 }];
    },
    (snapshot: MutableSnapshotFixture) => {
      snapshot.components.closed_trades = [{
        trade_id: "trade-0001",
        order_id: "order-0001",
        fill_id: "fill-0001",
        side: "BUY",
        quantity: "1",
        entry_price: "100",
        exit_price: "101",
        realized_pnl: "1",
        source_sequence: 1,
      }];
    },
    (snapshot: MutableSnapshotFixture) => {
      snapshot.components.warnings = [{
        warning_id: "warning-0001",
        code: "AMBIGUOUS_BAR",
        source_sequence: 1,
        order_ids: [],
        message: "future warning",
      }];
    },
  ];

  for (const mutate of mutations) {
    const response = replaySessionResponse();
    mutate(response.snapshot as unknown as MutableSnapshotFixture);
    assert.throws(() => parseReplaySessionResponse(response), /causal source sequence 1 exceeds revealed cursor 0/);
  }
});

test("delta projection cannot publish future bar, order, fill, or warning sequences", () => {
  const mutations = [
    (event: MutableDeltaFixture) => {
      if (event.data.projection.bar_update && event.data.projection.bar_update.action !== "batch") {
        event.data.projection.bar_update.source_sequence = 2;
      }
    },
    (event: MutableDeltaFixture) => {
      event.data.projection.orders = [replayOrder(2)];
    },
    (event: MutableDeltaFixture) => {
      event.data.projection.fills = [{ ...replayFill(event.virtual_time_ms), source_sequence: 2 }];
    },
    (event: MutableDeltaFixture) => {
      event.data.projection.warnings = [{
        warning_id: "warning-0001",
        code: "AMBIGUOUS_BAR",
        source_sequence: 2,
        order_ids: [],
        message: "future warning",
      }];
    },
  ];

  for (const mutate of mutations) {
    const event = replayDeltaEvent({ sourceSequence: 1 });
    mutate(event as unknown as MutableDeltaFixture);
    assert.throws(() => parseReplayEvent(event), /causal source sequence 2 exceeds revealed cursor 1/);
  }
});
