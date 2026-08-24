import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../../market-data/window/seriesWindowStore.js";
import type { BacktestChartData } from "../../backtestTypes.js";
import {
  CHART_STRATEGY_VISIBLE_MARKER_LIMIT,
  boundVisibleBacktestMarkers,
  createChartStrategyResultMarkerSource,
} from "../chartStrategyResultMarkerSource.js";

const labels = { actions: { OPEN_LONG: "open" }, rejection: "rejected" };

test("marker source publishes only visible range plus overscan and clears synchronously", () => {
  const seriesStore = new SeriesWindowStore({ maxBars: 10_000, intervalSeconds: 60 });
  seriesStore.replace(Array.from({ length: 500 }, (_value, index) => ({
    time: index * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  })));
  const chart: BacktestChartData = {
    run_id: "bt_markers_12345678",
    chart_hash: "sha256:markers",
    symbol: "BTCUSDT",
    interval: "1m",
    bars: [],
    fills: Array.from({ length: 500 }, (_value, index) => ({
      order_id: `order-${index}`,
      event_time_ms: String(index * 60_000),
      side: "BUY",
      action: "OPEN_LONG",
      price: "100",
    })),
    equity_curve: [],
    truncated: false,
  };
  const source = createChartStrategyResultMarkerSource({ seriesStore, labels });
  source.setResult(chart);
  source.setVisibleRange({ time: { from: 12_000, to: 12_600 } });
  const snapshot = source.getSnapshot();
  assert.strictEqual(source.getSnapshot(), snapshot);
  assert.strictEqual(source.getSnapshot().markers, snapshot.markers);
  assert.ok(snapshot.markers.length > 10);
  assert.ok(snapshot.markers.length < chart.fills.length);
  assert.ok(snapshot.markers.every((marker) => Number(marker.time) >= 10_800 && Number(marker.time) <= 13_800));
  source.clear();
  const cleared = source.getSnapshot();
  assert.notStrictEqual(cleared, snapshot);
  assert.equal(cleared.markers.length, 0);
  assert.strictEqual(source.getSnapshot(), cleared);
  source.dispose();
});

test("visible marker budgeting is deterministic under dense results", () => {
  const markers = Array.from({ length: 100_000 }, (_value, index) => ({
    id: String(index),
    time: index,
    position: "aboveBar" as const,
    color: "#fff",
    shape: "square" as const,
  }));
  const first = boundVisibleBacktestMarkers(markers, null, 1);
  const second = boundVisibleBacktestMarkers(markers, null, 1);
  assert.equal(first.length, CHART_STRATEGY_VISIBLE_MARKER_LIMIT);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(first.at(0)?.id, "0");
  assert.equal(first.at(-1)?.id, "99999");
});
