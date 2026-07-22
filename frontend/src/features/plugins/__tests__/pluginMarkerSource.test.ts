import assert from "node:assert/strict";
import test from "node:test";
import { PluginMarkerSource } from "../pluginMarkerSource.js";
import type { PluginChartLayer } from "../pluginPlatformTypes.js";

const layer: PluginChartLayer = {
  id: "acme.scanner.signals",
  pluginId: "acme.scanner",
  generation: 1,
  revision: 1,
  context: { mode: "live", exchange: "binance", marketType: "spot" },
  series: { symbol: "BTCUSDT", interval: "1h" },
  render: {
    schemaVersion: "candlescope.render/1",
    items: [{
      id: "signal-1",
      type: "marker",
      time: 1_700_000_000_000,
      position: "aboveBar",
      shape: "arrowUp",
      color: "#22C55E",
      text: "BTC",
      price: 60_000,
    }],
  },
};

test("plugin markers are context-bound, epoch-normalized, and revision-stable", () => {
  const source = new PluginMarkerSource();
  let notifications = 0;
  source.subscribe(() => { notifications += 1; });
  const identity = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1h" };
  source.update([layer], identity);
  const first = source.getSnapshot();
  assert.equal(first.markers[0]?.time, 1_700_000_000);
  assert.equal(first.markers[0]?.id, "plugin:acme.scanner.signals:signal-1");
  assert.equal(notifications, 1);

  source.update([layer], identity);
  assert.strictEqual(source.getSnapshot(), first);
  assert.equal(notifications, 1);

  source.update([layer], { ...identity, symbol: "ETHUSDT" });
  assert.equal(source.getSnapshot().markers.length, 0);
  assert.equal(notifications, 2);
});
