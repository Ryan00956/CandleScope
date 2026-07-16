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
    fundingRealtimeHistory: [],
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
  const preview = record("funding_rate", 704_000, {
    funding_rate: -0.0002,
    next_funding_time_ms: 2_000_000,
    is_final: false,
    sample_kind: "preview",
  });
  const metrics: AdvancedMarketMetricsSnapshot = {
    fundingHistory: [settlement],
    fundingRealtimeHistory: [preview],
    fundingPreview: preview,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  };
  const panes = buildAdvancedMarketPanes(metrics, BARS);

  assert.deepEqual(panes[0]?.lines[0]?.data, [
    { time: epochSeconds(360), value: 0.01, color: "#22c55e" },
    { time: epochSeconds(540), value: -0.02, color: "#fb7185" },
  ]);
  assert.equal(panes[0]?.dataMarketPane, "funding-rate");
});

test("funding hybrid trajectory is dense, source-aware, carried as-of, and settlement wins", () => {
  const hybridBars: KlineBar[] = [0, 180, 360, 540, 720]
    .map((time) => ({ time: epochSeconds(time) }));
  const estimates = hybridBars.map((bar, index) => record("funding_rate", bar.time * 1000, {
    funding_rate: (index + 1) * 0.00001,
    sample_time_ms: (bar.time + 180) * 1000,
    target_funding_time_ms: 900_000,
    is_final: false,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    formula_version: "binance-premium-v1",
    input_resolution: "1m",
    input_coverage: 1,
  }));
  const settlement = record("funding_rate", 360_000, {
    funding_rate: -0.0002,
    funding_time_ms: 360_000,
    funding_cycle_ms: 360_000,
    is_final: true,
    sample_kind: "settlement",
    provenance: "exchange_settlement",
    quality: "final",
  });
  const realtime = record("funding_rate", 359_000, {
    funding_rate: 0.0003,
    observed_at_ms: 359_000,
    next_funding_time_ms: 800_000,
    funding_cycle_ms: 800_000,
    is_final: false,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    carried: false,
    stale: false,
  });
  const metrics: AdvancedMarketMetricsSnapshot = {
    fundingHistory: [...estimates, settlement],
    fundingRealtimeHistory: [realtime],
    fundingPreview: realtime,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  };

  const fundingPane = buildAdvancedMarketPanes(metrics, hybridBars, ["funding_rate"])[0];
  assert.deepEqual(fundingPane?.lines[0]?.data.map((point) => [point.time, point.value]), [
    [epochSeconds(0), 0.001],
    [epochSeconds(180), 0.03],
    [epochSeconds(360), -0.02],
    [epochSeconds(540), 0.03],
    [epochSeconds(720), 0.005],
  ]);
  assert.deepEqual(fundingPane?.pointMetadata?.map((point) => point.appearance), [
    "estimated",
    "realtime",
    "solid",
    "carried",
    "estimated",
  ]);
  assert.match(fundingPane?.pointMetadata?.[0]?.accessibilityLabel || "", /模型历史估算/);
  assert.match(fundingPane?.pointMetadata?.[2]?.accessibilityLabel || "", /交易所历史结算/);
  assert.equal(fundingPane?.legendItems?.length, 4);
});

test("funding realtime without a target is limited to its observed K", () => {
  const bars: KlineBar[] = [0, 180, 360].map((time) => ({ time: epochSeconds(time) }));
  const estimates = bars.map((bar) => record("funding_rate", bar.time * 1000, {
    funding_rate: 0.0001,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  }));
  const realtime = record("funding_rate", 100_000, {
    funding_rate: 0.0002,
    observed_at_ms: 100_000,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    is_final: false,
  });
  const pane = buildAdvancedMarketPanes({
    fundingHistory: estimates,
    fundingRealtimeHistory: [realtime],
    fundingPreview: realtime,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  }, bars, ["funding_rate"], "3m", 540_000)[0];

  assert.deepEqual(pane?.pointMetadata?.map((point) => point.sourceLabel), [
    "交易所实时预估",
    "模型历史估算",
    "模型历史估算",
  ]);
});

test("funding realtime never survives a target boundary inside a large K", () => {
  const estimate = record("funding_rate", 0, {
    funding_rate: 0.0001,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  });
  const realtime = record("funding_rate", 10_000_000, {
    funding_rate: 0.0002,
    observed_at_ms: 10_000_000,
    next_funding_time_ms: 28_800_000,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    is_final: false,
  });
  const pane = buildAdvancedMarketPanes({
    fundingHistory: [estimate],
    fundingRealtimeHistory: [realtime],
    fundingPreview: realtime,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  }, [{ time: epochSeconds(0) }], ["funding_rate"], "12h", 30_000_000)[0];

  assert.equal(pane?.pointMetadata?.[0]?.sourceLabel, "模型历史估算");
});

test("funding realtime includes the K ending at target but not the K starting there", () => {
  const bars: KlineBar[] = [0, 180].map((time) => ({ time: epochSeconds(time) }));
  const estimates = bars.map((bar) => record("funding_rate", bar.time * 1000, {
    funding_rate: 0.0001,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  }));
  const realtime = record("funding_rate", 100_000, {
    funding_rate: 0.0002,
    observed_at_ms: 100_000,
    next_funding_time_ms: 180_000,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    is_final: false,
  });
  const pane = buildAdvancedMarketPanes({
    fundingHistory: estimates,
    fundingRealtimeHistory: [realtime],
    fundingPreview: realtime,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  }, bars, ["funding_rate"], "3m", 360_000)[0];

  assert.deepEqual(pane?.pointMetadata?.map((point) => point.sourceLabel), [
    "交易所实时预估",
    "模型历史估算",
  ]);
});

test("hybrid settlement uses its chart bucket open while sparse settlement keeps raw time", () => {
  const bars: KlineBar[] = [0, 43_200, 86_400].map((time) => ({ time: epochSeconds(time) }));
  const baseSettlement = record("funding_rate", 0, {
    funding_rate: 0.0001,
    funding_time_ms: 28_800_000,
    raw_funding_time_ms: 28_800_000,
    sample_kind: "settlement",
    provenance: "exchange_settlement",
    quality: "final",
    is_final: true,
  });
  const hybridSettlement: MarketStateRecord = {
    ...baseSettlement,
    key: {
      ...baseSettlement.key,
      params: { period: "12h", view: "hybrid" },
    },
  };
  const metrics = (settlement: MarketStateRecord): AdvancedMarketMetricsSnapshot => ({
    fundingHistory: [settlement],
    fundingRealtimeHistory: [],
    fundingPreview: null,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  });

  assert.equal(
    buildAdvancedMarketPanes(metrics(hybridSettlement), bars, ["funding_rate"], "12h")[0]
      ?.lines[0]?.data[0]?.time,
    epochSeconds(0),
  );
  assert.equal(
    buildAdvancedMarketPanes(metrics(baseSettlement), bars, ["funding_rate"], "12h")[0]
      ?.lines[0]?.data[0]?.time,
    epochSeconds(43_200),
  );
});

test("funding hybrid trajectory supports second-level chart periods", () => {
  const bars: KlineBar[] = [0, 1, 2].map((time) => ({ time: epochSeconds(time) }));
  const estimates = bars.map((bar, index) => record("funding_rate", bar.time * 1000, {
    funding_rate: (index + 1) * 0.00001,
    sample_time_ms: (bar.time + 1) * 1000,
    target_funding_time_ms: 28_800_000,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
    input_resolution: "1m",
  }));
  const pane = buildAdvancedMarketPanes({
    fundingHistory: estimates,
    fundingRealtimeHistory: [],
    fundingPreview: null,
    openInterestHistory: [],
    openInterestPeriod: "5m",
    connectionStatus: "live",
    revision: 1,
  }, bars, ["funding_rate"], "1s", 3_000)[0];

  assert.equal(pane?.lines[0]?.data.length, 3);
  assert.ok(pane?.pointMetadata?.every((point) => point.appearance === "estimated"));
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
    fundingRealtimeHistory: [],
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
