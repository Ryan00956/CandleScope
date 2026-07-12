import assert from "node:assert/strict";
import test from "node:test";

import { CHART_DRAWING_ANCHOR_MODES } from "../../chart-representation/chartTypeRegistry.js";
import {
  drawingToolForAnchorMode,
  hasSupportedDrawingVariant,
  supportsDrawingAnchorMode,
  supportsDrawingHitType,
  supportsDrawingTool,
} from "../drawingCapabilities.js";

test("source-time drawing anchors retain the complete existing tool surface", () => {
  const mode = CHART_DRAWING_ANCHOR_MODES.SOURCE_TIME;
  assert.equal(supportsDrawingAnchorMode(mode), true);
  for (const tool of [
    "cursor-default",
    "pen",
    "highlighter",
    "eraser",
    "line-segment",
    "angle-measure",
    "shape-rectangle",
    "text",
    "fibonacci",
    "position-long",
  ]) {
    assert.equal(supportsDrawingTool(mode, tool), true, tool);
  }
});

test("source-lineage drawing anchors expose only the verified ordinal-safe tools", () => {
  const mode = CHART_DRAWING_ANCHOR_MODES.SOURCE_LINEAGE;
  for (const tool of [
    "cursor-default",
    "cursor-crosshair",
    "eraser",
    "line-segment",
    "line-ray",
    "line-infinite",
    "line-horizontal",
    "line-vertical",
    "line-cross",
    "angle-measure",
    "fibonacci",
    "shape-rectangle",
    "shape-ellipse",
    "text",
  ]) {
    assert.equal(supportsDrawingTool(mode, tool), true, tool);
  }
  for (const tool of [
    "pen",
    "highlighter",
    "position-long",
    "position-short",
  ]) {
    assert.equal(supportsDrawingTool(mode, tool), false, tool);
  }
  assert.equal(drawingToolForAnchorMode(mode, "position-long"), "cursor-default");
  assert.equal(hasSupportedDrawingVariant(mode, [
    { id: "line-segment" },
    { id: "angle-measure" },
  ]), true);
  assert.equal(hasSupportedDrawingVariant(mode, [{ id: "shape-rectangle" }]), true);
  assert.equal(supportsDrawingHitType(mode, "line"), true);
  assert.equal(supportsDrawingHitType(mode, "axis-line"), true);
  assert.equal(supportsDrawingHitType(mode, "fibonacci"), true);
  assert.equal(supportsDrawingHitType(mode, "angle"), true);
  assert.equal(supportsDrawingHitType(mode, "shape"), true);
  assert.equal(supportsDrawingHitType(mode, "text"), true);
  assert.equal(supportsDrawingHitType(mode, "position"), false);
});

test("unknown drawing anchor modes default to disabled", () => {
  assert.equal(supportsDrawingAnchorMode(null), false);
  assert.equal(supportsDrawingTool(null, "cursor-default"), false);
  assert.equal(drawingToolForAnchorMode(null, "line-segment"), null);
});
