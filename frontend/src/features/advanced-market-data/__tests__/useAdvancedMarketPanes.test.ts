import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import {
  hasCurrentAdvancedMarketSeries,
  shouldRunFundingRealtimeClock,
} from "../useAdvancedMarketPanes.js";
import {
  createAdvancedMarketLiquidationPaneProjectionMemo,
  createAdvancedMarketStatePaneProjectionMemo,
} from "../advancedMarketPaneProjectionMemo.js";
import type { FundingRateHistoryProjection } from "../metricPaneProjection.js";
import type { MarketStateRecord } from "../advancedMarketDataTypes.js";
import type {
  LiquidationRuntimeView,
  LiquidationSnapshot,
} from "../../liquidations/liquidationTypes.js";
import { epochSeconds, structuralMock } from "../../../test/testHelpers.js";

function bars(times: number[]): KlineBar[] {
  return times.map((time) => ({
    time: epochSeconds(time),
    open: time,
    high: time + 1,
    low: time - 1,
    close: time + 0.5,
    volume: time * 10,
  }));
}

test("advanced market panes reject a retained store from the previous chart identity", () => {
  const previousStore = new SeriesWindowStore({
    seriesKey: "binance-futures-ETHUSDT-1h",
  });

  assert.equal(hasCurrentAdvancedMarketSeries({
    seriesKey: "binance-futures-BTCUSDT-1h",
    seriesStore: previousStore,
  }), false);
});

test("advanced market panes accept the store for the current chart identity", () => {
  const currentStore = new SeriesWindowStore({
    seriesKey: "binance-futures-BTCUSDT-1h",
  });

  assert.equal(hasCurrentAdvancedMarketSeries({
    seriesKey: "binance-futures-BTCUSDT-1h",
    seriesStore: currentStore,
  }), true);
});

test("funding clock stays stopped without a realtime tail", () => {
  assert.equal(shouldRunFundingRealtimeClock(true, 0, false), false);
  assert.equal(shouldRunFundingRealtimeClock(true, 1, false), true);
  assert.equal(shouldRunFundingRealtimeClock(true, 0, true), true);
  assert.equal(shouldRunFundingRealtimeClock(false, 1, true), false);
});

test("state pane memo isolates funding history, realtime tail, OI, and liquidation-only renders", () => {
  const bars = [{ time: epochSeconds(100) }, { time: epochSeconds(200) }];
  const fundingHistory: MarketStateRecord[] = [];
  const fundingRealtimeHistory: MarketStateRecord[] = [];
  const openInterestHistory: MarketStateRecord[] = [];
  const counts = { fundingHistory: 0, fundingPane: 0, openInterestPane: 0 };
  const baseProjection: FundingRateHistoryProjection = {
    bars,
    intervalSeconds: 100,
    points: [{ time: epochSeconds(100), value: 1, color: "#fff" }],
    metadata: [],
    settlementTimes: new Set(),
  };
  const fundingPane = {
    id: "funding",
    label: "funding",
    lines: [{ data: baseProjection.points }],
  };
  const openInterestPane = {
    id: "oi",
    label: "oi",
    lines: [{ data: [] }],
  };
  const memo = createAdvancedMarketStatePaneProjectionMemo({
    buildFundingHistory() {
      counts.fundingHistory += 1;
      return baseProjection;
    },
    buildFundingPane() {
      counts.fundingPane += 1;
      return fundingPane;
    },
    buildOpenInterestPane() {
      counts.openInterestPane += 1;
      return openInterestPane;
    },
  });
  const input = {
    bars,
    barsAxisRevision: 1,
    enabled: true,
    fundingActive: true,
    fundingHistory,
    fundingPreview: null,
    fundingRealtimeHistory,
    interval: "1m",
    nowMs: 1,
    openInterestActive: true,
    openInterestHistory,
  };

  const first = memo.project(input);
  // A liquidation-only render has no state-lane dependency change. Even if the
  // outer caller invokes the memo again, no funding/OI builder runs.
  const liquidationOnly = memo.project({ ...input, nowMs: 99 });
  assert.strictEqual(liquidationOnly, first);
  assert.deepEqual(counts, { fundingHistory: 1, fundingPane: 1, openInterestPane: 1 });

  const realtime = [{
    key: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      channel: "funding_rate" as const,
      params: {},
    },
    topic: "funding",
    channel: "funding_rate" as const,
    event_time_ms: 200_000,
    received_at_ms: 200_001,
    source: "websocket",
    sequence: 1,
    revision: 1,
    data: { funding_rate: 0.001 },
  }];
  const realtimeUpdate = memo.project({
    ...input,
    fundingRealtimeHistory: realtime,
    nowMs: 200_010,
  });
  assert.strictEqual(realtimeUpdate.openInterestPane, first.openInterestPane);
  assert.deepEqual(counts, { fundingHistory: 1, fundingPane: 2, openInterestPane: 1 });
});

function createBarRevisionProjectionHarness(store: SeriesWindowStore) {
  const counts = {
    fundingHistory: 0,
    fundingPane: 0,
    liquidationPane: 0,
    openInterestPane: 0,
  };
  const fundingHistory: MarketStateRecord[] = [];
  const fundingRealtimeHistory: MarketStateRecord[] = [];
  const openInterestHistory: MarketStateRecord[] = [];
  const stateMemo = createAdvancedMarketStatePaneProjectionMemo({
    buildFundingHistory(_history, currentBars) {
      counts.fundingHistory += 1;
      return {
        bars: currentBars,
        intervalSeconds: 60,
        points: [],
        metadata: [],
        settlementTimes: new Set(),
      };
    },
    buildFundingPane() {
      counts.fundingPane += 1;
      return {
        id: `funding-${counts.fundingPane}`,
        label: "funding",
        lines: [{ data: [] }],
      };
    },
    buildOpenInterestPane() {
      counts.openInterestPane += 1;
      return {
        id: `oi-${counts.openInterestPane}`,
        label: "oi",
        lines: [{ data: [] }],
      };
    },
  });
  const liquidationMemo = createAdvancedMarketLiquidationPaneProjectionMemo({
    buildLiquidationPane() {
      counts.liquidationPane += 1;
      return {
        id: `liquidation-${counts.liquidationPane}`,
        label: "liquidation",
        lines: [{ data: [] }],
      };
    },
  });
  const liquidationSnapshot = structuralMock<LiquidationSnapshot>({
    rollups: [],
    liveEvents: [],
    connectionStatus: "live",
    quality: null,
    revision: 0,
  });
  const liquidationView = structuralMock<LiquidationRuntimeView>({
    enabled: true,
    visible: true,
    identityKey: "binance-futures-BTCUSDT",
    connectionStatus: "live",
    error: null,
    historyError: null,
    quality: null,
  });

  return {
    counts,
    project() {
      const currentBars = store.snapshot();
      const barsAxisRevision = Number(store.axisRevision);
      const state = stateMemo.project({
        bars: currentBars,
        barsAxisRevision,
        enabled: true,
        fundingActive: true,
        fundingHistory,
        fundingPreview: null,
        fundingRealtimeHistory,
        interval: "1m",
        nowMs: 1,
        openInterestActive: true,
        openInterestHistory,
      });
      const liquidationPane = liquidationMemo.project({
        bars: currentBars,
        barsAxisRevision,
        enabled: true,
        interval: "1m",
        liquidationActive: true,
        snapshot: liquidationSnapshot,
        view: liquidationView,
      });
      return { ...state, bars: currentBars, liquidationPane };
    },
  };
}

function assertAllPaneCachesReprojected(
  first: ReturnType<ReturnType<typeof createBarRevisionProjectionHarness>["project"]>,
  second: ReturnType<ReturnType<typeof createBarRevisionProjectionHarness>["project"]>,
): void {
  assert.notStrictEqual(second.fundingPane, first.fundingPane);
  assert.notStrictEqual(second.openInterestPane, first.openInterestPane);
  assert.notStrictEqual(second.liquidationPane, first.liquidationPane);
}

test("in-place append invalidates funding, OI, and liquidation pane caches", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(bars([60, 120]));
  const harness = createBarRevisionProjectionHarness(store);
  const first = harness.project();
  const previousVersion = Number(store.version);
  const previousAxisRevision = Number(store.axisRevision);

  store.applyTick(bars([180])[0]);

  assert.strictEqual(store.snapshot(), first.bars);
  assert.equal(Number(store.version), previousVersion + 1);
  assert.equal(Number(store.axisRevision), previousAxisRevision + 1);
  const second = harness.project();
  assertAllPaneCachesReprojected(first, second);
  assert.deepEqual(harness.counts, {
    fundingHistory: 2,
    fundingPane: 2,
    liquidationPane: 2,
    openInterestPane: 2,
  });
});

test("in-place replace-last retains all pane caches when the time axis is unchanged", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(bars([60, 120]));
  const harness = createBarRevisionProjectionHarness(store);
  const first = harness.project();
  const previousVersion = Number(store.version);
  const previousAxisRevision = Number(store.axisRevision);

  store.applyTick({ ...bars([120])[0], close: 999 });

  assert.strictEqual(store.snapshot(), first.bars);
  assert.equal(Number(store.version), previousVersion + 1);
  assert.equal(Number(store.axisRevision), previousAxisRevision);
  const second = harness.project();
  assert.strictEqual(second.fundingPane, first.fundingPane);
  assert.strictEqual(second.openInterestPane, first.openInterestPane);
  assert.strictEqual(second.liquidationPane, first.liquidationPane);
  assert.deepEqual(harness.counts, {
    fundingHistory: 1,
    fundingPane: 1,
    liquidationPane: 1,
    openInterestPane: 1,
  });
});
