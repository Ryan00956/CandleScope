import assert from "node:assert/strict";
import test from "node:test";

import { buildChartDatasetKey } from "../../chart-session/chartDatasetKey.js";
import { replayDigest } from "./fixtures.js";

const live = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
  interval: "1m",
};

test("legacy live dataset key stays byte-for-byte compatible", () => {
  assert.equal(buildChartDatasetKey(live), "binance-spot-BTCUSDT-1m");
});

test("replay dataset key requires and serializes every isolation dimension", () => {
  const key = buildChartDatasetKey({
    ...live,
    sourceKind: "replay",
    replaySessionId: "session-0001",
    dataEpoch: replayDigest("a"),
    publicTimelineEpoch: 1_700_000_000_000,
  });
  assert.match(key, /source=replay/);
  assert.match(key, /session=session-0001/);
  assert.match(key, /data=sha256%3A/);
  assert.match(key, /timeline=1700000000000/);
  assert.throws(() => buildChartDatasetKey({ ...live, sourceKind: "replay" }), /requires session/);
});

test("replay dataset key canonicalizes intervals without collapsing source scope", () => {
  const identity = {
    ...live,
    sourceKind: "replay",
    replaySessionId: "session-0001",
    dataEpoch: replayDigest("a"),
    publicTimelineEpoch: 1_700_000_000_000,
  };

  assert.equal(
    buildChartDatasetKey({ ...identity, interval: "60m" }),
    buildChartDatasetKey({ ...identity, interval: "1h" }),
  );
  assert.notEqual(
    buildChartDatasetKey(identity),
    buildChartDatasetKey({ ...identity, replaySessionId: "session-0002" }),
  );
  assert.notEqual(
    buildChartDatasetKey(identity),
    buildChartDatasetKey({ ...identity, sourceKind: "live" }),
  );
});
