import assert from "node:assert/strict";
import test from "node:test";

import { handleDrawingEscape } from "../drawingKeyboardController.js";

test("Escape without active freehand reaches preview and selection cancellation", () => {
  const calls: string[] = [];
  const base = {
    hasActiveFreehandStroke: false,
    cancelActiveFreehandStroke: () => { calls.push("freehand"); return true; },
    deselectAll: () => calls.push("deselect"),
    preventDefault: () => calls.push("prevent"),
    removePreview: () => calls.push("preview"),
  };

  handleDrawingEscape({ ...base, hasAnchor: true, hasSelection: true });
  assert.deepEqual(calls, ["preview"]);

  handleDrawingEscape({ ...base, hasAnchor: false, hasSelection: true });
  assert.deepEqual(calls, ["preview", "deselect"]);
});

test("Escape consumes only a genuinely active freehand stroke", () => {
  const calls: string[] = [];
  handleDrawingEscape({
    hasActiveFreehandStroke: true,
    cancelActiveFreehandStroke: () => { calls.push("freehand"); return false; },
    hasAnchor: true,
    hasSelection: true,
    removePreview: () => calls.push("preview"),
    deselectAll: () => calls.push("deselect"),
    preventDefault: () => calls.push("prevent"),
  });
  assert.deepEqual(calls, ["freehand", "prevent"]);
});
