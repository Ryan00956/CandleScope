import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  indicatorDrawingScopeKeys,
  shouldSynchronizeDrawingVisibility,
} from "../useDrawingRuntime.js";
import {
  useDrawingToolSelectionState,
  useDrawingToolState,
} from "../drawingToolState.js";

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

test("shared drawing tool selection overrides every chart-local tool state", () => {
  function SharedToolStateProbe() {
    const sharedSelection = useDrawingToolSelectionState("line-segment");
    const left = useDrawingToolState(sharedSelection);
    const right = useDrawingToolState(sharedSelection);
    return createElement("span", {
      "data-left-tool": left.view.drawingTool,
      "data-right-tool": right.view.drawingTool,
    });
  }

  const html = renderToStaticMarkup(createElement(SharedToolStateProbe));
  assert.match(html, /data-left-tool="line-segment"/);
  assert.match(html, /data-right-tool="line-segment"/);
});
