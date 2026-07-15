import assert from "node:assert/strict";
import test from "node:test";

import {
  AdvancedMarketPayloadError,
  parseMarketHistoryPayload,
  parseMarketSnapshotPayload,
} from "../advancedMarketDataParser.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    key: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "funding_rate",
      params: {},
    },
    topic: "binance:futures:BTCUSDT@funding_rate",
    channel: "funding_rate",
    event_time_ms: 1_700_000_000_000,
    received_at_ms: 1_700_000_000_010,
    source: "http",
    sequence: null,
    data: {
      funding_rate: 0.0001,
      funding_time_ms: 1_700_000_000_000,
      is_final: true,
      sample_kind: "settlement",
    },
    ...overrides,
  };
}

test("history accepts MarketStateEvent rows without Hub revision", () => {
  const parsed = parseMarketHistoryPayload({
    type: "market.history",
    key: record().key,
    count: 1,
    data: [record()],
    coverage: {
      earliest_ms: 1_700_000_000_000,
      latest_ms: 1_700_000_000_000,
      complete: true,
    },
  });

  assert.equal(parsed.data[0]?.revision, 0);
  assert.equal(parsed.data[0]?.data.sample_kind, "settlement");
});

test("history parses terminal availability metadata for empty pages", () => {
  const parsed = parseMarketHistoryPayload({
    type: "market.history",
    key: record().key,
    count: 0,
    data: [],
    coverage: {
      earliest_ms: null,
      latest_ms: null,
      complete: false,
    },
    history_state: "exhausted",
    complete: true,
    retryable: false,
    terminal_reason: "provider_retention",
    earliest_available_ms: 1_700_000_000_000,
    next_before_ms: null,
    availability_revision: "history-v2",
    excluded_ranges: [{
      start_ms: 1_699_999_000_000,
      end_ms: 1_699_999_999_999,
      reason: "market_closed",
    }],
  });

  assert.equal(parsed.history_state, "exhausted");
  assert.equal(parsed.retryable, false);
  assert.equal(parsed.terminal_reason, "provider_retention");
  assert.deepEqual(parsed.excluded_ranges, [{
    start_ms: 1_699_999_000_000,
    end_ms: 1_699_999_999_999,
    reason: "market_closed",
  }]);
});

test("snapshot and websocket-grade Hub records still require revision", () => {
  assert.throws(() => parseMarketSnapshotPayload({
    type: "market.snapshot",
    as_of_ms: 1_700_000_000_100,
    data: [record()],
    missing: [],
  }), AdvancedMarketPayloadError);

  const parsed = parseMarketSnapshotPayload({
    type: "market.snapshot",
    as_of_ms: 1_700_000_000_100,
    data: [record({ revision: 3 })],
    missing: [],
  });
  assert.equal(parsed.data[0]?.revision, 3);
});

test("optional persistence semantics are validated", () => {
  assert.throws(() => parseMarketHistoryPayload({
    type: "market.history",
    key: record().key,
    count: 1,
    data: [record({ data: { funding_rate: 0.1, is_final: "yes" } })],
    coverage: { earliest_ms: null, latest_ms: null, complete: false },
  }), AdvancedMarketPayloadError);

  assert.throws(() => parseMarketHistoryPayload({
    type: "market.history",
    key: record().key,
    count: 1,
    data: [record({ data: { funding_rate: 0.1, sample_kind: "" } })],
    coverage: { earliest_ms: null, latest_ms: null, complete: false },
  }), AdvancedMarketPayloadError);
});
