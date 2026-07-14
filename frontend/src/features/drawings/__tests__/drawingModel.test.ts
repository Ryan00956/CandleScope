import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPassiveCursorTool,
  cursorOverlayClassForTool,
  cursorStyleForDrawingTool,
  cursorStyleForPassiveTool,
  isFiniteNumber,
  shouldShowCrosshairDetails,
  shapeTypeFromTool,
  axisLineTypeFromTool,
  constrainShapeScreenPoint,
  resizedShapeBoxFromHandle,
  decimateScreenPoints,
  nextDrawingId,
  observeDrawingId,
} from "../drawingModel.js";
import type { DrawingToolId, ScreenPoint } from "../drawingTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

test("isPassiveCursorTool treats empty and cursor tools as passive", () => {
  assert.equal(isPassiveCursorTool(malformedFixture<DrawingToolId>("")), true);
  assert.equal(isPassiveCursorTool(null), true);
  assert.equal(isPassiveCursorTool("cursor-default"), true);
  assert.equal(isPassiveCursorTool("cursor-crosshair"), true);
  assert.equal(isPassiveCursorTool("pen"), false);
  assert.equal(isPassiveCursorTool("text"), false);
});

test("cursorStyleForPassiveTool maps tools to CSS cursors", () => {
  assert.equal(cursorStyleForPassiveTool("cursor-crosshair"), "crosshair");
  assert.equal(cursorStyleForPassiveTool("cursor-dot"), "none");
  assert.equal(cursorStyleForPassiveTool("cursor-highlighter"), "none");
  assert.equal(cursorStyleForPassiveTool("cursor-default"), "default");
  assert.equal(cursorStyleForPassiveTool(malformedFixture<DrawingToolId>("anything-else")), "default");
});

test("drawing cursor presentation keeps all toolbar cursor variants distinct", () => {
  assert.equal(cursorStyleForDrawingTool("cursor-default"), "default");
  assert.equal(cursorStyleForDrawingTool("cursor-crosshair"), "crosshair");
  assert.equal(cursorStyleForDrawingTool("cursor-dot"), "none");
  assert.equal(cursorStyleForDrawingTool("cursor-highlighter"), "none");
  assert.equal(cursorStyleForDrawingTool("cursor-plain"), "default");
  assert.equal(cursorStyleForDrawingTool("line-segment"), "crosshair");

  assert.equal(cursorOverlayClassForTool("cursor-dot"), "chart-pane-cursor-dot");
  assert.equal(cursorOverlayClassForTool("cursor-highlighter"), "chart-pane-cursor-highlighter");
  assert.equal(cursorOverlayClassForTool("cursor-default"), null);

  assert.equal(shouldShowCrosshairDetails("cursor-default"), true);
  assert.equal(shouldShowCrosshairDetails("cursor-crosshair"), true);
  assert.equal(shouldShowCrosshairDetails("cursor-dot"), false);
  assert.equal(shouldShowCrosshairDetails("cursor-highlighter"), false);
  assert.equal(shouldShowCrosshairDetails("cursor-plain"), false);
});

test("isFiniteNumber accepts only finite numbers", () => {
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-3.5), true);
  assert.equal(isFiniteNumber(NaN), false);
  assert.equal(isFiniteNumber(Infinity), false);
  assert.equal(isFiniteNumber("5"), false);
  assert.equal(isFiniteNumber(null), false);
});

test("shapeTypeFromTool resolves shape tools", () => {
  assert.equal(shapeTypeFromTool("shape-ellipse"), "ellipse");
  assert.equal(shapeTypeFromTool("shape-rectangle"), "rectangle");
  assert.equal(shapeTypeFromTool("line-segment"), null);
});

test("axisLineTypeFromTool resolves axis line orientation", () => {
  assert.equal(axisLineTypeFromTool("line-vertical"), "vertical");
  assert.equal(axisLineTypeFromTool("line-cross"), "cross");
  assert.equal(axisLineTypeFromTool("line-horizontal"), "horizontal");
  assert.equal(axisLineTypeFromTool(malformedFixture<DrawingToolId>("whatever")), "horizontal");
});

test("constrainShapeScreenPoint produces a square offset from anchor", () => {
  const anchor = { x: 100, y: 100 };
  // dx larger than dy -> snaps to dx magnitude, preserving signs
  assert.deepEqual(constrainShapeScreenPoint(anchor, { x: 160, y: 120 }), { x: 160, y: 160 });
  // negative direction preserved
  assert.deepEqual(constrainShapeScreenPoint(anchor, { x: 70, y: 40 }), { x: 40, y: 40 });
  // missing args returns pointer unchanged
  const p = { x: 1, y: 2 };
  assert.equal(constrainShapeScreenPoint(null, p), p);
});

test("resizedShapeBoxFromHandle resizes from the correct edges with a minimum size", () => {
  const box = { x: 10, y: 10, width: 100, height: 100 };
  const resized = resizedShapeBoxFromHandle(box, "br", { x: 200, y: 150 });
  assert.deepEqual(resized, { x: 10, y: 10, width: 190, height: 140 });

  // dragging the right handle in(ward) past the left edge clamps to minSize
  const clamped = resizedShapeBoxFromHandle(
    box,
    "r",
    malformedFixture<ScreenPoint>({ x: 11 }),
  );
  assert.equal(mustBeDefined(clamped).width, 4);

  assert.equal(resizedShapeBoxFromHandle(null, "br", { x: 0, y: 0 }), null);
});

test("decimateScreenPoints removes near-collinear interior points", () => {
  const straight = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
  ];
  assert.deepEqual(decimateScreenPoints(straight, 1), [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);

  // a sharp deviation must be preserved
  const peak = [
    { x: 0, y: 0 },
    { x: 5, y: 50 },
    { x: 10, y: 0 },
  ];
  assert.deepEqual(decimateScreenPoints(peak, 1), peak);

  // two-or-fewer points pass through untouched
  const pair = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  assert.equal(decimateScreenPoints(pair, 1), pair);
});

test("nextDrawingId returns unique, prefixed, increasing ids", () => {
  const a = nextDrawingId("d");
  const b = nextDrawingId("d");
  assert.notEqual(a, b);
  assert.match(a, /^d_\d+$/);
  assert.match(nextDrawingId("preview"), /^preview_\d+$/);
});

test("restored drawing ids advance the allocator without accepting malformed suffixes", () => {
  const before = Number(nextDrawingId("before").split("_").at(-1));
  const restoredSuffix = before + 100;
  assert.equal(observeDrawingId(`fh_${restoredSuffix}`), true);
  assert.equal(observeDrawingId("fh_invalid"), false);
  assert.equal(observeDrawingId(`fh_${Number.MAX_SAFE_INTEGER}`), false);
  assert.equal(observeDrawingId(`fh_${Number.MAX_SAFE_INTEGER}0`), false);

  const after = Number(nextDrawingId("after").split("_").at(-1));
  assert.equal(after, restoredSuffix + 1);
});
