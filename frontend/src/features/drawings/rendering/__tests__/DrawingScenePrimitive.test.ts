import assert from "node:assert/strict";
import test from "node:test";

import type {
  DrawingAttachedParameter,
  PrimitiveCanvasTarget,
} from "../../drawingTypes.js";
import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  createDrawingScreenDisplayList,
  type ProjectedDrawingEntity,
} from "../drawingDisplayList.js";
import {
  DrawingScenePrimitive,
  type DrawingScenePaintAck,
} from "../DrawingScenePrimitive.js";

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

test("chart view update synchronizes the plan before paint without requesting a later frame", () => {
  let updates = 0;
  let synchronizations = 0;
  let replacement: ReturnType<typeof createDrawingScreenDisplayList> | null = null;
  const primitive: DrawingScenePrimitive = new DrawingScenePrimitive({
    synchronizeChartFrame() {
      synchronizations += 1;
      if (replacement) primitive.publishPlan(replacement);
    },
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
  assert.equal(updates, 1);
  replacement = second;
  primitive.updateAllViews();
  assert.equal(synchronizations, 1);
  assert.equal(updates, 1,
    "publication inside updateAllViews must be consumed by the current chart frame");
  assert.strictEqual(primitive.plan(), second);

  primitive.clearPlan();
  assert.equal(updates, 2);
  primitive.detached();
  assert.equal(primitive.plan(), null);
  assert.equal(primitive.publishPlan(first), false);
});

function attachScenePrimitive(primitive: DrawingScenePrimitive): void {
  primitive.attached({
    series: {},
    chart: {},
    requestUpdate() {},
  } as unknown as DrawingAttachedParameter);
}

function nonPaintingEntity(id: string): ProjectedDrawingEntity {
  return {
    id,
    kind: "line",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "line", color: "#fff", lineWidth: 1 },
    points: new Float64Array([0, 0, 1, 1]),
    bbox: [0, 0, 1, 1],
  };
}

function drawScenePrimitive(
  primitive: DrawingScenePrimitive,
  duringBitmap?: () => void,
): void {
  const renderer = primitive.paneViews()[0]?.renderer();
  assert.ok(renderer);
  renderer.draw({
    useBitmapCoordinateSpace(callback) {
      duringBitmap?.();
      callback({
        context: {},
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
        bitmapSize: { width: 800, height: 400 },
      } as never);
    },
  } as PrimitiveCanvasTarget);
}

test("scene primitive acknowledges the exact current plan, including an empty revision", () => {
  const primitive = new DrawingScenePrimitive();
  attachScenePrimitive(primitive);
  const acknowledgements: DrawingScenePaintAck[] = [];
  primitive.subscribePainted(() => { throw new Error("observer failure"); });
  primitive.subscribePainted((ack) => acknowledgements.push(ack));
  const empty = createDrawingScreenDisplayList(stamp, []);

  assert.equal(primitive.publishPlan(empty), true);
  drawScenePrimitive(primitive);

  assert.equal(acknowledgements.length, 1);
  assert.strictEqual(acknowledgements[0]?.plan, empty);
  assert.strictEqual(acknowledgements[0]?.stamp, empty.stamp);
  assert.equal(acknowledgements[0]?.attachmentRevision, 1);
  assert.equal(acknowledgements[0]?.paintSequence, 1);
  assert.equal(Object.isFrozen(acknowledgements[0]), true);
});

test("a late draw of an old plan cannot acknowledge the newly published revision", () => {
  const primitive = new DrawingScenePrimitive();
  attachScenePrimitive(primitive);
  const acknowledgements: DrawingScenePaintAck[] = [];
  primitive.subscribePainted((ack) => acknowledgements.push(ack));
  const oldPlan = createDrawingScreenDisplayList(stamp, [nonPaintingEntity("old")]);
  const newPlan = createDrawingScreenDisplayList({ ...stamp, documentRevision: 2 }, []);
  assert.equal(primitive.publishPlan(oldPlan), true);

  drawScenePrimitive(primitive, () => {
    assert.equal(primitive.publishPlan(newPlan), true);
  });
  assert.equal(acknowledgements.length, 0);

  drawScenePrimitive(primitive);
  assert.deepEqual(acknowledgements.map((ack) => ack.stamp.documentRevision), [2]);
});

test("detach, released credentials, and dispose clear scene paint subscriptions", () => {
  const primitive = new DrawingScenePrimitive();
  const empty = createDrawingScreenDisplayList(stamp, []);
  let calls = 0;

  attachScenePrimitive(primitive);
  primitive.subscribePainted(() => { calls += 1; });
  primitive.detached();
  attachScenePrimitive(primitive);
  assert.equal(primitive.publishPlan(empty), true);
  drawScenePrimitive(primitive);
  assert.equal(calls, 0);

  primitive.subscribePainted(() => { calls += 1; });
  primitive.releaseSurfaceCredentials();
  attachScenePrimitive(primitive);
  assert.equal(primitive.publishPlan(empty), true);
  drawScenePrimitive(primitive);
  assert.equal(calls, 0);

  primitive.subscribePainted(() => { calls += 1; });
  primitive.dispose();
  primitive.dispose();
  attachScenePrimitive(primitive);
  assert.equal(primitive.publishPlan(empty), false);
  assert.equal(calls, 0);
});
