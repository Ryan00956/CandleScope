import assert from "node:assert/strict";
import test from "node:test";

import {
  layoutRatioKey,
  normalizeChartSplitRatio,
  ratioFromPointerPosition,
} from "../chartWorkspaceLayout.js";

test("split ratios clamp to a usable 20 to 80 percent range", () => {
  assert.equal(normalizeChartSplitRatio(-1), 0.2);
  assert.equal(normalizeChartSplitRatio(0.37), 0.37);
  assert.equal(normalizeChartSplitRatio(5), 0.8);
  assert.equal(normalizeChartSplitRatio("invalid", 0.6), 0.6);
});

test("pointer positions resolve relative to the workspace bounds", () => {
  assert.equal(ratioFromPointerPosition(350, 100, 500), 0.5);
  assert.equal(ratioFromPointerPosition(50, 100, 500), 0.2);
  assert.equal(ratioFromPointerPosition(700, 100, 500), 0.8);
  assert.equal(ratioFromPointerPosition(100, 100, 0), null);
});

test("layout axes map to independent persisted ratio slots", () => {
  assert.equal(layoutRatioKey("split-vertical", "columns"), "splitVertical");
  assert.equal(layoutRatioKey("split-horizontal", "rows"), "splitHorizontal");
  assert.equal(layoutRatioKey("quad", "columns"), "quadColumns");
  assert.equal(layoutRatioKey("quad", "rows"), "quadRows");
  assert.equal(layoutRatioKey("single", "columns"), null);
});
