import test from "node:test";
import assert from "node:assert/strict";
import { buildPanePointerLayout, paneIdAtClientY } from "../panePointerModel.js";

test("pane pointer layout resolves cached pane boundaries without DOM geometry", () => {
  const layout = buildPanePointerLayout(["main", "rsi", "volume"], [300, 100, 80], 40);

  assert.equal(paneIdAtClientY(layout, 40), "main");
  assert.equal(paneIdAtClientY(layout, 339.5), "main");
  assert.equal(paneIdAtClientY(layout, 340), "rsi");
  assert.equal(paneIdAtClientY(layout, 479.5), "volume");
  assert.equal(paneIdAtClientY(layout, 520), "volume");
  assert.equal(paneIdAtClientY(layout, 521), null);
});

test("pane pointer layout fails closed for stale or invalid geometry", () => {
  assert.equal(buildPanePointerLayout(["main"], [], 0), null);
  assert.equal(buildPanePointerLayout(["main"], [-1], 0), null);
  assert.equal(paneIdAtClientY(null, 10), null);
  assert.equal(paneIdAtClientY(buildPanePointerLayout(["main"], [10], 0), Number.NaN), null);
});
