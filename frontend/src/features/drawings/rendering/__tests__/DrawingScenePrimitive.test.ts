import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingAttachedParameter } from "../../drawingTypes.js";
import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import { createDrawingScreenDisplayList } from "../drawingDisplayList.js";
import { DrawingScenePrimitive } from "../DrawingScenePrimitive.js";

const stamp: DrawingRenderRevisionStamp = Object.freeze({
  scopeKey: "scene",
  documentRevision: 1,
  surfaceGeneration: 2,
  dataRevision: 3,
  projectionRevision: 4,
  lineageIndexRevision: 5,
  viewportRevision: 6,
  themeRevision: 7,
  widthCssPx: 800,
  heightCssPx: 400,
  dpr: 1.5,
});

test("scene primitive permanently reuses one normal pane view and owns no LWC hitTest", () => {
  const primitive = new DrawingScenePrimitive();
  const first = primitive.paneViews();
  const second = primitive.paneViews();
  assert.strictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.length, 1);
  assert.strictEqual(first[0], second[0]);
  assert.strictEqual(first[0]?.renderer(), second[0]?.renderer());
  assert.equal(first[0]?.zOrder?.(), "normal");
  assert.equal("hitTest" in primitive, false);
});

test("plan publication coalesces requestUpdate and chart view updates never rebuild", () => {
  const frames: Array<() => void> = [];
  const cancelled: unknown[] = [];
  let updates = 0;
  const primitive = new DrawingScenePrimitive({
    requestFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame(handle) { cancelled.push(handle); },
  });
  primitive.attached({
    series: {},
    chart: {},
    requestUpdate: () => { updates += 1; },
  } as unknown as DrawingAttachedParameter);

  const first = createDrawingScreenDisplayList(stamp, []);
  const second = createDrawingScreenDisplayList(stamp, []);
  assert.equal(primitive.publishPlan(first), true);
  assert.equal(primitive.publishPlan(first), true);
  assert.equal(primitive.publishPlan(second), true);
  for (let index = 0; index < 1_000; index += 1) primitive.updateAllViews();
  assert.equal(frames.length, 1);
  assert.equal(updates, 0);
  frames[0]?.();
  assert.equal(updates, 1);
  assert.strictEqual(primitive.plan(), second);

  primitive.clearPlan();
  assert.equal(frames.length, 2);
  primitive.detached();
  assert.deepEqual(cancelled, [2]);
  assert.equal(primitive.plan(), null);
  assert.equal(primitive.publishPlan(first), false);
});
