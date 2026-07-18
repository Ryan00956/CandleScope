import assert from "node:assert/strict";
import test from "node:test";

import { resolveLiquidationCapability } from "../liquidationCapability.js";

const raw = {
  channels: [{
    channel: "liquidation",
    market_types: ["futures"],
    realtime: true,
    history: false,
  }],
};

test("liquidation capability accepts realtime-only exchange support for 1m+ charts", () => {
  assert.deepEqual(resolveLiquidationCapability({
    marketType: "futures",
    interval: "1m",
    raw,
  }), { supported: true, reason: null });
});

test("liquidation capability rejects spot and sub-minute chart intervals", () => {
  assert.equal(resolveLiquidationCapability({
    marketType: "spot",
    interval: "1m",
    raw,
  }).supported, false);
  assert.match(resolveLiquidationCapability({
    marketType: "futures",
    interval: "30s",
    raw,
  }).reason || "", /1 分钟/);
});
