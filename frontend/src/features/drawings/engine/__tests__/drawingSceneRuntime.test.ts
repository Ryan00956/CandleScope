import assert from "node:assert/strict";
import test from "node:test";
import { createDrawingFrameSnapshotFactory } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingDocument } from "../../core/drawingDocument.js";
import { createDrawingDocumentStore } from "../../core/drawingDocumentStore.js";
import { hitTestDrawingHitIndex } from "../../geometry/drawingHitIndex.js";
import type { LegacyPrimitiveRenderer } from "../../legacy/legacyPrimitiveRenderer.js";
import { drawingPerfCounters } from "../../performance/drawingPerfCounters.js";
import { createDrawingScreenDisplayList } from "../../rendering/drawingDisplayList.js";
import {
  DrawingSceneExactPaintError,
  createDrawingSceneRuntime,
} from "../drawingSceneRuntime.js";
import type {
  DrawingSceneFrameAdapter,
  DrawingSceneProjectionRequest,
} from "../drawingSceneRuntime.js";
import type { DrawingRenderRevisionStamp } from "../drawingRenderScheduler.js";
import type { DrawingScenePaintAck } from "../../rendering/DrawingScenePrimitive.js";
import type {
  DrawingWorkerTransport,
} from "../../worker/drawingWorkerClient.js";
import {
  drawingWorkerViewportByteLength,
} from "../../worker/drawingWorkerProtocol.js";
import type {
  DrawingWorkerRenderRequest,
  DrawingWorkerResponse,
} from "../../worker/drawingWorkerProtocol.js";

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

function freehandDocument(): DrawingDocument {
  const entity = createDrawingEntity({
    id: "ink",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
    },
    style: { kind: "freehand", color: "#60a5fa", lineWidth: 2 },
  });
  return createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: 1,
    entities: [entity],
    zOrder: [entity.id],
  });
}

function sourceLineageFreehandDocument(): DrawingDocument {
  const entity = createDrawingEntity({
    id: "lineage-ink",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      stroke: {
        version: 2,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:10",
        spans: [{
          exact: {
            left: { time: 10, sourceOrdinal: 0 },
            right: { time: 10, sourceOrdinal: 1 },
          },
          fallback: {
            fromTime: 10,
            toTime: 20,
            leftRatio: 0,
            rightRatio: 1,
          },
        }],
        points: [
          { span: 0, ratio: 0, price: 10 },
          { span: 0, ratio: 1, price: 20 },
        ],
      },
    },
    style: { kind: "freehand", color: "#60a5fa", lineWidth: 2 },
  });
  return createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: 1,
    entities: [entity],
    zOrder: [entity.id],
  });
}

function frame({
  coordinateKey = "frame-a",
  includeAffinePriceCertificate = true,
}: {
  coordinateKey?: string;
  includeAffinePriceCertificate?: boolean;
} = {}) {
  return createDrawingFrameSnapshotFactory().capture({
    axisKind: "time",
    barSpacing: 6,
    coordinateKey,
    drawingViewport: {
      horizontalDomain: "time",
      minHorizontal: 0,
      maxHorizontal: 50,
      minPrice: 0,
      maxPrice: 50,
      ...(includeAffinePriceCertificate ? {
        priceProjectionSamples: [
          { price: 0, coordinateCssPx: 300 },
          { price: 25, coordinateCssPx: 150 },
          { price: 50, coordinateCssPx: 0 },
        ],
      } : {}),
    },
    heightCssPx: 300,
    seriesData: [],
    surfaceToken: {},
    viewportKey: "viewport-a",
    widthCssPx: 500,
  });
}

function fakeAdapter(captured = frame()) {
  let current = captured;
  let captureCount = 0;
  const listeners = new Set<(reason?: "manual" | "viewport") => void>();
  const adapter: DrawingSceneFrameAdapter = {
    captureDrawingFrame: () => {
      captureCount += 1;
      return current;
    },
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
    setFrame: (next: typeof captured) => { current = next; },
    emit: (reason?: "manual" | "viewport") => {
      for (const listener of listeners) listener(reason);
    },
    captureCount: () => captureCount,
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

function projectFreehand(
  request: DrawingSceneProjectionRequest,
  compositeOperation: GlobalCompositeOperation = "source-over",
) {
  return createDrawingScreenDisplayList(request.stamp, request.nodes.map((node) => ({
    id: node.id,
    kind: node.entity.kind,
    geometryRevision: node.geometryRevision,
    styleRevision: node.styleRevision,
    style: node.entity.style,
    points: new Float64Array([10, 10, 40, 40]),
    bbox: [10, 10, 40, 40] as const,
    handles: new Float64Array([10, 10, 40, 40]),
    handleNames: ["0", "1"],
    hitZones: [{ kind: "polyline" as const, pointOffset: 0, pointCount: 2, tolerance: 8 }],
    renderSpec: {
      op: "freehand" as const,
      strokeColor: "#60a5fa",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 2,
      opacity: 1,
      compositeOperation,
      brushShape: "round" as const,
      selected: false,
    },
  })));
}

class RuntimeWorkerTransport implements DrawingWorkerTransport {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly posts: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  emit(message: DrawingWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }

  renderRequests(): DrawingWorkerRenderRequest[] {
    return this.posts.filter((message): message is DrawingWorkerRenderRequest => (
      (message as { type?: string }).type === "drawing-worker/render"
    ));
  }
}

function bitmapWorkerResponse(
  request: DrawingWorkerRenderRequest,
  close: () => void,
): DrawingWorkerResponse {
  const paintSpec = request.viewport.paintSpecs[0];
  assert.ok(paintSpec);
  const bitmap = { width: 16, height: 16, close } as unknown as ImageBitmap;
  return {
    type: "drawing-worker/result",
    header: request.header,
    result: {
      kind: "bitmap-draw-result",
      bitmap,
      widthCssPx: request.viewport.widthCssPx,
      heightCssPx: request.viewport.heightCssPx,
      dpr: request.viewport.dpr,
      atlasWidthPhysicalPx: 16,
      atlasHeightPhysicalPx: 16,
      byteLength: 16 * 16 * 4,
      layers: [{
        entityIndex: paintSpec.entityIndex,
        lastEntityIndex: paintSpec.entityIndex,
        sourceXPhysicalPx: 0,
        sourceYPhysicalPx: 0,
        sourceWidthPhysicalPx: 16,
        sourceHeightPhysicalPx: 16,
        destinationXCssPx: 8,
        destinationYCssPx: 8,
        destinationWidthCssPx: 16,
        destinationHeightCssPx: 16,
        opacity: paintSpec.opacity,
        compositeOperation: paintSpec.compositeOperation,
      }],
      rawPointCount: 2,
      renderedPointCount: 2,
      canonicalEntityCount: 1,
    },
  };
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
    hitIndex: null,
    lastExactSettleMs: null,
    lastPaintedStamp: null,
    lastWorkerPublishedStamp: null,
    lastWorkerRequestedStamp: null,
    acceptedWorkerIdentity: null,
    latestSubmittedWorkerIdentity: null,
    lodToleranceClass: "normalStatic",
    mode: "legacy",
    offscreenSupported: typeof OffscreenCanvas === "function",
    paintReceipt: null,
    paintedWorkerIdentity: null,
    plan: null,
    publishedWorkerIdentity: null,
    publicationReady: false,
    rasterBackend: "main-thread",
    rawPointCount: 0,
    renderedPointCount: 0,
    returnedWorkerIdentity: null,
    scopeKey: null,
    staleWorkerPublishCount: 0,
    submittedWorkerHeaders: [],
    workerResultDeliveryDelayMs: 0,
    worker: null,
  });
  runtime.dispose();
});

test("scene-canary filters owned nodes and publishes only through the visible surface sink", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const published = { current: null as ReturnType<typeof project> | null };
  let clearCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  assert.equal(runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    shouldProjectNode: (node) => node.id === "inside",
    publishScene: (plan) => {
      published.current = plan;
      return true;
    },
    clearScene: () => { clearCount += 1; },
  }), true);

  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(published.current?.entities.map((entity) => entity.id), ["inside"]);
  assert.strictEqual(runtime.snapshot().plan, published.current);
  assert.strictEqual(runtime.snapshot().hitIndex?.list, published.current);
  assert.equal(runtime.snapshot().hitIndex?.stats.segmentCount, 1);
  assert.equal(runtime.snapshot().hitIndex?.stats.cellSizeCssPx, 64);
  assert.equal(runtime.requestParity(), false);
  runtime.suspend();
  assert.equal(clearCount, 1);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(runtime.snapshot().hitIndex, null);
});

test("viewport invalidation publishes continuous LOD immediately and exact LOD after the quiet window", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const projectedToleranceClasses: string[] = [];
  const delayed = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  let nextDelayHandle = 0;
  let timestamp = 0;
  let paintedListener: ((stamp: DrawingRenderRevisionStamp) => void) | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    now: () => timestamp,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => {
      delayed.delete(handle as number);
    },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectedToleranceClasses.push(request.lodToleranceClass);
      return project(request);
    },
    publishScene: () => true,
    subscribeScenePainted: (listener) => {
      paintedListener = listener;
      return () => { paintedListener = null; };
    },
  });

  assert.equal(runtime.flushNow(), true);
  timestamp = 10;
  adapter.emit("viewport");
  assert.equal(runtime.snapshot().lodToleranceClass, "continuousViewport");
  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(projectedToleranceClasses, ["normalStatic", "continuousViewport"]);
  assert.equal(delayed.size, 1);
  const exactTaskEntry = [...delayed.entries()][0];
  assert.ok(exactTaskEntry);
  const [exactTaskHandle, exactTask] = exactTaskEntry;
  assert.equal(exactTask.delayMs, 40);

  delayed.delete(exactTaskHandle);
  timestamp = 50;
  exactTask.callback();
  assert.equal(runtime.snapshot().lodToleranceClass, "settledExact");
  timestamp = 55;
  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(projectedToleranceClasses, [
    "normalStatic",
    "continuousViewport",
    "settledExact",
  ]);
  assert.equal(runtime.snapshot().lastExactSettleMs, null,
    "publication alone must not claim that exact pixels reached the canvas");
  timestamp = 105;
  const exactPlan = runtime.snapshot().plan;
  const listener = paintedListener as ((stamp: DrawingRenderRevisionStamp) => void) | null;
  assert.ok(exactPlan && listener);
  listener(exactPlan.stamp);
  assert.equal(runtime.snapshot().lastExactSettleMs, 95);
  runtime.dispose();
});

test("viewport exact quiet window is trailing-edge and restarts at 40 ms", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const projectedToleranceClasses: string[] = [];
  const delayed = new Map<number, Readonly<{
    callback: () => void;
    delayMs: number;
    dueAt: number;
  }>>();
  const cancelled: number[] = [];
  let nextDelayHandle = 0;
  let timestamp = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    now: () => timestamp,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs, dueAt: timestamp + delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => {
      cancelled.push(handle as number);
      delayed.delete(handle as number);
    },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectedToleranceClasses.push(request.lodToleranceClass);
      return project(request);
    },
    publishScene: () => true,
  });
  const runDueDelays = (): void => {
    for (const [handle, task] of [...delayed.entries()]) {
      if (task.dueAt > timestamp) continue;
      delayed.delete(handle);
      task.callback();
    }
  };
  assert.equal(runtime.flushNow(), true);

  timestamp = 10;
  adapter.emit("viewport");
  assert.equal(runtime.flushNow(), true);
  const firstEntry = [...delayed.entries()][0];
  assert.ok(firstEntry);
  assert.equal(firstEntry[1].delayMs, 40);
  assert.equal(firstEntry[1].dueAt, 50);

  timestamp = 42;
  adapter.emit("viewport");
  assert.equal(runtime.flushNow(), true);
  assert.deepEqual(cancelled, [firstEntry[0]]);
  assert.equal(delayed.has(firstEntry[0]), false);
  assert.equal(delayed.size, 1, "only the quiet window after the latest viewport may survive");

  const latestEntry = [...delayed.entries()][0];
  assert.ok(latestEntry);
  assert.notEqual(latestEntry[0], firstEntry[0]);
  assert.equal(latestEntry[1].delayMs, 40);
  assert.equal(latestEntry[1].dueAt, 82);
  const projectionCountBeforeOldDeadline = projectedToleranceClasses.length;
  timestamp = 50;
  runDueDelays();
  assert.equal(projectedToleranceClasses.length, projectionCountBeforeOldDeadline,
    "the cancelled first deadline must not start exact work");
  assert.equal(projectedToleranceClasses.at(-1), "continuousViewport");

  timestamp = 82;
  runDueDelays();
  assert.equal(runtime.flushNow(), true);
  assert.equal(projectedToleranceClasses.at(-1), "settledExact");
  runtime.dispose();
});

test("chart-frame synchronization replaces an unannounced stale viewport plan before paint", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const initialFrame = frame();
  const pannedFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 1,
  });
  const adapter = fakeAdapter(initialFrame);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof project>[] = [];
  const projectedToleranceClasses: string[] = [];
  const delayed = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  let nextDelayHandle = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => { delayed.delete(handle as number); },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectedToleranceClasses.push(request.lodToleranceClass);
      return project(request);
    },
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });

  assert.equal(runtime.flushNow(), true);
  assert.equal(published.length, 1);
  adapter.setFrame(pannedFrame);
  const capturesBeforeSync = adapter.captureCount();
  assert.equal(runtime.synchronizeChartFrame(), true);
  assert.equal(adapter.captureCount(), capturesBeforeSync + 1,
    "same-frame publication must carry one immutable capture through build and freshness checks");
  assert.equal(published.length, 2);
  assert.equal(published[1]?.stamp.viewportRevision, pannedFrame.viewportRevision);
  assert.equal(runtime.snapshot().lodToleranceClass, "continuousViewport");
  assert.deepEqual(projectedToleranceClasses, ["normalStatic", "continuousViewport"]);
  assert.deepEqual([...delayed.values()].map((task) => task.delayMs), [40]);
  assert.equal(runtime.synchronizeChartFrame(), false,
    "a second updateAllViews pass over the same viewport must not rebuild");
  assert.equal(published.length, 2);
  runtime.dispose();
});

test("chart-frame synchronization does not capture empty drawing documents", () => {
  const emptyDocument = createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: 0,
    entities: [],
    zOrder: [],
  });
  const store = createDrawingDocumentStore(emptyDocument);
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(emptyDocument);
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => true,
  });
  const capturesBeforeSync = adapter.captureCount();

  assert.equal(runtime.synchronizeChartFrame(), false);
  assert.equal(adapter.captureCount(), capturesBeforeSync);
  runtime.dispose();
});

test("chart-frame synchronization replaces a stale freehand viewport without waiting for its worker", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const initialFrame = frame();
  const pannedFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 1,
  });
  const adapter = fakeAdapter(initialFrame);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });

  assert.equal(runtime.synchronizeChartFrame(), false,
    "first publication has no stale pixels to replace");
  assert.equal(runtime.flushNow(), true);
  const initialWorkerRequest = transport.renderRequests()[0];
  assert.ok(initialWorkerRequest);
  transport.emit(bitmapWorkerResponse(initialWorkerRequest, () => {}));
  assert.equal(published.length, 1);

  adapter.setFrame(pannedFrame);
  assert.equal(runtime.synchronizeChartFrame(), true);
  assert.equal(published.length, 2);
  assert.strictEqual(runtime.snapshot().plan, published[1]);
  assert.equal(published[1]?.stamp.viewportRevision, pannedFrame.viewportRevision);
  assert.equal(transport.renderRequests().length, 1,
    "the current chart frame cannot wait for a worker round-trip");

  assert.equal(runtime.invalidate("settled-worker-pass"), true);
  assert.equal(runtime.flushNow(), true);
  assert.equal(transport.renderRequests().length, 2,
    "ordinary scheduled work keeps the worker raster path");
  runtime.dispose();
});

test("mutation admission publishes a restored freehand scene before its worker round-trip", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter(frame());
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });

  assert.equal(runtime.flushMutationAdmission?.(), true);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.freehandRaster, undefined);
  assert.equal(runtime.snapshot().publicationReady, true);
  assert.equal(transport.renderRequests().length, 0,
    "the waiting pointerdown must not block on a first worker result");

  assert.equal(runtime.invalidate("worker-enhancement"), true);
  assert.equal(runtime.flushNow(), true);
  assert.equal(transport.renderRequests().length, 1,
    "ordinary invalidation keeps the worker enhancement path");
  runtime.dispose();
});

test("quiet exact pass keeps first visible publication worker-owned and accepts only latest viewport", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const initialFrame = frame();
  const pannedFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 1,
  });
  const adapter = fakeAdapter(initialFrame);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const delayed = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  let nextDelayHandle = 0;
  let firstBitmapClosed = 0;
  let finalBitmapClosed = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => { delayed.delete(handle as number); },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });

  assert.equal(runtime.flushNow(), true);
  const initialWorkerRequest = transport.renderRequests().at(-1);
  assert.ok(initialWorkerRequest);
  assert.equal(published.length, 0);

  adapter.setFrame(pannedFrame);
  adapter.emit("viewport");
  assert.equal(runtime.synchronizeChartFrame(), false,
    "without accepted pixels the chart-frame path must not create a main-thread first publication");
  assert.equal(published.length, 0);

  const quietEntry = [...delayed.entries()][0];
  assert.ok(quietEntry);
  assert.equal(quietEntry[1].delayMs, 40);
  delayed.delete(quietEntry[0]);
  quietEntry[1].callback();
  assert.equal(runtime.flushNow(), true,
    "the exact viewport coalesces the scheduled continuous build into pending-latest");
  const pendingExact = runtime.snapshot();
  assert.equal(pendingExact.worker?.queueDepth, 2);
  assert.equal(pendingExact.worker?.inFlight, 1);
  assert.equal(pendingExact.worker?.pending, 1);
  assert.deepEqual(pendingExact.worker?.inFlightHeader, initialWorkerRequest.header);
  const pendingExactHeader = pendingExact.worker?.pendingHeader;
  assert.ok(pendingExactHeader);
  assert.deepEqual(pendingExactHeader, pendingExact.latestSubmittedWorkerIdentity);
  assert.equal(transport.renderRequests().length, 1,
    "pending-latest cannot dispatch before the initial in-flight job terminates");

  transport.emit(bitmapWorkerResponse(initialWorkerRequest, () => { firstBitmapClosed += 1; }));
  assert.equal(firstBitmapClosed, 1);
  assert.equal(published.length, 0, "the superseded initial bitmap must never become visible");
  const latestWorkerRequest = transport.renderRequests().at(-1);
  assert.ok(latestWorkerRequest);
  assert.deepEqual(latestWorkerRequest.header, pendingExactHeader);

  transport.emit(bitmapWorkerResponse(latestWorkerRequest, () => { finalBitmapClosed += 1; }));
  const finalSnapshot = runtime.snapshot();
  assert.equal(published.length, 1);
  assert.strictEqual(finalSnapshot.plan, published[0]);
  assert.ok(finalSnapshot.plan?.freehandRaster,
    "the first accepted visible publication must remain worker-owned");
  assert.equal(finalSnapshot.plan?.stamp.viewportRevision, pannedFrame.viewportRevision);
  assert.deepEqual(finalSnapshot.publishedWorkerIdentity, latestWorkerRequest.header);
  assert.equal(finalSnapshot.worker?.queueDepth, 0);
  assert.equal(finalSnapshot.staleWorkerPublishCount, 0);
  finalSnapshot.plan?.freehandRaster?.bitmap.close();
  assert.equal(finalBitmapClosed, 1);
  runtime.dispose();
});

test("source-lineage exact remains worker-only after continuous viewport publication", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(sourceLineageFreehandDocument());
  const initialFrame = frame();
  const pannedFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 1,
  });
  const adapter = fakeAdapter(initialFrame);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const delayed = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  let nextDelayHandle = 0;
  let visiblePlan: ReturnType<typeof projectFreehand> | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => { delayed.delete(handle as number); },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      visiblePlan?.freehandRaster?.bitmap.close();
      visiblePlan = plan;
      published.push(plan);
      return true;
    },
  });

  assert.equal(runtime.flushNow(), true);
  const initialRequest = transport.renderRequests().at(-1);
  assert.ok(initialRequest);
  transport.emit(bitmapWorkerResponse(initialRequest, () => {}));
  assert.equal(published.length, 1);

  adapter.setFrame(pannedFrame);
  adapter.emit("viewport");
  assert.equal(runtime.synchronizeChartFrame(), true);
  assert.equal(published.length, 2, "continuous lineage LOD must still publish before paint");
  const quietEntry = [...delayed.entries()][0];
  assert.ok(quietEntry);
  delayed.delete(quietEntry[0]);
  quietEntry[1].callback();
  assert.equal(runtime.flushNow(), true);
  const exactRequest = transport.renderRequests().at(-1);
  assert.ok(exactRequest);
  assert.equal(published.length, 2,
    "high-cost lineage exact must not take the main-thread latency hedge");

  transport.emit(bitmapWorkerResponse(exactRequest, () => {}));
  assert.equal(published.length, 3);
  assert.ok(runtime.snapshot().plan?.freehandRaster);
  runtime.snapshot().plan?.freehandRaster?.bitmap.close();
  runtime.dispose();
});

test("new viewport supersedes an in-flight exact worker and converges on the latest painted stamp", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const initialFrame = frame();
  const firstViewportFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 1,
  });
  const latestViewportFrame: DrawingFrameSnapshot = Object.freeze({
    ...initialFrame,
    viewportRevision: initialFrame.viewportRevision + 2,
  });
  const adapter = fakeAdapter(initialFrame);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const delayed = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  let nextDelayHandle = 0;
  let visiblePlan: ReturnType<typeof projectFreehand> | null = null;
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  let initialBitmapClosed = 0;
  let staleBitmapClosed = 0;
  let finalBitmapClosed = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
    scheduleDelay: (callback, delayMs) => {
      nextDelayHandle += 1;
      delayed.set(nextDelayHandle, { callback, delayMs });
      return nextDelayHandle;
    },
    cancelDelay: (handle) => { delayed.delete(handle as number); },
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      visiblePlan?.freehandRaster?.bitmap.close();
      visiblePlan = plan;
      published.push(plan);
      return true;
    },
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });

  assert.equal(runtime.flushNow(), true);
  const initialWorkerRequest = transport.renderRequests().at(-1);
  assert.ok(initialWorkerRequest);
  transport.emit(bitmapWorkerResponse(initialWorkerRequest, () => { initialBitmapClosed += 1; }));
  assert.equal(published.length, 1);

  adapter.setFrame(firstViewportFrame);
  adapter.emit("viewport");
  assert.equal(runtime.synchronizeChartFrame(), true);
  assert.equal(initialBitmapClosed, 1, "the continuous viewport replaces the initial raster");
  const firstQuietEntry = [...delayed.entries()][0];
  assert.ok(firstQuietEntry);
  assert.equal(firstQuietEntry[1].delayMs, 40);
  delayed.delete(firstQuietEntry[0]);
  firstQuietEntry[1].callback();
  assert.equal(runtime.flushNow(), true);
  const staleExactRequest = transport.renderRequests().at(-1);
  assert.ok(staleExactRequest);
  assert.deepEqual(runtime.snapshot().worker?.inFlightHeader, staleExactRequest.header);

  adapter.setFrame(latestViewportFrame);
  adapter.emit("viewport");
  assert.equal(runtime.synchronizeChartFrame(), true,
    "the latest viewport must publish synchronously without waiting for stale exact work");
  const latestContinuousPlan = runtime.snapshot().plan;
  assert.ok(latestContinuousPlan);
  assert.equal(latestContinuousPlan.stamp.viewportRevision, latestViewportFrame.viewportRevision);
  const latestQuietEntry = [...delayed.entries()][0];
  assert.ok(latestQuietEntry);
  assert.equal(latestQuietEntry[1].delayMs, 40);
  delayed.delete(latestQuietEntry[0]);
  latestQuietEntry[1].callback();
  assert.equal(runtime.flushNow(), true);
  const queuedLatest = runtime.snapshot();
  assert.equal(queuedLatest.worker?.queueDepth, 2);
  assert.deepEqual(queuedLatest.worker?.inFlightHeader, staleExactRequest.header);
  const pendingLatestHeader = queuedLatest.worker?.pendingHeader;
  assert.ok(pendingLatestHeader);
  assert.deepEqual(pendingLatestHeader, queuedLatest.latestSubmittedWorkerIdentity);
  const exactLatencyHedge = queuedLatest.plan;
  assert.ok(exactLatencyHedge);
  assert.notStrictEqual(exactLatencyHedge, latestContinuousPlan,
    "a queued exact worker must not spend the stop-to-painted latency budget");
  assert.equal(exactLatencyHedge.stamp.viewportRevision, latestViewportFrame.viewportRevision);
  assert.equal(exactLatencyHedge.freehandRaster, undefined,
    "the latency hedge publishes the exact main-thread list while raster work stays queued");
  const listener = exactPaintListener as ((ack: DrawingScenePaintAck) => void) | null;
  assert.ok(listener);
  listener({
    plan: exactLatencyHedge,
    stamp: exactLatencyHedge.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  assert.ok((runtime.snapshot().lastExactSettleMs ?? -1) >= 0);

  transport.emit(bitmapWorkerResponse(staleExactRequest, () => { staleBitmapClosed += 1; }));
  assert.equal(staleBitmapClosed, 1);
  assert.strictEqual(runtime.snapshot().plan, exactLatencyHedge,
    "a stale exact bitmap must not roll the visible scene back from the exact latency hedge");
  assert.equal(runtime.snapshot().staleWorkerPublishCount, 0);
  assert.equal(runtime.snapshot().worker?.staleResultCount, 1);

  const latestExactRequest = transport.renderRequests().at(-1);
  assert.ok(latestExactRequest);
  assert.deepEqual(latestExactRequest.header, pendingLatestHeader);
  transport.emit(bitmapWorkerResponse(latestExactRequest, () => { finalBitmapClosed += 1; }));
  const finalPlan = runtime.snapshot().plan;
  assert.ok(finalPlan?.freehandRaster);
  assert.equal(finalPlan.stamp.viewportRevision, latestViewportFrame.viewportRevision);
  listener({
    plan: finalPlan,
    stamp: finalPlan.stamp,
    attachmentRevision: 2,
    paintSequence: 2,
  });

  const converged = runtime.snapshot();
  assert.deepEqual(converged.lastWorkerRequestedStamp, finalPlan.stamp);
  assert.deepEqual(converged.lastWorkerPublishedStamp, finalPlan.stamp);
  assert.deepEqual(converged.lastPaintedStamp, finalPlan.stamp);
  assert.equal(converged.worker?.queueDepth, 0);
  assert.equal(converged.worker?.inFlight, 0);
  assert.equal(converged.worker?.pending, 0);
  assert.equal(converged.staleWorkerPublishCount, 0);
  finalPlan.freehandRaster.bitmap.close();
  assert.equal(finalBitmapClosed, 1);
  runtime.dispose();
});

test("exact paint barrier accepts only a fresh exact plan and newer full paint evidence", async () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => true,
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });
  assert.equal(runtime.flushNow(), true);
  const previousPlan = runtime.snapshot().plan;
  assert.ok(previousPlan);
  const deliverExactPaint = (ack: DrawingScenePaintAck): void => {
    const listener = exactPaintListener as ((value: DrawingScenePaintAck) => void) | null;
    assert.ok(listener);
    listener(ack);
  };
  deliverExactPaint({
    plan: previousPlan,
    stamp: previousPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  const initialPaintSnapshot = runtime.snapshot();
  assert.deepEqual(initialPaintSnapshot.lastPaintedStamp, previousPlan.stamp);
  assert.equal(initialPaintSnapshot.paintReceipt?.kind, "drawing-scene-bridge-paint-ack");
  assert.equal(initialPaintSnapshot.paintReceipt?.attachmentRevision, 1);
  assert.equal(initialPaintSnapshot.paintReceipt?.paintSequence, 1);
  assert.deepEqual(initialPaintSnapshot.paintReceipt?.stamp, previousPlan.stamp);
  assert.ok(Number.isFinite(Date.parse(initialPaintSnapshot.paintReceipt?.observedAt ?? "")));

  let settled = false;
  const pending = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 1_000,
  });
  void pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const exactPlan = runtime.snapshot().plan;
  assert.ok(exactPlan);
  assert.notStrictEqual(exactPlan, previousPlan);
  assert.equal(runtime.snapshot().lodToleranceClass, "settledExact");

  deliverExactPaint({
    plan: previousPlan,
    stamp: previousPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 2,
  });
  deliverExactPaint({
    plan: exactPlan,
    stamp: exactPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  deliverExactPaint({
    plan: exactPlan,
    stamp: { ...exactPlan.stamp },
    attachmentRevision: 1,
    paintSequence: 2,
  });
  await Promise.resolve();
  assert.equal(settled, false);

  deliverExactPaint({
    plan: exactPlan,
    stamp: exactPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 2,
  });
  const receipt = await pending;
  assert.strictEqual(receipt.plan, exactPlan);
  assert.strictEqual(receipt.stamp, exactPlan.stamp);
  assert.equal(receipt.lodToleranceClass, "settledExact");
  assert.equal(receipt.attachmentRevision, 1);
  assert.equal(receipt.paintSequence, 2);
  assert.ok(receipt.sceneEpoch > 0);
  const finalPaintSnapshot = runtime.snapshot();
  assert.deepEqual(finalPaintSnapshot.lastPaintedStamp, exactPlan.stamp);
  assert.equal(finalPaintSnapshot.paintReceipt?.paintSequence, 2);
  assert.deepEqual(finalPaintSnapshot.paintReceipt?.stamp, exactPlan.stamp);
  runtime.dispose();
});

test("export-only hidden visibility receives an exact empty plan before ordinary suspend", async () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let visible = true;
  let clearCount = 0;
  const clearScene = () => { clearCount += 1; };
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    isVisible: () => visible,
    publishScene: () => true,
    clearScene,
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });
  assert.equal(runtime.flushNow(), true);
  const visiblePlan = runtime.snapshot().plan;
  assert.ok(visiblePlan);
  assert.equal(visiblePlan.entities.length, 1);
  const deliverExactPaint = (ack: DrawingScenePaintAck): void => {
    const listener = exactPaintListener as ((value: DrawingScenePaintAck) => void) | null;
    assert.ok(listener);
    listener(ack);
  };
  deliverExactPaint({
    plan: visiblePlan,
    stamp: visiblePlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });

  visible = false;
  clearScene();
  assert.equal(runtime.invalidate("export-visibility-hidden"), true);
  const pending = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 1_000,
  });
  const hiddenPlan = runtime.snapshot().plan;
  assert.ok(hiddenPlan);
  assert.notStrictEqual(hiddenPlan, visiblePlan);
  assert.equal(hiddenPlan.entities.length, 0);
  deliverExactPaint({
    plan: hiddenPlan,
    stamp: hiddenPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 2,
  });

  const receipt = await pending;
  assert.strictEqual(receipt.plan, hiddenPlan);
  assert.equal(receipt.plan.entities.length, 0);
  assert.equal(runtime.snapshot().publicationReady, true);

  runtime.suspend();
  assert.equal(runtime.snapshot().active, false);
  assert.equal(runtime.snapshot().publicationReady, false);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(adapter.listenerCount(), 0);
  adapter.emit("viewport");
  assert.equal(runtime.invalidate("capture-frame-advanced"), false);
  assert.equal(runtime.snapshot().plan, null);
  assert.ok(clearCount >= 2);
  runtime.dispose();
});

test("exact paint barrier follows the newest scene epoch and ignores a stale plan ack", async () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => true,
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });

  let settled = false;
  const pending = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 1_000,
  });
  void pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const firstExactPlan = runtime.snapshot().plan;
  assert.ok(firstExactPlan);
  const deliverExactPaint = (ack: DrawingScenePaintAck): void => {
    const listener = exactPaintListener as ((value: DrawingScenePaintAck) => void) | null;
    assert.ok(listener);
    listener(ack);
  };
  assert.equal(runtime.invalidate("newer-scene"), true);
  assert.equal(runtime.flushNow(), true);
  const currentExactPlan = runtime.snapshot().plan;
  assert.ok(currentExactPlan);
  assert.notStrictEqual(currentExactPlan, firstExactPlan);

  deliverExactPaint({
    plan: firstExactPlan,
    stamp: firstExactPlan.stamp,
    attachmentRevision: 2,
    paintSequence: 1,
  });
  await Promise.resolve();
  assert.equal(settled, false);

  deliverExactPaint({
    plan: currentExactPlan,
    stamp: currentExactPlan.stamp,
    attachmentRevision: 2,
    paintSequence: 2,
  });
  const receipt = await pending;
  assert.strictEqual(receipt.plan, currentExactPlan);
  assert.equal(receipt.paintSequence, 2);
  runtime.dispose();
});

test("exact paint barrier rejects document and scope invalidation explicitly", async () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => true,
    subscribeSceneExactPainted: () => () => {},
  });

  const documentWait = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 1_000,
  });
  const documentRejection = assert.rejects(documentWait, (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "document-invalidated");
    return true;
  });
  assert.equal(store.loadDocument(documentWithRevision(1)).ok, true);
  await documentRejection;

  renderer.setDocument(store.getSnapshot());
  const scopeWait = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 1,
    timeoutMs: 1_000,
  });
  const scopeRejection = assert.rejects(scopeWait, (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "scope-invalidated");
    return true;
  });
  runtime.suspend();
  await scopeRejection;
});

test("exact paint barrier rejects timeout, abort, and missing exact evidence", async () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  const binding = {
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => true,
    subscribeSceneExactPainted: () => () => {},
  } as const;
  runtime.activate(binding);

  await assert.rejects(runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 5,
  }), (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "timeout");
    return true;
  });

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    signal: preAborted.signal,
  }), (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "aborted");
    return true;
  });

  const aborted = new AbortController();
  const abortWait = runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
    timeoutMs: 1_000,
    signal: aborted.signal,
  });
  const abortRejection = assert.rejects(abortWait, (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "aborted");
    return true;
  });
  aborted.abort();
  await abortRejection;

  assert.equal(runtime.activate({
    adapter: binding.adapter,
    renderer: binding.renderer,
    store: binding.store,
    projectScene: binding.projectScene,
    publishScene: binding.publishScene,
  }), true);
  await assert.rejects(runtime.waitForExactPaint({
    scopeKey: "scope-a",
    documentRevision: 0,
  }), (error: unknown) => {
    assert.ok(error instanceof DrawingSceneExactPaintError);
    assert.equal(error.code, "runtime-unavailable");
    return true;
  });
  runtime.dispose();
});

test("worker backend fails closed to the same indexed scene when Worker is unavailable", () => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: undefined,
  });
  try {
    const store = createDrawingDocumentStore(documentWithRevision());
    const adapter = fakeAdapter();
    const renderer = fakeRenderer(store.getSnapshot());
    let publicationCount = 0;
    const runtime = createDrawingSceneRuntime({
      mode: "scene-canary",
      rasterBackend: "worker",
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    assert.equal(runtime.activate({
      adapter: adapter.adapter,
      renderer: renderer.renderer,
      store,
      projectScene: project,
      publishScene: () => {
        publicationCount += 1;
        return true;
      },
    }), true);

    assert.equal(runtime.snapshot().rasterBackend, "main-thread");
    assert.equal(runtime.snapshot().worker?.availability, "unavailable");
    assert.equal(runtime.snapshot().worker?.unavailableReason, "unsupported");
    assert.equal(runtime.flushNow(), true);
    assert.equal(publicationCount, 1);
    assert.ok(runtime.snapshot().plan);
    assert.strictEqual(runtime.snapshot().hitIndex?.list, runtime.snapshot().plan);
    runtime.dispose();
  } finally {
    if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("same-stamp invalidation rejects an old worker bitmap before a new scene epoch builds", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  let closed = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });
  assert.equal(runtime.flushNow(), true);
  const first = transport.renderRequests()[0];
  assert.ok(first);

  // Selection/overlay ownership can change without changing the document or
  // frame stamp. The epoch invalidation must still make this result stale.
  assert.equal(runtime.invalidate("same-stamp-selection-change"), true);
  transport.emit(bitmapWorkerResponse(first, () => { closed += 1; }));
  assert.equal(closed, 1);
  assert.equal(published.length, 0);
  assert.deepEqual(runtime.snapshot().returnedWorkerIdentity, first.header);
  assert.equal(runtime.snapshot().acceptedWorkerIdentity, null);
  assert.equal(runtime.snapshot().publishedWorkerIdentity, null);

  assert.equal(runtime.flushNow(), true);
  const second = transport.renderRequests()[1];
  assert.ok(second);
  assert.deepEqual(second.header.stamp, first.header.stamp);
  transport.emit(bitmapWorkerResponse(second, () => { closed += 1; }));
  assert.equal(published.length, 1);
  assert.deepEqual(runtime.snapshot().acceptedWorkerIdentity, second.header);
  assert.deepEqual(runtime.snapshot().publishedWorkerIdentity, second.header);
  assert.equal(runtime.snapshot().paintedWorkerIdentity, null,
    "publication alone must not claim that the worker plan reached the canvas");
  const exactPlan = published[0];
  assert.ok(exactPlan);
  const emitExactPaint = exactPaintListener as ((ack: DrawingScenePaintAck) => void) | null;
  assert.ok(emitExactPaint);
  emitExactPaint({
    plan: exactPlan,
    stamp: exactPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  assert.deepEqual(runtime.snapshot().paintedWorkerIdentity, second.header);
  assert.ok(published[0]?.freehandRaster);
  assert.equal(runtime.snapshot().rasterBackend, "worker");
  assert.equal(runtime.snapshot().staleWorkerPublishCount, 0,
    "a superseded result rejected inside the client never attempts publication");
  published[0]?.freehandRaster?.bitmap.close();
  runtime.dispose();
  assert.equal(closed, 2);
});

test("a same-stamp main-thread paint cannot inherit the prior worker publication identity", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  let closed = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
    subscribeSceneExactPainted: (listener) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  });

  assert.equal(runtime.flushNow(), true);
  const workerRequest = transport.renderRequests()[0];
  assert.ok(workerRequest);
  transport.emit(bitmapWorkerResponse(workerRequest, () => { closed += 1; }));
  const workerPlan = published[0];
  assert.ok(workerPlan);
  const emitExactPaint = exactPaintListener as ((ack: DrawingScenePaintAck) => void) | null;
  assert.ok(emitExactPaint);
  emitExactPaint({
    plan: workerPlan,
    stamp: workerPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  assert.deepEqual(runtime.snapshot().paintedWorkerIdentity, workerRequest.header);

  // A settled invalidation at the same frame stamp submits the next worker
  // job but uses the exact main-thread hedge for the immediately visible plan.
  adapter.emit("manual");
  assert.equal(runtime.flushNow(), true);
  const mainThreadPlan = published[1];
  assert.ok(mainThreadPlan);
  assert.deepEqual(mainThreadPlan.stamp, workerPlan.stamp);
  assert.equal(mainThreadPlan.freehandRaster, undefined);
  assert.equal(runtime.snapshot().publishedWorkerIdentity, null);
  emitExactPaint({
    plan: mainThreadPlan,
    stamp: mainThreadPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 2,
  });
  assert.equal(runtime.snapshot().paintedWorkerIdentity, null,
    "paint provenance must come from the acknowledged plan, not a same-stamp global identity");

  workerPlan.freehandRaster?.bitmap.close();
  runtime.dispose();
  assert.equal(closed, 1);
});

test("rebuilding the worker client clears the prior painted identity namespace", () => {
  const transports = [new RuntimeWorkerTransport(), new RuntimeWorkerTransport()];
  let transportIndex = 0;
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let visiblePlan: ReturnType<typeof projectFreehand> | null = null;
  let exactPaintListener: ((ack: DrawingScenePaintAck) => void) | null = null;
  let acceptPublication = true;
  let closed = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transports[transportIndex++]!,
    requestFrame: () => 1,
    cancelFrame: () => {},
    onError: () => {},
  });
  const binding = {
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan: ReturnType<typeof projectFreehand>) => {
      if (acceptPublication) visiblePlan = plan;
      return acceptPublication;
    },
    subscribeSceneExactPainted: (listener: (ack: DrawingScenePaintAck) => void) => {
      exactPaintListener = listener;
      return () => { exactPaintListener = null; };
    },
  };
  runtime.activate(binding);

  assert.equal(runtime.flushNow(), true);
  const paintedRequest = transports[0]!.renderRequests()[0];
  assert.ok(paintedRequest);
  transports[0]!.emit(bitmapWorkerResponse(paintedRequest, () => { closed += 1; }));
  const paintedPlan = visiblePlan as ReturnType<typeof projectFreehand> | null;
  assert.ok(paintedPlan);
  const emitExactPaint = exactPaintListener as ((ack: DrawingScenePaintAck) => void) | null;
  assert.ok(emitExactPaint);
  emitExactPaint({
    plan: paintedPlan,
    stamp: paintedPlan.stamp,
    attachmentRevision: 1,
    paintSequence: 1,
  });
  assert.deepEqual(runtime.snapshot().paintedWorkerIdentity, paintedRequest.header);

  assert.equal(runtime.invalidate("force-worker-publication-rejection"), true);
  assert.equal(runtime.flushNow(), true);
  const rejectedRequest = transports[0]!.renderRequests()[1];
  assert.ok(rejectedRequest);
  acceptPublication = false;
  transports[0]!.emit(bitmapWorkerResponse(rejectedRequest, () => { closed += 1; }));
  assert.equal(runtime.snapshot().active, false);
  assert.deepEqual(runtime.snapshot().paintedWorkerIdentity, paintedRequest.header);

  acceptPublication = true;
  assert.equal(runtime.activate(binding), true);
  const rebuilt = runtime.snapshot();
  assert.equal(transports[0]!.terminated, true);
  assert.equal(rebuilt.paintedWorkerIdentity, null);
  assert.equal(rebuilt.publishedWorkerIdentity, null);
  assert.equal(rebuilt.latestSubmittedWorkerIdentity, null);
  assert.deepEqual(rebuilt.submittedWorkerHeaders, []);

  assert.equal(runtime.flushNow(), true);
  const rebuiltRequest = transports[1]!.renderRequests()[0];
  assert.ok(rebuiltRequest);
  assert.equal(rebuiltRequest.header.jobId, 1,
    "the rebuilt transport owns a fresh identity namespace");

  paintedPlan.freehandRaster?.bitmap.close();
  runtime.dispose();
  assert.equal(closed, 2);
});

test("worker evidence records real stale, accepted, and published boundaries with bounded history", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let visiblePlan: ReturnType<typeof projectFreehand> | null = null;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      visiblePlan?.freehandRaster?.bitmap.close();
      visiblePlan = plan;
      return true;
    },
  });

  assert.equal(runtime.flushNow(), true);
  const staleRequest = transport.renderRequests()[0];
  assert.ok(staleRequest);
  assert.equal(runtime.invalidate("queue-latest"), true);
  assert.equal(runtime.flushNow(), true);
  const queued = runtime.snapshot();
  assert.equal(queued.submittedWorkerHeaders.length, 2);
  assert.deepEqual(queued.submittedWorkerHeaders[0], staleRequest.header);
  assert.deepEqual(
    queued.latestSubmittedWorkerIdentity,
    queued.submittedWorkerHeaders[1],
  );
  assert.equal(queued.returnedWorkerIdentity, null);
  assert.equal(queued.acceptedWorkerIdentity, null);
  assert.equal(queued.publishedWorkerIdentity, null);

  transport.emit(bitmapWorkerResponse(staleRequest, () => {}));
  const afterStale = runtime.snapshot();
  assert.deepEqual(afterStale.returnedWorkerIdentity, staleRequest.header);
  assert.equal(afterStale.acceptedWorkerIdentity, null);
  assert.equal(afterStale.publishedWorkerIdentity, null);

  const latestRequest = transport.renderRequests()[1];
  assert.ok(latestRequest);
  assert.deepEqual(latestRequest.header, afterStale.latestSubmittedWorkerIdentity);
  transport.emit(bitmapWorkerResponse(latestRequest, () => {}));
  const afterLatest = runtime.snapshot();
  assert.deepEqual(afterLatest.returnedWorkerIdentity, staleRequest.header);
  assert.deepEqual(afterLatest.acceptedWorkerIdentity, latestRequest.header);
  assert.deepEqual(afterLatest.publishedWorkerIdentity, latestRequest.header);

  for (let index = 0; index < 33; index += 1) {
    assert.equal(runtime.invalidate(`bounded-history-${index}`), true);
    assert.equal(runtime.flushNow(), true);
    const request = transport.renderRequests().at(-1);
    assert.ok(request);
    transport.emit(bitmapWorkerResponse(request, () => {}));
  }
  const bounded = runtime.snapshot();
  assert.equal(bounded.submittedWorkerHeaders.length, 32);
  assert.deepEqual(
    bounded.submittedWorkerHeaders.at(-1),
    bounded.latestSubmittedWorkerIdentity,
  );
  assert.ok(bounded.submittedWorkerHeaders.some((identity) => (
    identity.jobId === bounded.returnedWorkerIdentity?.jobId
      && identity.generation === bounded.returnedWorkerIdentity.generation
  )));
  assert.ok(bounded.submittedWorkerHeaders.every((identity, index) => (
    index === 0
      || (identity.jobId > bounded.submittedWorkerHeaders[index - 1]!.jobId
        && identity.generation > bounded.submittedWorkerHeaders[index - 1]!.generation)
  )));
  runtime.snapshot().plan?.freehandRaster?.bitmap.close();
  runtime.dispose();
});

test("viewport invalidation captures its atomic frame only in the scheduled build", () => {
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
  assert.equal(runtime.flushNow(), true);

  const beforeViewport = adapter.captureCount();
  adapter.emit("viewport");
  adapter.emit("viewport");
  assert.equal(adapter.captureCount(), beforeViewport,
    "coalesced wheel/pan invalidations must not duplicate the scheduled frame capture");
  assert.equal(runtime.flushNow(), true);
  assert.ok(adapter.captureCount() > beforeViewport);

  const beforeManual = adapter.captureCount();
  adapter.emit("manual");
  assert.equal(adapter.captureCount(), beforeManual + 1,
    "manual coordinate transitions retain synchronous fail-closed detection");
  runtime.dispose();
});

test("a stale projection session publishes no partial plan and follows up", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const baseAdapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const skipped: string[] = [];
  const published: unknown[] = [];
  const frames: Array<() => void> = [];
  let rejectFirstSession = true;
  let sessionCount = 0;
  const adapter: DrawingSceneFrameAdapter = {
    ...baseAdapter.adapter,
    runDrawingFrameProjectionSession<T>(
      _frame: DrawingFrameSnapshot,
      work: () => T | null,
    ): T | null {
      sessionCount += 1;
      const result = work();
      if (!rejectFirstSession) return result;
      rejectFirstSession = false;
      return null;
    },
  };
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "main-thread",
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
    onSkipped: (reason) => skipped.push(reason),
  });
  runtime.activate({
    adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });

  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.equal(runtime.snapshot().active, true);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(published.length, 0);
  assert.equal(sessionCount, 1);
  assert.ok(skipped.includes("drawing-frame-projection-session-stale"));
  assert.equal(frames.length, 1,
    "a silently stale provider session must enqueue its own retry");

  frames.shift()?.();
  assert.equal(sessionCount, 2);
  assert.equal(published.length, 1);
  assert.ok(runtime.snapshot().plan);
  runtime.dispose();
});

test("coordinate-key changes synchronously retire public geometry and stale the old worker plan", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const frameA = frame({ coordinateKey: "frame-a" });
  const frameB = frame({ coordinateKey: "frame-b" });
  const adapter = fakeAdapter(frameA);
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const projectedCoordinateKeys: string[] = [];
  let visiblePlan: ReturnType<typeof projectFreehand> | null = null;
  let visibleBitmapCloseCount = 0;
  let staleBitmapCloseCount = 0;
  let clearCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      projectedCoordinateKeys.push(request.frame.coordinateKey);
      return projectFreehand(request);
    },
    publishScene: (plan) => {
      published.push(plan);
      visiblePlan = plan;
      return true;
    },
    clearScene: () => {
      clearCount += 1;
      visiblePlan?.freehandRaster?.bitmap.close();
      visiblePlan = null;
    },
  });

  assert.equal(runtime.flushNow(), true);
  const firstRequest = transport.renderRequests()[0];
  assert.ok(firstRequest);
  transport.emit(bitmapWorkerResponse(firstRequest, () => { visibleBitmapCloseCount += 1; }));
  const firstPlan = runtime.snapshot().plan;
  const firstHitIndex = runtime.snapshot().hitIndex;
  assert.ok(firstPlan && firstHitIndex);
  assert.equal(hitTestDrawingHitIndex(firstHitIndex, 20, 20)?.entityId, "ink");
  assert.equal(firstPlan.entities[0]?.handleCount, 2);

  // Leave one frame-a worker result in flight, then swap coordinate systems.
  adapter.emit("viewport");
  assert.equal(runtime.flushNow(), true);
  const staleRequest = transport.renderRequests()[1];
  assert.ok(staleRequest);
  adapter.setFrame(frameB);
  adapter.emit("manual");

  // The invalidation listener must fail closed before the queued frame runs.
  const cleared = runtime.snapshot();
  assert.equal(clearCount, 1);
  assert.equal(visibleBitmapCloseCount, 1);
  assert.equal(visiblePlan, null);
  assert.equal(cleared.plan, null);
  assert.equal(cleared.hitIndex, null);
  assert.equal(cleared.publicationReady, false);
  assert.equal(cleared.hitIndex ? hitTestDrawingHitIndex(cleared.hitIndex, 20, 20) : null, null);

  transport.emit(bitmapWorkerResponse(staleRequest, () => { staleBitmapCloseCount += 1; }));
  assert.equal(staleBitmapCloseCount, 1, "the superseded worker bitmap is released");
  assert.equal(published.length, 1, "the old coordinate-space plan is never republished");
  assert.equal(runtime.snapshot().plan, null);

  assert.equal(runtime.flushNow(), true);
  const recoveredRequest = transport.renderRequests()[2];
  assert.ok(recoveredRequest);
  assert.deepEqual(recoveredRequest.header.stamp, staleRequest.header.stamp,
    "the coordinate epoch, not stamp drift, must reject the old worker plan");
  transport.emit(bitmapWorkerResponse(recoveredRequest, () => { visibleBitmapCloseCount += 1; }));
  const recovered = runtime.snapshot();
  assert.equal(published.length, 2);
  assert.strictEqual(recovered.plan, published[1]);
  assert.strictEqual(recovered.hitIndex?.list, recovered.plan);
  assert.equal(recovered.publicationReady, true);
  assert.equal(recovered.plan?.entities[0]?.handleCount, 2);
  assert.equal(recovered.hitIndex
    ? hitTestDrawingHitIndex(recovered.hitIndex, 20, 20)?.entityId
    : null, "ink");
  assert.deepEqual(projectedCoordinateKeys, ["frame-a", "frame-a", "frame-b"]);

  runtime.dispose();
  assert.equal(visibleBitmapCloseCount, 2);
});

test("worker frame-stale preflight is a stale result drop, not a stale publication", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  let closed = 0;
  const beforeCounters = drawingPerfCounters.snapshot().counters;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });
  assert.equal(runtime.flushNow(), true);
  const staleRequest = transport.renderRequests()[0];
  assert.ok(staleRequest);

  // Model a chart frame advancing before its invalidation callback reaches the
  // scene runtime. The response is still the client's latest job and has the
  // latest epoch/stamp, but it must fail the final frame-current preflight.
  adapter.clearFrame();
  transport.emit(bitmapWorkerResponse(staleRequest, () => { closed += 1; }));

  assert.equal(closed, 1);
  assert.equal(published.length, 0);
  assert.equal(runtime.snapshot().staleWorkerPublishCount, 0);
  const droppedCounters = drawingPerfCounters.snapshot().counters;
  assert.equal(
    droppedCounters.staleWorkerResultCount,
    beforeCounters.staleWorkerResultCount + 1,
  );
  assert.equal(
    droppedCounters.staleWorkerPublishCount,
    beforeCounters.staleWorkerPublishCount,
  );

  adapter.restoreFrame();
  assert.equal(runtime.flushNow(), true);
  const currentRequest = transport.renderRequests()[1];
  assert.ok(currentRequest);
  transport.emit(bitmapWorkerResponse(currentRequest, () => { closed += 1; }));
  assert.equal(published.length, 1);
  assert.deepEqual(
    runtime.snapshot().lastWorkerPublishedStamp,
    currentRequest.header.stamp,
  );
  published[0]?.freehandRaster?.bitmap.close();
  runtime.dispose();
  assert.equal(closed, 2);
});

test("worker finalize timing includes validation, raster attachment, and synchronous publication", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let timestamp = 10;
  const before = drawingPerfCounters.snapshot().durations.workerFinalizeMs.totalCount;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    now: () => timestamp,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: () => {
      timestamp += 7;
      return true;
    },
  });
  assert.equal(runtime.flushNow(), true);
  const request = transport.renderRequests()[0];
  assert.ok(request);
  timestamp = 60;
  transport.emit(bitmapWorkerResponse(request, () => {}));

  const finalize = drawingPerfCounters.snapshot().durations.workerFinalizeMs;
  assert.equal(finalize.totalCount, before + 1);
  assert.ok((finalize.maxMs ?? 0) >= 57,
    "worker finalize must end after synchronous publication, not at callback entry");
  runtime.snapshot().plan?.freehandRaster?.bitmap.close();
  runtime.dispose();
});

test("a rejected worker publication increments the observable stale-publish invariant", () => {
  const transports = [new RuntimeWorkerTransport(), new RuntimeWorkerTransport()];
  let transportIndex = 0;
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let closed = 0;
  const beforeCounters = drawingPerfCounters.snapshot().counters;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transports[transportIndex++]!,
    onError: () => {},
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: () => false,
  });
  assert.equal(runtime.flushNow(), true);
  const request = transports[0]!.renderRequests()[0];
  assert.ok(request);
  transports[0]!.emit(bitmapWorkerResponse(request, () => { closed += 1; }));

  assert.equal(closed, 1);
  assert.equal(runtime.snapshot().staleWorkerPublishCount, 1);
  assert.deepEqual(runtime.snapshot().acceptedWorkerIdentity, request.header);
  assert.equal(runtime.snapshot().publishedWorkerIdentity, null);
  const rejectedCounters = drawingPerfCounters.snapshot().counters;
  assert.equal(
    rejectedCounters.staleWorkerPublishCount,
    beforeCounters.staleWorkerPublishCount + 1,
  );
  assert.equal(
    rejectedCounters.staleWorkerResultCount,
    beforeCounters.staleWorkerResultCount,
  );

  assert.equal(runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: () => true,
  }), true);
  const recoveredBeforeSubmit = runtime.snapshot();
  assert.deepEqual(recoveredBeforeSubmit.submittedWorkerHeaders, []);
  assert.equal(recoveredBeforeSubmit.returnedWorkerIdentity, null);
  assert.equal(recoveredBeforeSubmit.acceptedWorkerIdentity, null);
  assert.equal(recoveredBeforeSubmit.publishedWorkerIdentity, null);
  assert.equal(recoveredBeforeSubmit.latestSubmittedWorkerIdentity, null);
  assert.equal(runtime.flushNow(), true);
  const recoveredRequest = transports[1]!.renderRequests()[0];
  assert.ok(recoveredRequest);
  assert.equal(recoveredRequest.header.jobId, 1);
  assert.deepEqual(runtime.snapshot().submittedWorkerHeaders, [recoveredRequest.header]);
  runtime.dispose();
});

test("bitmap capability fallback is sticky and avoids repeated worker round-trips", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let publicationCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: projectFreehand,
    publishScene: () => {
      publicationCount += 1;
      return true;
    },
  });
  assert.equal(runtime.flushNow(), true);
  const request = transport.renderRequests()[0];
  assert.ok(request);
  transport.emit({
    type: "drawing-worker/result",
    header: request.header,
    result: {
      kind: "typed-draw-result",
      ...request.viewport,
      byteLength: drawingWorkerViewportByteLength(request.viewport),
      rawPointCount: 2,
      renderedPointCount: request.viewport.points.length / 2,
      canonicalEntityCount: 1,
    },
  });
  assert.equal(publicationCount, 1);
  assert.equal(runtime.snapshot().rasterBackend, "main-thread");
  assert.equal(transport.terminated, true);

  adapter.emit("viewport");
  assert.equal(runtime.flushNow(), true);
  assert.equal(publicationCount, 2);
  assert.equal(transport.renderRequests().length, 1,
    "an unsupported raster worker is disabled for the remaining runtime mount");
  runtime.dispose();
});

test("bbox-sensitive composite operations stay on the exact main-thread scene path", () => {
  const transport = new RuntimeWorkerTransport();
  const store = createDrawingDocumentStore(freehandDocument());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const published: ReturnType<typeof projectFreehand>[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "worker",
    workerTransportFactory: () => transport,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => projectFreehand(request, "copy"),
    publishScene: (plan) => {
      published.push(plan);
      return true;
    },
  });
  assert.equal(runtime.flushNow(), true);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.freehandRaster, undefined);
  assert.equal(transport.renderRequests().length, 0);
  assert.equal(runtime.snapshot().rasterBackend, "main-thread");
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

test("data-space culling fails open for every pixel-painted kind without an affine price certificate", () => {
  const farLine = lineEntity("nonlinear-edge-line", 1_000, 1_100);
  const farShape = createDrawingEntity({
    id: "nonlinear-edge-shape",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: 1_000, price: 1_000 }, { time: 1_100, price: 1_100 }],
    },
    style: { kind: "shape", color: "#fff", lineWidth: 8 },
  });
  const document = createDrawingDocument({
    scopeKey: "nonlinear-price-cull",
    entities: [farLine, farShape],
    zOrder: [farLine.id, farShape.id],
  });
  const store = createDrawingDocumentStore(document);
  const captured = frame({ includeAffinePriceCertificate: false });
  const adapter = fakeAdapter(captured);
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
  assert.deepEqual(projectedNodeIds, [[farLine.id, farShape.id]]);
  runtime.dispose();
});

test("shadow treats an unresolved projection as skipped work and remains active", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const skipped: string[] = [];
  let errorCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "shadow",
    onError: () => { errorCount += 1; },
    onSkipped: (reason) => skipped.push(reason),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });

  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: () => null,
  });

  assert.equal(runtime.flushNow(), false);
  assert.deepEqual(skipped, ["scene-projection-unresolved"]);
  assert.equal(errorCount, 0);
  assert.equal(runtime.snapshot().active, true);
  assert.equal(adapter.listenerCount(), 1);
  assert.equal(runtime.invalidate("later-shadow-sample"), true);
  runtime.dispose();
});

test("scene-canary unresolved projection faults once without retrying invalidations", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const skipped: string[] = [];
  const errors: unknown[] = [];
  let scheduledFrames = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    onError: (error) => errors.push(error),
    onSkipped: (reason) => skipped.push(reason),
    requestFrame: () => {
      scheduledFrames += 1;
      return scheduledFrames;
    },
    cancelFrame: () => {},
  });

  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: () => null,
    publishScene: () => true,
  });

  assert.equal(runtime.flushNow(), false);
  assert.deepEqual(skipped, ["scene-projection-unresolved"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /projection was unresolved/);
  assert.equal(runtime.snapshot().active, false);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(adapter.listenerCount(), 0);
  assert.equal(runtime.invalidate("should-not-retry"), false);
  adapter.emit();
  assert.equal(scheduledFrames, 1);
  runtime.dispose();
});

test("scene-canary projection throw faults while retaining the last accepted plan", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const projectionError = new Error("projector failed");
  const errors: unknown[] = [];
  let rejectProjection = false;
  let scheduledFrames = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    onError: (error) => errors.push(error),
    requestFrame: () => {
      scheduledFrames += 1;
      return scheduledFrames;
    },
    cancelFrame: () => {},
  });

  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: (request) => {
      if (rejectProjection) throw projectionError;
      return project(request);
    },
    publishScene: () => true,
  });
  assert.equal(runtime.flushNow(), true);
  const acceptedPlan = runtime.snapshot().plan;
  assert.ok(acceptedPlan);

  rejectProjection = true;
  assert.equal(store.dispatch({ type: "clear" }).ok, true);
  renderer.setDocument(store.getSnapshot());
  assert.equal(runtime.flushNow(), false);

  assert.deepEqual(errors, [projectionError]);
  assert.strictEqual(runtime.snapshot().plan, acceptedPlan);
  assert.equal(runtime.snapshot().active, false);
  assert.equal(adapter.listenerCount(), 0);
  assert.equal(runtime.invalidate("should-not-retry"), false);
  adapter.emit();
  assert.equal(scheduledFrames, 2);
  runtime.dispose();
});

test("scene-canary recovery restores subscriptions and replaces the retained plan only after success", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  const projectionError = new Error("projector remains unavailable");
  let rejectProjection = false;
  const errors: unknown[] = [];
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    onError: (error) => errors.push(error),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  const recoverableProject = (request: DrawingSceneProjectionRequest) => {
    if (rejectProjection) throw projectionError;
    return project(request);
  };
  const binding = {
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: recoverableProject,
    publishScene: () => true,
  } as const;

  assert.equal(runtime.activate(binding), true);
  assert.equal(runtime.flushNow(), true);
  const acceptedPlan = runtime.snapshot().plan;
  assert.ok(acceptedPlan);
  assert.equal(runtime.snapshot().publicationReady, true);

  rejectProjection = true;
  assert.equal(store.dispatch({ type: "clear" }).ok, true);
  renderer.setDocument(store.getSnapshot());
  assert.equal(runtime.flushNow(), false);
  assert.strictEqual(runtime.snapshot().plan, acceptedPlan);
  assert.equal(runtime.snapshot().publicationReady, false);
  assert.equal(adapter.listenerCount(), 0);

  assert.equal(runtime.activate(binding), true);
  assert.equal(runtime.snapshot().publicationReady, false);
  assert.equal(adapter.listenerCount(), 1);
  assert.equal(runtime.flushNow(), false);
  assert.strictEqual(runtime.snapshot().plan, acceptedPlan);
  assert.equal(runtime.snapshot().publicationReady, false);
  assert.equal(adapter.listenerCount(), 0);

  rejectProjection = false;
  assert.equal(runtime.activate(binding), true);
  assert.equal(runtime.snapshot().publicationReady, false);
  assert.equal(adapter.listenerCount(), 1);
  assert.equal(runtime.flushNow(), true);
  assert.notStrictEqual(runtime.snapshot().plan, acceptedPlan);
  assert.equal(runtime.snapshot().publicationReady, true);
  assert.equal(runtime.snapshot().active, true);
  assert.equal(adapter.listenerCount(), 1);
  assert.deepEqual(errors, [projectionError, projectionError]);
  runtime.dispose();
});

test("scene-canary publication rejection faults once without scheduling a rebuild loop", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let scheduledFrames = 0;
  let errorCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => {
      scheduledFrames += 1;
      return scheduledFrames;
    },
    cancelFrame: () => {},
    onError: () => { errorCount += 1; },
  });

  assert.equal(runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => false,
  }), true);
  assert.equal(runtime.flushNow(), true);
  assert.equal(errorCount, 1);
  assert.equal(adapter.listenerCount(), 0);
  assert.equal(runtime.snapshot().active, false);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(runtime.invalidate("should-not-retry"), false);
  assert.equal(scheduledFrames, 1);
  runtime.dispose();
});

test("scene-canary retains the last accepted plan after a later publication failure", () => {
  const store = createDrawingDocumentStore(documentWithRevision());
  const adapter = fakeAdapter();
  const renderer = fakeRenderer(store.getSnapshot());
  let acceptPublication = true;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  runtime.activate({
    adapter: adapter.adapter,
    renderer: renderer.renderer,
    store,
    projectScene: project,
    publishScene: () => acceptPublication,
  });
  assert.equal(runtime.flushNow(), true);
  const acceptedPlan = runtime.snapshot().plan;
  assert.ok(acceptedPlan);

  acceptPublication = false;
  assert.equal(store.dispatch({ type: "clear" }).ok, true);
  renderer.setDocument(store.getSnapshot());
  assert.equal(runtime.flushNow(), true);
  assert.strictEqual(runtime.snapshot().plan, acceptedPlan);
  assert.equal(runtime.snapshot().active, false);
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
