import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearHoveredPrimitive,
  cursorForLineToolHit,
  cursorForPositionToolHit,
  cursorForShapeToolHit,
  cursorForTextToolHit,
  hoverTargetForTool,
  shouldAppendFreehandPoint,
  syncHoveredPrimitive,
} from "../drawingHoverController.js";

function mockPrimitive(id) {
  const calls = [];
  return {
    id,
    calls,
    setHovered(value) {
      calls.push(value);
    },
  };
}

test("syncHoveredPrimitive only toggles the previous and next primitive", () => {
  const hoveredRef = { current: null };
  const first = mockPrimitive("first");
  const second = mockPrimitive("second");

  assert.equal(syncHoveredPrimitive(hoveredRef, first), true);
  assert.equal(hoveredRef.current, first);
  assert.deepEqual(first.calls, [true]);

  assert.equal(syncHoveredPrimitive(hoveredRef, first), false);
  assert.deepEqual(first.calls, [true]);

  assert.equal(syncHoveredPrimitive(hoveredRef, second), true);
  assert.equal(hoveredRef.current, second);
  assert.deepEqual(first.calls, [true, false]);
  assert.deepEqual(second.calls, [true]);

  assert.equal(clearHoveredPrimitive(hoveredRef), true);
  assert.equal(hoveredRef.current, null);
  assert.deepEqual(second.calls, [true, false]);
});

test("hoverTargetForTool limits hover ownership by tool family", () => {
  const line = mockPrimitive("line");
  const position = mockPrimitive("position");
  const text = mockPrimitive("text");

  assert.equal(hoverTargetForTool("line-segment", { type: "line", prim: line }), line);
  assert.equal(hoverTargetForTool("line-segment", { type: "position", prim: position }), position);
  assert.equal(hoverTargetForTool("position-long", { type: "line", prim: line }), null);
  assert.equal(hoverTargetForTool("position-long", { type: "position", prim: position }), position);
  assert.equal(hoverTargetForTool("text", { type: "text", prim: text }), null);
  assert.equal(hoverTargetForTool("eraser", { type: "text", prim: text }), text);
  assert.equal(hoverTargetForTool("eraser", null), null);
});

test("cursor helpers map drawing hit zones to expected cursors", () => {
  assert.equal(cursorForLineToolHit({ type: "axis-line", prim: { axisLineType: "horizontal" } }), "ns-resize");
  assert.equal(cursorForLineToolHit({ type: "axis-line", prim: { axisLineType: "vertical" } }), "ew-resize");
  assert.equal(cursorForLineToolHit({ type: "line", pointIndex: 0 }), "crosshair");
  assert.equal(cursorForLineToolHit({ type: "line", pointIndex: -1 }), "move");
  assert.equal(cursorForLineToolHit(null), "crosshair");

  assert.equal(cursorForShapeToolHit({ type: "shape", zone: "l" }), "ew-resize");
  assert.equal(cursorForShapeToolHit({ type: "shape", zone: "tl" }), "nwse-resize");
  assert.equal(cursorForShapeToolHit({ type: "shape", zone: "body" }), "move");
  assert.equal(cursorForShapeToolHit(null), "crosshair");

  assert.equal(cursorForPositionToolHit({ type: "position", zone: "tp" }), "ns-resize");
  assert.equal(cursorForPositionToolHit({ type: "position", zone: "panel" }), "grab");
  assert.equal(cursorForPositionToolHit({ type: "position", zone: "left" }), "ew-resize");
  assert.equal(cursorForPositionToolHit({ type: "position", zone: "body" }), "move");
  assert.equal(cursorForPositionToolHit(null), "crosshair");

  assert.equal(cursorForTextToolHit({ type: "text", handle: "r" }), "ew-resize");
  assert.equal(cursorForTextToolHit({ type: "text", handle: "br" }), "nwse-resize");
  assert.equal(cursorForTextToolHit({ type: "text" }), "move");
  assert.equal(cursorForTextToolHit(null), "crosshair");
});

test("shouldAppendFreehandPoint drops sub-pixel jitter", () => {
  assert.equal(shouldAppendFreehandPoint(null, { x: 0, y: 0 }, 1), true);
  assert.equal(shouldAppendFreehandPoint({ x: 0, y: 0 }, null, 1), true);
  assert.equal(shouldAppendFreehandPoint({ x: 10, y: 10 }, { x: 10.4, y: 10.4 }, 1), false);
  assert.equal(shouldAppendFreehandPoint({ x: 10, y: 10 }, { x: 11, y: 10 }, 1), true);
});
