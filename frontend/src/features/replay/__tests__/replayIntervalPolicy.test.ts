import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayIntervalCatalog,
  canProjectReplayDisplayInterval,
  replayIntervalUnavailableMessage,
} from "../replayIntervalPolicy.js";


test("replay uses the live Binance spot interval catalog and persisted customs", () => {
  const catalog = buildReplayIntervalCatalog({
    exchange: "binance",
    marketType: "spot",
    savedCustomIntervals: ["89m"],
  });

  assert.deepEqual(
    catalog.nativeIntervals.map((item) => item.value),
    [
      "1s",
      "1m",
      "3m",
      "5m",
      "15m",
      "30m",
      "1h",
      "2h",
      "4h",
      "6h",
      "8h",
      "12h",
      "1d",
      "3d",
      "1w",
      "1M",
    ],
  );
  const items = catalog.intervalGroups.flatMap((group) => group.items);
  assert.equal(items.find((item) => item.value === "89m")?.isCustom, true);
  assert.ok(items.some((item) => item.value === "1M" && item.isCustom === false));
});

test("replay availability follows its archived base without hiding catalog entries", () => {
  assert.equal(canProjectReplayDisplayInterval("1m", "1s"), false);
  assert.equal(canProjectReplayDisplayInterval("1m", "89m"), true);
  assert.equal(canProjectReplayDisplayInterval("1m", "1w"), true);
  assert.equal(canProjectReplayDisplayInterval("1m", "1M"), true);
  assert.equal(canProjectReplayDisplayInterval("5m", "7m"), false);
  assert.match(replayIntervalUnavailableMessage("5m", "7m"), /5m.*7m/);
});
