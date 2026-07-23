import assert from "node:assert/strict";
import test from "node:test";

import { formatLiveCountdown } from "../../../components/liveCountdown.js";

test("funding settlement countdown formats remaining time and stops at settlement", () => {
  assert.equal(formatLiveCountdown(10_000, 0), "00:00:10");
  assert.equal(formatLiveCountdown(90_061_000, 0), "1天 01:01:01");
  assert.equal(formatLiveCountdown(10_000, 10_000), null);
  assert.equal(formatLiveCountdown(null, 0), null);
});
