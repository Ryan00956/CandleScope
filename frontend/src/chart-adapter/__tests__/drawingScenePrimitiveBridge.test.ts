import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingFrameSnapshotFactory } from "../drawingFrameSnapshot.js";
import { createDrawingScenePrimitiveBridge } from "../drawingScenePrimitiveBridge.js";

function captureFrame(
  factory: ReturnType<typeof createDrawingFrameSnapshotFactory>,
  surfaceToken: object,
) {
  return factory.capture({
    axisKind: "time",
    barSpacing: 6,
    coordinateKey: "bridge",
    heightCssPx: 300,
    seriesData: [],
    surfaceToken,
    viewportKey: "viewport",
    widthCssPx: 500,
  });
}

test("scene bridge is idempotent and rejects stale surface generations", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const firstFrame = captureFrame(factory, {});
  const secondFrame = captureFrame(factory, {});
  let current = firstFrame;
  let attachCount = 0;
  let detachCount = 0;
  const published: number[] = [];
  let released = 0;
  const primitive = {
    publishPlan(plan: { readonly stamp: Readonly<{ surfaceGeneration: number }> }) {
      published.push(plan.stamp.surfaceGeneration);
      return true;
    },
    clearPlan() {},
    releaseSurfaceCredentials() { released += 1; },
  };
  const bridge = createDrawingScenePrimitiveBridge({
    primitive,
    attachPrimitive: () => { attachCount += 1; return true; },
    detachPrimitive: () => { detachCount += 1; return true; },
    captureDrawingFrame: () => current,
    isDrawingFrameCurrent: (frame) => frame === current,
  });

  assert.equal(bridge.attach(), true);
  assert.equal(bridge.attach(), true);
  assert.equal(attachCount, 1);
  assert.equal(bridge.snapshot().attachedPrimitiveCount, 1);
  assert.equal(bridge.publish({ stamp: { surfaceGeneration: firstFrame.surfaceGeneration } }), true);

  current = secondFrame;
  assert.equal(bridge.publish({ stamp: { surfaceGeneration: firstFrame.surfaceGeneration } }), false);
  bridge.releaseSurfaceCredentials();
  assert.equal(released, 1);
  assert.equal(bridge.attach(), true);
  assert.equal(attachCount, 2);
  assert.equal(bridge.publish({ stamp: { surfaceGeneration: secondFrame.surfaceGeneration } }), true);
  assert.deepEqual(published, [firstFrame.surfaceGeneration, secondFrame.surfaceGeneration]);
  assert.equal(bridge.detach(), true);
  assert.equal(detachCount, 1);
  assert.equal(bridge.snapshot().attachedPrimitiveCount, 0);
});

test("failed detach retains the one attachment credential for retry", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const current = captureFrame(factory, {});
  let rejectDetach = true;
  const primitive = {
    publishPlan() { return true; },
    clearPlan() {},
    releaseSurfaceCredentials() {},
  };
  const bridge = createDrawingScenePrimitiveBridge({
    primitive,
    attachPrimitive: () => true,
    detachPrimitive: () => !rejectDetach,
    captureDrawingFrame: () => current,
    isDrawingFrameCurrent: (frame) => frame === current,
  });
  assert.equal(bridge.attach(), true);
  assert.equal(bridge.detach(), false);
  assert.equal(bridge.snapshot().attached, true);
  rejectDetach = false;
  assert.equal(bridge.detach(), true);
  assert.equal(bridge.snapshot().attached, false);
});
