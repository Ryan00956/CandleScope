import assert from "node:assert/strict";
import test from "node:test";
import { shouldSynchronizeDrawingVisibility } from "../useDrawingRuntime.js";

test("drawing visibility skips the default mount value and preserves real transitions", () => {
  assert.equal(shouldSynchronizeDrawingVisibility(null, false), false);
  assert.equal(shouldSynchronizeDrawingVisibility(null, true), true);
  assert.equal(shouldSynchronizeDrawingVisibility(false, false), false);
  assert.equal(shouldSynchronizeDrawingVisibility(false, true), true);
  assert.equal(shouldSynchronizeDrawingVisibility(true, false), true);
  assert.equal(shouldSynchronizeDrawingVisibility(true, true), false);
});
