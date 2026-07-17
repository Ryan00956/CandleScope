import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import { hasCurrentAdvancedMarketSeries } from "../useAdvancedMarketPanes.js";

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
