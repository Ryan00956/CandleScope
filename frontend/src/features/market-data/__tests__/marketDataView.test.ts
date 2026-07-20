import assert from "node:assert/strict";
import test from "node:test";

import { buildChartDisplayState } from "../marketDataView.js";

test("polling fallback does not claim the interval is live", () => {
  const state = buildChartDisplayState({
    wsStatus: "fallback",
    exchange: "binance",
    exchangeConfig: {
      label: "Binance",
      markets: [{ market_type: "futures", label: "USDT-M Perpetual" }],
    },
    marketType: "futures",
  });

  assert.equal(state.wsStatusLabel, "Polling fallback");
});
