import assert from "node:assert/strict";
import test from "node:test";
import {
  indicatorDrawingScopeKeys,
  shouldSynchronizeDrawingVisibility,
} from "../useDrawingRuntime.js";

test("drawing visibility skips the default mount value and preserves real transitions", () => {
  assert.equal(shouldSynchronizeDrawingVisibility(null, false), false);
  assert.equal(shouldSynchronizeDrawingVisibility(null, true), true);
  assert.equal(shouldSynchronizeDrawingVisibility(false, false), false);
  assert.equal(shouldSynchronizeDrawingVisibility(false, true), true);
  assert.equal(shouldSynchronizeDrawingVisibility(true, false), true);
  assert.equal(shouldSynchronizeDrawingVisibility(true, true), false);
});

test("indicator drawing scopes retain the caller-provided workspace and cell boundary", () => {
  assert.deepEqual(indicatorDrawingScopeKeys(
    "workspace:workspace-2:cell-1:binance:spot:BTCUSDT",
    "pine-1",
  ), [
    "workspace:workspace-2:cell-1:binance:spot:BTCUSDT__separate-pine-1",
    "workspace:workspace-2:cell-1:binance:spot:BTCUSDT__volume-pine-1",
  ]);
  assert.deepEqual(indicatorDrawingScopeKeys("workspace:workspace-2:cell-1", "  "), []);
});
