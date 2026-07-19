import assert from "node:assert/strict";
import test from "node:test";

import {
  initialRepairRetryMode,
  reconcileInitialRepairRetry,
} from "../feed/initialRepairRetryPolicy.js";

test("uses exact polling for a trackable pending range regardless of rendered rows", () => {
  assert.equal(initialRepairRetryMode({
    repairPending: true,
    exactRangeTracked: true,
    terminal: false,
  }), "exact");
});

test("uses broad retry only when pending work cannot be located exactly", () => {
  assert.equal(initialRepairRetryMode({
    repairPending: true,
    exactRangeTracked: false,
    terminal: false,
  }), "broad");
});

test("stops retrying after completion or terminal failure", () => {
  assert.equal(initialRepairRetryMode({
    repairPending: false,
    exactRangeTracked: false,
    terminal: false,
  }), "none");
  assert.equal(initialRepairRetryMode({
    repairPending: true,
    exactRangeTracked: false,
    terminal: true,
  }), "none");
});

test("switching from broad fallback to exact ownership stops broad retry immediately", () => {
  const calls: string[] = [];
  const controls = {
    startBroadRetry: () => { calls.push("start"); },
    stopBroadRetry: () => { calls.push("stop"); },
  };
  reconcileInitialRepairRetry("broad", controls);
  reconcileInitialRepairRetry("exact", controls);
  assert.deepEqual(calls, ["start", "stop"]);
});
