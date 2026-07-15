import assert from "node:assert/strict";
import test from "node:test";
import { createDrawingFrameSnapshotFactory } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingDocument } from "../../core/drawingDocument.js";
import { createDrawingDocumentStore } from "../../core/drawingDocumentStore.js";
import type { LegacyPrimitiveRenderer } from "../../legacy/legacyPrimitiveRenderer.js";
import { createDrawingScreenDisplayList } from "../../rendering/drawingDisplayList.js";
import {
  createDrawingSceneRuntime,
} from "../drawingSceneRuntime.js";
import type {
  DrawingSceneFrameAdapter,
  DrawingSceneProjectionRequest,
} from "../drawingSceneRuntime.js";

function lineEntity(id: string, from: number, to: number) {
  return createDrawingEntity({
    id,
    kind: "line",
    geometry: {
      kind: "line",
      dataPoints: [
        { time: from, price: 10 },
        { time: to, price: 20 },
      ],
    },
    style: { kind: "line", color: "#fff", lineWidth: 2 },
  });
}

function documentWithRevision(revision = 0): DrawingDocument {
  const inside = lineEntity("inside", 10, 20);
  const outside = lineEntity("outside", 110, 120);
  return createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: revision,
    entities: [inside, outside],
    zOrder: [inside.id, outside.id],
  });
}

function frame() {
  return createDrawingFrameSnapshotFactory().capture({
    axisKind: "time",
    barSpacing: 6,
    coordinateKey: "frame-a",
    drawingViewport: {
      horizontalDomain: "time",
      minHorizontal: 0,
      maxHorizontal: 50,
      minPrice: 0,
      maxPrice: 50,
    },
    heightCssPx: 300,
    seriesData: [],
    surfaceToken: {},
    viewportKey: "viewport-a",
    widthCssPx: 500,
  });
}

function fakeAdapter() {
  const captured = frame();
  let current = captured;
  const listeners = new Set<() => void>();
  const adapter: DrawingSceneFrameAdapter = {
    captureDrawingFrame: () => current,
    isDrawingFrameCurrent: (candidate) => candidate === current,
    projectDrawingFrameDataPoints: () => new Float64Array(),
    projectDrawingFrameSourceLineageSpan: () => null,
    subscribeDrawingFrameInvalidation(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    adapter,
    clearFrame: () => { current = null as unknown as typeof captured; },
    restoreFrame: () => { current = captured; },
    emit: () => { for (const listener of listeners) listener(); },
    listenerCount: () => listeners.size,
  };
}

function fakeRenderer(document: DrawingDocument) {
  let represented = document;
  const renderer = {
    documentSnapshot: () => represented,
  } as unknown as LegacyPrimitiveRenderer;
  return {
    renderer,
    setDocument: (next: DrawingDocument) => { represented = next; },
  };
}

function project(request: DrawingSceneProjectionRequest) {
  return createDrawingScreenDisplayList(request.stamp, request.nodes.map((node, index) => ({
    id: node.id,
    kind: node.entity.kind,
    geometryRevision: node.geometryRevision,
    styleRevision: node.styleRevision,
    style: node.entity.style,
    points: new Float64Array([index * 10, 10, index * 10 + 5, 20]),
    bbox: [index * 10, 10, index * 10 + 5, 20] as const,
    handles: new Float64Array([index * 10, 10, index * 10 + 5, 20]),
    handleNames: ["0", "1"],
    hitZones: [{ kind: "polyline" as const, pointOffset: 0, pointCount: 2, tolerance: 8 }],
  })));
}

const immediateParityWork = Object.freeze({
  requestParityWork: (callback: () => void): null => {
    callback();
    return null;
  },
  cancelParityWork: () => {},
});

test("legacy mode is inert and owns no subscriptions", () => {
  const document = documentWithRevision();
  const store = createDrawingDocumentStore(document);
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const runtime = createDrawingSceneRuntime({ mode: "legacy" });
  assert.equal(runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
  }), false);
  assert.equal(adapter.listenerCount(), 0);
  assert.deepEqual(runtime.snapshot(), {
    active: false,
    disposed: false,
    mode: "legacy",
    plan: null,
    scopeKey: null,
  });
  runtime.dispose();
});

test("shadow reconciles the exact document, culls, and publishes an invisible typed plan", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const metrics: unknown[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    now: () => 10,
    onMetrics: (value) => metrics.push(value),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  assert.equal(runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
  }), true);
  assert.equal(adapter.listenerCount(), 1);
  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(runtime.snapshot().plan?.entities.map((entity) => entity.id), ["inside"]);
  assert.deepEqual(metrics, [{
    buildDurationMs: 0,
    culledEntityCount: 1,
    totalEntityCount: 2,
    visibleEntityCount: 1,
  }]);
  runtime.suspend();
  assert.equal(adapter.listenerCount(), 0);
  assert.equal(runtime.snapshot().plan, null);
});

test("data-space culling defers pixel-sized angle and fibonacci bounds to the projector", () => {
  const angle = createDrawingEntity({
    id: "far-angle",
    kind: "angle-measure",
    geometry: {
      kind: "angle-measure",
      dataPoints: [{ time: 1_000, price: 1_000 }, { time: 1_100, price: 1_100 }],
    },
    style: { kind: "angle-measure", color: "#fff", lineWidth: 2 },
  });
  const fibonacci = createDrawingEntity({
    id: "far-fibonacci",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: 1_000, price: 1_000 }, { time: 1_100, price: 1_100 }],
    },
    style: { kind: "fibonacci", color: "#0af", lineWidth: 1 },
  });
  const outside = lineEntity("far-line", 1_000, 1_100);
  const document = createDrawingDocument({
    scopeKey: "scope-a",
    entities: [outside, angle, fibonacci],
    zOrder: [outside.id, angle.id, fibonacci.id],
  });
  const store = createDrawingDocumentStore(document);
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const projectedNodeIds: string[][] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectedNodeIds.push(request.nodes.map((node) => node.id));
      return project(request);
    },
  });

  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(projectedNodeIds, [["far-angle", "far-fibonacci"]]);
  runtime.dispose();
});

test("an unavailable parity sample retries promptly while successful samples remain throttled", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let timestamp = 0;
  let compareCount = 0;
  let projectCount = 0;
  const parityResults: unknown[] = [];
  const parityDurations: number[] = [];
  const skipped: string[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    ...immediateParityWork,
    compareIntervalMs: 5_000,
    compareRetryIntervalMs: 250,
    now: () => timestamp,
    onParity: (result) => parityResults.push(result),
    onParityDuration: (durationMs) => parityDurations.push(durationMs),
    onSkipped: (reason) => skipped.push(reason),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectCount += 1;
      return project(request);
    },
    compareParity: () => {
      compareCount += 1;
      timestamp += 7;
      if (compareCount === 1) return null;
      return Object.freeze({
        ok: true,
        comparedEntityCount: 1,
        comparedHitCount: 0,
        mismatches: Object.freeze([]),
      });
    },
  });

  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 1);
  assert.equal(projectCount, 1);
  assert.deepEqual(parityDurations, [7]);
  assert.ok(skipped.includes("legacy-parity-unavailable"));

  timestamp = 100;
  runtime.invalidate("too-soon");
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 1);

  timestamp = 250;
  runtime.invalidate("retry");
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 2);
  assert.equal(parityResults.length, 1);
  assert.deepEqual(parityDurations, [7, 7]);

  timestamp = 1_000;
  runtime.invalidate("success-throttled");
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 2);
  runtime.dispose();
});

test("successful shadow parity schedules a low-frequency comparison without external invalidation", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let timestamp = 0;
  let compareCount = 0;
  let projectCount = 0;
  let scheduled: (() => void) | null = null;
  let scheduledDelay = -1;
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    ...immediateParityWork,
    compareIntervalMs: 5_000,
    now: () => timestamp,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      scheduled = callback;
      scheduledDelay = delayMs;
      return callback;
    },
    cancelDelay: () => {
      scheduled = null;
    },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectCount += 1;
      return project(request);
    },
    compareParity: () => {
      compareCount += 1;
      return Object.freeze({
        ok: true,
        comparedEntityCount: 1,
        comparedHitCount: 0,
        mismatches: Object.freeze([]),
      });
    },
  });

  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 1);
  assert.equal(projectCount, 1);
  const publishedPlan = runtime.snapshot().plan;
  assert.equal(scheduledDelay, 5_000);
  const parityTick = scheduled as (() => void) | null;
  assert.ok(parityTick);
  timestamp = 5_000;
  parityTick();
  assert.equal(compareCount, 2);
  assert.equal(projectCount, 1);
  assert.strictEqual(runtime.snapshot().plan, publishedPlan);
  runtime.dispose();
});

test("a parity timer tick keeps retrying when the atomic frame is temporarily unavailable", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let timestamp = 0;
  let compareCount = 0;
  let scheduled: (() => void) | null = null;
  let scheduledDelay = -1;
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    ...immediateParityWork,
    compareIntervalMs: 5_000,
    compareRetryIntervalMs: 250,
    now: () => timestamp,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      scheduled = callback;
      scheduledDelay = delayMs;
      return callback;
    },
    cancelDelay: () => {
      scheduled = null;
    },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    compareParity: () => {
      compareCount += 1;
      return Object.freeze({
        ok: true,
        comparedEntityCount: 1,
        comparedHitCount: 0,
        mismatches: Object.freeze([]),
      });
    },
  });
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 1);

  const parityTick = scheduled as (() => void) | null;
  assert.ok(parityTick);
  adapter.clearFrame();
  timestamp = 5_000;
  parityTick();
  assert.equal(scheduledDelay, 250);
  assert.equal(runtime.flushNow(), false);
  assert.equal(compareCount, 1);

  const retryTick = scheduled as (() => void) | null;
  assert.ok(retryTick);
  adapter.restoreFrame();
  timestamp = 5_250;
  retryTick();
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 2);
  runtime.suspend();
  assert.equal(scheduled, null);
});

test("requestParity resets the cadence and queues an immediate strict comparison", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let compareCount = 0;
  let projectCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    ...immediateParityWork,
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectCount += 1;
      return project(request);
    },
    compareParity: () => {
      compareCount += 1;
      return Object.freeze({
        ok: true,
        comparedEntityCount: 1,
        comparedHitCount: 0,
        mismatches: Object.freeze([]),
      });
    },
  });
  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 1);
  assert.equal(projectCount, 1);
  const publishedPlan = runtime.snapshot().plan;
  assert.equal(runtime.requestParity(), true);
  assert.equal(compareCount, 2);
  assert.equal(projectCount, 1);
  assert.strictEqual(runtime.snapshot().plan, publishedPlan);
  runtime.dispose();
  assert.equal(runtime.requestParity(), false);
});

test("production parity work is deferred from the scene build task", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const parityTasks: Array<() => void> = [];
  let compareCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => {},
    requestParityWork: (callback) => {
      parityTasks.push(callback);
      return callback;
    },
    cancelParityWork: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    compareParity: () => {
      compareCount += 1;
      return Object.freeze({
        ok: true,
        comparedEntityCount: 1,
        comparedHitCount: 0,
        mismatches: Object.freeze([]),
      });
    },
  });

  assert.equal(runtime.flushNow(), true);
  assert.equal(compareCount, 0);
  assert.equal(parityTasks.length, 1);
  parityTasks.shift()?.();
  assert.equal(compareCount, 1);
  runtime.dispose();
});

test("default scene work waits for paint and executes in a later throttled task", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const paintCallbacks: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      paintCallbacks.push(callback);
      return paintCallbacks.length;
    },
  });
  try {
    const store = createDrawingDocumentStore(documentWithRevision());
    const adapter = fakeAdapter();
    const renderer = fakeRenderer(store.getSnapshot());
    const runtime = createDrawingSceneRuntime({ mode: "shadow" });
    runtime.activate({
      adapter: adapter.adapter,
      renderer: renderer.renderer,
      store,
      projectScene: project,
    });
    assert.equal(runtime.snapshot().plan, null);
    assert.equal(paintCallbacks.length, 1);
    paintCallbacks.shift()?.(0);
    assert.equal(runtime.snapshot().plan, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 530));
    assert.ok(runtime.snapshot().plan);
    runtime.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "requestAnimationFrame", descriptor);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});

test("default parity waits for the next paint and then leaves the rAF task", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  let paintCallback: FrameRequestCallback | null = null;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      paintCallback = callback;
      return 1;
    },
  });
  try {
    const store = createDrawingDocumentStore(documentWithRevision());
    const adapter = fakeAdapter();
    const renderer = fakeRenderer(store.getSnapshot());
    let compareCount = 0;
    const runtime = createDrawingSceneRuntime({
      mode: "shadow",
      now: () => 0,
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    runtime.activate({
      adapter: adapter.adapter,
      renderer: renderer.renderer,
      store,
      projectScene: project,
      compareParity: () => {
        compareCount += 1;
        return Object.freeze({
          ok: true,
          comparedEntityCount: 1,
          comparedHitCount: 0,
          mismatches: Object.freeze([]),
        });
      },
    });

    assert.equal(runtime.flushNow(), true);
    assert.equal(compareCount, 0);
    assert.ok(paintCallback);
    const deliverPaint = paintCallback as FrameRequestCallback;
    deliverPaint(0);
    assert.equal(compareCount, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(compareCount, 1);
    runtime.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "requestAnimationFrame", descriptor);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});

test("a store publication cannot race ahead of legacy adoption", () => {
  const initial = documentWithRevision();
  const store = createDrawingDocumentStore(initial);
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const skipped: string[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    onSkipped: (reason) => skipped.push(reason),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
  });
  runtime.flushNow();

  const next = documentWithRevision(1);
  assert.equal(store.loadDocument(next).ok, true);
  assert.equal(runtime.flushNow(), false);
  assert.ok(skipped.includes("legacy-document-not-current"));

  renderer.setDocument(store.getSnapshot());
  runtime.invalidate("legacy-adopted");
  assert.equal(runtime.flushNow(), true);
  assert.equal(runtime.snapshot().plan?.stamp.documentRevision, 1);
});

test("frame loss fails closed and disposal is idempotent", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
  });
  adapter.clearFrame();
  assert.equal(runtime.flushNow(), false);
  runtime.dispose();
  runtime.dispose();
  assert.equal(adapter.listenerCount(), 0);
  assert.equal(runtime.snapshot().disposed, true);
  assert.equal(runtime.invalidate(), false);
});
