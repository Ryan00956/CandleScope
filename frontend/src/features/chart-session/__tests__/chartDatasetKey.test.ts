import assert from "node:assert/strict";
import test from "node:test";

import { buildChartDatasetKey } from "../chartDatasetKey.js";

test("dataset key is scoped to session dimensions only", () => {
  const session = {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };

  assert.equal(buildChartDatasetKey(session), "binance-spot-BTCUSDT-1m");
});

test("dataset key ignores compatibility version fields", () => {
  const session = {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };

  assert.equal(
    buildChartDatasetKey({ ...session, datasetVersion: 41 }),
    buildChartDatasetKey({ ...session, datasetVersion: 42 }),
  );
});

test("dataset key canonicalizes fixed-duration aliases", () => {
  const session = {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1h",
  };
  assert.equal(
    buildChartDatasetKey({ ...session, interval: "60m" }),
    buildChartDatasetKey(session),
  );
  assert.notEqual(
    buildChartDatasetKey({ ...session, interval: "7d" }),
    buildChartDatasetKey({ ...session, interval: "1w" }),
  );
});
