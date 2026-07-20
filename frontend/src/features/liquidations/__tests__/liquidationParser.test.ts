import assert from "node:assert/strict";
import test from "node:test";

import {
  LiquidationPayloadError,
  parseLiquidationHistoryPayload,
  parseLiquidationRollup,
  parseLiquidationSocketMessage,
} from "../liquidationParser.js";

const quality = {
  source_quality: "sampled_best_effort",
  source_exhaustive: false,
  sampling_mode: "latest_per_symbol_1000ms",
  lossy_snapshot: true,
  backfillable: false,
  exchange_update_interval_ms: 1000,
} as const;

function event(overrides: Record<string, unknown> = {}) {
  return {
    exchange: "binance",
    market_type: "futures",
    symbol: "BTCUSDT",
    order_side: "SELL",
    position_side: "long",
    filled_quantity: 0.5,
    executed_notional: 25_000,
    trade_time_ms: 1_700_000_000_100,
    event_time_ms: 1_700_000_000_110,
    received_at_ms: 1_700_000_000_120,
    source: "websocket",
    fingerprint: "event-1",
    source_quality: "sampled_best_effort",
    source_exhaustive: false,
    ...overrides,
  };
}

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    exchange: "binance",
    market_type: "futures",
    symbol: "BTCUSDT",
    period: "1m",
    position_side: "long",
    bucket_start_ms: 1_700_000_000_000,
    bucket_end_ms: 1_700_000_060_000,
    filled_quantity: 0.5,
    filled_notional: 25_000,
    event_count: 1,
    max_event_notional: 25_000,
    first_event_time_ms: 1_700_000_000_100,
    last_event_time_ms: 1_700_000_000_100,
    is_final: true,
    revision: 1,
    updated_at_ms: 1_700_000_000_120,
    source_quality: "sampled_best_effort",
    source_exhaustive: false,
    ...overrides,
  };
}

test("liquidation history parser preserves observed-only quality and direction buckets", () => {
  const payload = parseLiquidationHistoryPayload({
    type: "liquidation.history",
    protocol: "liquidation.v1",
    key: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "liquidation",
      params: { period: "1m", position_side: "long" },
    },
    count: 1,
    data: [rollup()],
    has_more: false,
    coverage: {
      earliest_ms: 1_700_000_000_000,
      latest_ms: 1_700_000_000_000,
      all_rows_final: true,
      observed_only: true,
    },
    ...quality,
  });

  assert.equal(payload.data[0]?.positionSide, "long");
  assert.equal(payload.data[0]?.filledNotional, 25_000);
  assert.deepEqual(payload.quality, {
    sourceQuality: "sampled_best_effort",
    sourceExhaustive: false,
    samplingMode: "latest_per_symbol_1000ms",
    lossySnapshot: true,
    backfillable: false,
    exchangeUpdateIntervalMs: 1000,
  });
});

test("liquidation rollups reject storage timestamp aliases at the v1 boundary", () => {
  assert.throws(
    () => parseLiquidationRollup(rollup({
      updated_at_ms: undefined,
      received_at_ms: 1_700_000_000_120,
    })),
    (error) => error instanceof LiquidationPayloadError
      && error.path === "liquidation.rollup.updated_at_ms",
  );
});

test("liquidation socket parser rejects dishonest quality and side conflicts", () => {
  assert.throws(() => parseLiquidationSocketMessage({
    type: "recent",
    protocol: "liquidation.v1",
    request_id: "liq-1",
    data: [event({ position_side: "short" })],
    ...quality,
  }), LiquidationPayloadError);

  assert.throws(() => parseLiquidationSocketMessage({
    type: "connected",
    protocol: "liquidation.v1",
    ...quality,
    backfillable: true,
  }), /backfillable/);
});

test("liquidation batches require explicit delivery continuity", () => {
  const parsed = parseLiquidationSocketMessage({
    type: "liquidation.batch",
    protocol: "liquidation.v1",
    sequence: 7,
    delivery_continuity: true,
    resync_required: false,
    dropped_before: 0,
    data: [event()],
    ...quality,
  });
  assert.equal(parsed.type, "liquidation.batch");
  if (parsed.type === "liquidation.batch") {
    assert.equal(parsed.sequence, 7);
    assert.equal(parsed.data[0]?.executedNotional, 25_000);
  }
});
