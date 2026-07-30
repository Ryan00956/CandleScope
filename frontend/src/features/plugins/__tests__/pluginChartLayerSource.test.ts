import assert from "node:assert/strict";
import test from "node:test";
import { PluginChartLayerSource } from "../pluginChartLayerSource.js";
import type { PluginChartLayer } from "../pluginPlatformTypes.js";

const layer: PluginChartLayer = {
  id: "acme.wave.waves",
  pluginId: "acme.wave",
  generation: 1,
  revision: 1,
  chartId: "main-chart",
  chartRevision: 1,
  zOrder: "above-series",
  context: { mode: "live", exchange: "binance", marketType: "spot" },
  series: { symbol: "BTCUSDT", interval: "1m" },
  render: {
    schemaVersion: "candlescope.render/2",
    items: [
      {
        id: "path",
        type: "polyline",
        points: [{ time: 100, price: 10 }, { time: 200, price: 12 }],
        color: "#3B82F6",
        width: 2,
        style: "solid",
      },
      {
        id: "marker",
        type: "marker",
        time: 200,
        position: "aboveBar",
        shape: "circle",
        color: "#3B82F6",
        text: "(3)",
      },
    ],
  },
};

test("analysis layer source is context-bound, marker-free, and revision-stable", () => {
  const source = new PluginChartLayerSource();
  const identity = {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };
  let notifications = 0;
  source.subscribe(() => { notifications += 1; });

  source.update([layer], identity);
  const first = source.getSnapshot();
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0]?.item.type, "polyline");
  assert.equal(first.entries[0]?.id, "plugin:acme.wave.waves:path");
  assert.equal(notifications, 1);

  source.update([layer], identity);
  assert.strictEqual(source.getSnapshot(), first);
  assert.equal(notifications, 1);

  source.update([layer], { ...identity, symbol: "ETHUSDT" });
  assert.equal(source.getSnapshot().entries.length, 0);
  assert.equal(notifications, 2);
});
