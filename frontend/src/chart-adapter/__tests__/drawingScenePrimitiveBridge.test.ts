import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingFrameSnapshotFactory } from "../drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "../drawingFrameSnapshot.js";
import { createDrawingScenePrimitiveBridge } from "../drawingScenePrimitiveBridge.js";

type Plan = Readonly<{
  stamp: Readonly<{
    surfaceGeneration: number;
    dataRevision: number;
    projectionRevision: number;
    lineageIndexRevision: number;
    viewportRevision: number;
    themeRevision: number;
    widthCssPx: number;
    heightCssPx: number;
    dpr: number;
    scopeKey: string;
    documentRevision: number;
  }>;
}>;

const bridgeSeriesData: [] = [];

function captureFrame(
  factory: ReturnType<typeof createDrawingFrameSnapshotFactory>,
  surfaceToken: object,
) {
  return factory.capture({
    axisKind: "time",
    barSpacing: 6,
    coordinateKey: "bridge",
    heightCssPx: 300,
    seriesData: bridgeSeriesData,
    surfaceToken,
    viewportKey: "viewport",
    widthCssPx: 500,
  });
}

function planForFrame(frame: DrawingFrameSnapshot, documentRevision: number): Plan {
  return Object.freeze({
    stamp: Object.freeze({
      surfaceGeneration: frame.surfaceGeneration,
      dataRevision: frame.dataRevision,
      projectionRevision: frame.projectionRevision,
      lineageIndexRevision: frame.lineageIndexRevision,
      viewportRevision: frame.viewportRevision,
      themeRevision: frame.themeRevision,
      widthCssPx: frame.widthCssPx,
      heightCssPx: frame.heightCssPx,
      dpr: frame.dpr,
      scopeKey: "BTCUSDT:1m",
      documentRevision,
    }),
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
    publishPlan(plan: Plan) {
      published.push(plan.stamp.surfaceGeneration);
      return true;
    },
    clearPlan() {},
    releaseSurfaceCredentials() { released += 1; },
    subscribePainted() { return () => {}; },
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
  assert.equal(bridge.publish(planForFrame(firstFrame, 1)), true);

  current = secondFrame;
  assert.equal(bridge.publish(planForFrame(firstFrame, 2)), false);
  bridge.releaseSurfaceCredentials();
  assert.equal(released, 1);
  assert.equal(bridge.attach(), true);
  assert.equal(attachCount, 2);
  assert.equal(bridge.publish(planForFrame(secondFrame, 3)), true);
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
    subscribePainted() { return () => {}; },
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

test("scene bridge rejects paint acknowledgements from every stale render-frame component", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const frame = captureFrame(factory, {});
  let current: DrawingFrameSnapshot = frame;
  type PaintAck = Readonly<{
    plan: Plan;
    stamp: Plan["stamp"];
    attachmentRevision: number;
    paintSequence: number;
  }>;
  let primitiveListener: ((ack: PaintAck) => void) | null = null;
  let recoveryCount = 0;
  const primitive = {
    publishPlan() { return true; },
    clearPlan() {},
    releaseSurfaceCredentials() {},
    subscribePainted(listener: (ack: PaintAck) => void) {
      primitiveListener = listener;
      return () => {
        if (primitiveListener === listener) primitiveListener = null;
      };
    },
  };
  const emitPaint = (plan: Plan, paintSequence: number): void => {
    const listener = primitiveListener;
    listener?.({
      plan,
      stamp: plan.stamp,
      attachmentRevision: 1,
      paintSequence,
    });
  };
  const bridge = createDrawingScenePrimitiveBridge<typeof primitive, Plan>({
    primitive,
    attachPrimitive: () => true,
    detachPrimitive: () => true,
    captureDrawingFrame: () => current,
    isDrawingFrameCurrent: (candidate) => candidate === current,
    onCurrentPaintRejected: () => { recoveryCount += 1; },
  });
  const forwarded: PaintAck[] = [];
  const mismatchedFields = [
    "surfaceGeneration",
    "dataRevision",
    "projectionRevision",
    "lineageIndexRevision",
    "viewportRevision",
    "themeRevision",
    "widthCssPx",
    "heightCssPx",
    "dpr",
  ] as const;

  assert.equal(bridge.attach(), true);
  bridge.subscribePainted((ack) => forwarded.push(ack));

  let paintSequence = 1;
  let expectedRecoveryCount = 0;
  for (const field of mismatchedFields) {
    current = frame;
    const plan = planForFrame(frame, paintSequence);
    assert.equal(bridge.publish(plan), true);
    current = Object.freeze({
      ...frame,
      [field]: frame[field] + 1,
    });
    emitPaint(plan, paintSequence);
    paintSequence += 1;
    emitPaint(plan, paintSequence);
    paintSequence += 1;
    if (field !== "surfaceGeneration") expectedRecoveryCount += 1;
    assert.equal(forwarded.length, 0, `${field} mismatch must not forward`);
    assert.equal(
      bridge.snapshot().lastPaintedStamp,
      null,
      `${field} mismatch must not update lastPaintedStamp`,
    );
    assert.equal(recoveryCount, expectedRecoveryCount,
      `${field} mismatch must request at most one current-plan recovery`);
  }

  current = frame;
  const currentPlan = planForFrame(frame, paintSequence);
  assert.equal(bridge.publish(currentPlan), true);
  emitPaint(currentPlan, paintSequence);
  assert.equal(forwarded.length, 1);
  assert.equal(recoveryCount, mismatchedFields.length - 1);
  assert.strictEqual(bridge.snapshot().lastPaintedStamp, currentPlan.stamp);
});

test("scene bridge forwards only the exact plan painted on its current attached generation", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const firstFrame = captureFrame(factory, {});
  const secondFrame = captureFrame(factory, {});
  let current = firstFrame;
  type PaintAck = Readonly<{
    plan: Plan;
    stamp: Plan["stamp"];
    attachmentRevision: number;
    paintSequence: number;
  }>;
  let primitiveListener: ((ack: PaintAck) => void) | null = null;
  let publishedPlan: Plan | null = null;
  let recoveryCount = 0;
  const primitive = {
    publishPlan(plan: Plan) {
      publishedPlan = plan;
      return true;
    },
    clearPlan() { publishedPlan = null; },
    releaseSurfaceCredentials() {},
    subscribePainted(listener: (ack: PaintAck) => void) {
      primitiveListener = listener;
      return () => {
        if (primitiveListener === listener) primitiveListener = null;
      };
    },
  };
  const emitPaint = (plan: Plan, paintSequence: number): void => {
    const listener = primitiveListener;
    listener?.({
      plan,
      stamp: plan.stamp,
      attachmentRevision: 1,
      paintSequence,
    });
  };
  const bridge = createDrawingScenePrimitiveBridge<typeof primitive, Plan>({
    primitive,
    attachPrimitive: () => true,
    detachPrimitive: () => true,
    captureDrawingFrame: () => current,
    isDrawingFrameCurrent: (frame) => frame === current,
    onCurrentPaintRejected: () => { recoveryCount += 1; },
  });
  const firstPlan = planForFrame(firstFrame, 1);
  const newerPlan = planForFrame(firstFrame, 2);
  const forwarded: PaintAck[] = [];

  assert.equal(bridge.attach(), true);
  bridge.subscribePainted((ack) => forwarded.push(ack));
  assert.equal(bridge.publish(firstPlan), true);
  assert.strictEqual(publishedPlan, firstPlan);
  assert.strictEqual(bridge.snapshot().publishedPlan, firstPlan);
  emitPaint(firstPlan, 1);
  assert.deepEqual(forwarded.map((ack) => ack.stamp.documentRevision), [1]);
  assert.strictEqual(bridge.snapshot().lastPaintedStamp, firstPlan.stamp);

  assert.equal(bridge.publish(newerPlan), true);
  assert.equal(bridge.snapshot().lastPaintedStamp, null);
  emitPaint(firstPlan, 2);
  assert.deepEqual(forwarded.map((ack) => ack.stamp.documentRevision), [1]);
  assert.equal(recoveryCount, 0, "a superseded plan must not request recovery");
  emitPaint(newerPlan, 3);
  assert.deepEqual(forwarded.map((ack) => ack.stamp.documentRevision), [1, 2]);

  current = secondFrame;
  emitPaint(newerPlan, 4);
  assert.deepEqual(forwarded.map((ack) => ack.paintSequence), [1, 3]);
  assert.equal(recoveryCount, 0, "a stale surface generation is handled by lifecycle ownership");
  bridge.releaseSurfaceCredentials();
  assert.equal(primitiveListener, null);
  assert.equal(bridge.snapshot().lastPaintedStamp, null);

  assert.equal(bridge.attach(), true);
  const secondPlan = planForFrame(secondFrame, 3);
  const secondForwarded: PaintAck[] = [];
  bridge.subscribePainted((ack) => secondForwarded.push(ack));
  assert.equal(bridge.publish(secondPlan), true);
  emitPaint(secondPlan, 5);
  assert.deepEqual(secondForwarded.map((ack) => ack.stamp.documentRevision), [3]);
  assert.deepEqual(forwarded.map((ack) => ack.stamp.documentRevision), [1, 2, 3]);
  assert.strictEqual(bridge.snapshot().lastPaintedStamp, secondPlan.stamp);
  bridge.clearPlan(false);
  assert.equal(bridge.snapshot().publishedPlan, null);
  assert.equal(bridge.snapshot().lastPaintedStamp, null);
});
