import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdvancedMarketPanes,
  projectMetricRecordsToCandles,
  resolveOpenInterestPeriod,
} from "../metricPaneProjection.js";
import type {
  AdvancedMarketChannel,
  AdvancedMarketMetricsSnapshot,
  MarketStateRecord,
} from "../advancedMarketDataTypes.js";
import { epochSeconds } from "../../../test/testHelpers.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";

const BARS: KlineBar[] = [0, 180, 360, 540].map((time) => ({ time: epochSeconds(time) }));

function record(
  channel: AdvancedMarketChannel,
  eventTimeMs: number,
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
    event_time_ms: eventTimeMs,
    received_at_ms: eventTimeMs + 1000,
    source: "http",
    sequence: null,
    revision: 0,
    data,
  };
}

test("5m samples first appear on the next available 3m bar without lookahead", () => {
  const points = projectMetricRecordsToCandles([
    record("open_interest", 300_000, { open_interest: 10 }),
  ], BARS, { valueField: "open_interest" });

  assert.deepEqual(points, [{ time: epochSeconds(360), value: 10 }]);
  assert.equal(points.some((point) => point.time === epochSeconds(180)), false);
});

test("final OI wins its as-of bucket and latest provisional OI covers the forming tail", () => {
  const provisional = record("open_interest", 290_000, {
    open_interest: 10,
    is_final: false,
    sample_kind: "provisional",
  });
  const finalized = record("open_interest", 300_000, {
    open_interest: 20,
    is_final: true,
    sample_kind: "final",
  });
  const tail = record("open_interest", 600_000, {
    open_interest: 30,
    is_final: false,
    sample_kind: "provisional",
  });
  const metrics: AdvancedMarketMetricsSnapshot = {
    fundingHistory: [],
    fundingPreview: null,
    openInterestHistory: [provisional, finalized, tail],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  };
  const panes = buildAdvancedMarketPanes(metrics, BARS);
  const oiData = panes[1]?.lines[0]?.data;

  assert.deepEqual(oiData, [
    { time: epochSeconds(360), value: 20 },
    { time: epochSeconds(540), value: 30 },
  ]);
  assert.equal(panes[1]?.dataMarketPane, "open-interest");
});

test("funding settlement is as-of aligned while preview overwrites only current tail", () => {
  const settlement = record("funding_rate", 300_000, {
    funding_rate: 0.0001,
    funding_time_ms: 300_000,
    is_final: true,
    sample_kind: "settlement",
  });
  const preview = record("funding_rate", 900_000, {
    funding_rate: -0.0002,
    next_funding_time_ms: 2_000_000,
    is_final: false,
    sample_kind: "preview",
  });
  const metrics: AdvancedMarketMetricsSnapshot = {
    fundingHistory: [settlement],
    fundingPreview: preview,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  };
  const panes = buildAdvancedMarketPanes(metrics, BARS);

  assert.deepEqual(panes[0]?.lines[0]?.data, [
    { time: epochSeconds(360), value: 0.01, color: "#22c55e" },
    { time: epochSeconds(540), value: -0.02, color: "#ef4444" },
  ]);
  assert.equal(panes[0]?.dataMarketPane, "funding-rate");
});

test("OI period follows chart resolution with a 5m floor", () => {
  assert.equal(resolveOpenInterestPeriod("3m"), "5m");
  assert.equal(resolveOpenInterestPeriod("5m"), "5m");
  assert.equal(resolveOpenInterestPeriod("8h"), "6h");
  assert.equal(resolveOpenInterestPeriod("1d"), "1d");
});

test("market pane projection only returns explicitly requested studies", () => {
  const metrics: AdvancedMarketMetricsSnapshot = {
    fundingHistory: [],
    fundingPreview: null,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 0,
  };

  assert.deepEqual(
    buildAdvancedMarketPanes(metrics, BARS, ["open_interest"]).map((pane) => pane.id),
    ["advanced-open-interest"],
  );
  assert.deepEqual(buildAdvancedMarketPanes(metrics, BARS, []), []);
});
