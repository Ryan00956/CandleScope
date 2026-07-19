import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingFrameSnapshotFactory } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
  DrawingCoordinateResolution,
  SourceLineageSpanInput,
} from "../../../../chart-adapter/coordinateBridge.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type {
  DrawingDocument,
  DrawingEntity,
} from "../../core/drawingDocument.js";
import {
  hitTestDrawingScreenDisplayList,
} from "../../rendering/drawingDisplayList.js";
import type { DrawingScreenDisplayList } from "../../rendering/drawingDisplayList.js";
import type { DrawingRenderRevisionStamp } from "../drawingRenderScheduler.js";
import { createDrawingSceneRegistry } from "../drawingSceneRegistry.js";
import {
  clearDrawingSceneProjectorCaches,
  projectDrawingScene,
  projectDrawingSceneCanonicalGapIndexes,
  readDrawingSceneProjectorCacheSnapshot,
  retainBoundedDrawingScreenHierarchyMetadata,
  warmDrawingSceneWorldResolutions,
} from "../drawingSceneProjector.js";
import type {
  DrawingSceneProjectionAdapter,
  DrawingSceneTextMeasureRequest,
} from "../drawingSceneProjector.js";

interface AdapterOptions {
  readonly failBatch?: boolean;
  readonly gapPrice?: number;
  readonly gapTime?: number;
}

interface TestAdapter extends DrawingSceneProjectionAdapter {
  readonly batchInputs: Array<readonly CoordinateDataPoint[]>;
  readonly batchSizes: number[];
  readonly spanInputs: SourceLineageSpanInput[];
}

function createFrame({
  factory = createDrawingFrameSnapshotFactory(),
  width = 200,
  height = 200,
  barSpacing = 12,
  horizontalDomain = "time",
  minHorizontal = 0,
  maxHorizontal = width,
  minPrice = 0,
  maxPrice = height,
  minLogical,
  maxLogical,
  priceProjectionSamples,
  seriesData = [],
  viewportKey,
}: {
  factory?: ReturnType<typeof createDrawingFrameSnapshotFactory>;
  width?: number;
  height?: number;
  barSpacing?: number;
  horizontalDomain?: "logical" | "time";
  minHorizontal?: number;
  maxHorizontal?: number;
  minPrice?: number;
  maxPrice?: number;
  minLogical?: number;
  maxLogical?: number;
  priceProjectionSamples?: readonly Readonly<{ price: number; coordinateCssPx: number }>[];
  seriesData?: DrawingFrameSnapshot["seriesData"];
  viewportKey?: string;
} = {}): DrawingFrameSnapshot {
  return factory.capture({
    axisKind: horizontalDomain === "logical" ? "derived-ordinal" : "time",
    barSpacing,
    coordinateKey: "test:time",
    dpr: 1,
    drawingViewport: {
      horizontalDomain,
      minHorizontal,
      maxHorizontal,
      minPrice,
      maxPrice,
      ...(minLogical === undefined || maxLogical === undefined ? {} : {
        minLogical,
        maxLogical,
      }),
      ...(priceProjectionSamples ? { priceProjectionSamples } : {}),
    },
    heightCssPx: height,
    projectionKey: "test-projection",
    seriesData,
    surfaceToken: "surface",
    themeKey: "dark",
    viewportKey: viewportKey ?? `${horizontalDomain}:${minHorizontal}:${maxHorizontal}`,
    widthCssPx: width,
  });
}

function stampFor(document: DrawingDocument, frame: DrawingFrameSnapshot): DrawingRenderRevisionStamp {
  return Object.freeze({
    scopeKey: document.scopeKey,
    documentRevision: document.documentRevision,
    surfaceGeneration: frame.surfaceGeneration,
    dataRevision: frame.dataRevision,
    projectionRevision: frame.projectionRevision,
    lineageIndexRevision: frame.lineageIndexRevision,
    viewportRevision: frame.viewportRevision,
    themeRevision: frame.themeRevision,
    widthCssPx: frame.widthCssPx,
    heightCssPx: frame.heightCssPx,
    dpr: frame.dpr,
  });
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createAdapter(options: AdapterOptions = {}): TestAdapter {
  const batchInputs: Array<readonly CoordinateDataPoint[]> = [];
  const batchSizes: number[] = [];
  const spanInputs: SourceLineageSpanInput[] = [];
  return {
    batchInputs,
    batchSizes,
    spanInputs,
    measureText(request: DrawingSceneTextMeasureRequest) {
      return [...request.text].length * request.fontSize * 0.5;
    },
    projectDrawingFrameDataPoints(_frame, points: readonly CoordinateDataPoint[]) {
      batchInputs.push([...points]);
      batchSizes.push(points.length);
      if (options.failBatch) return null;
      const result = new Float64Array(points.length * 2);
      result.fill(Number.NaN);
      points.forEach((point, index) => {
        const x = numeric(point.logical) ?? numeric(point.time);
        const price = numeric(point.price);
        if (x !== null && x !== options.gapTime) result[index * 2] = x;
        if (price !== null && price !== options.gapPrice) result[index * 2 + 1] = price;
      });
      return result;
    },
    projectDrawingFrameSourceLineageSpan(_frame, span) {
      spanInputs.push(span);
      const left = numeric(span.exact?.left?.time);
      const right = numeric(span.exact?.right?.time);
      return left !== null && right !== null && left < right
        ? Object.freeze({ left, right })
        : null;
    },
  };
}

function registryNodes(document: DrawingDocument) {
  const registry = createDrawingSceneRegistry(document.scopeKey);
  const result = registry.reconcile(document);
  assert.equal(result.ok, true);
  return registry.getSnapshot().nodes;
}

function project(
  document: DrawingDocument,
  frame: DrawingFrameSnapshot,
  adapter: DrawingSceneProjectionAdapter,
  nodes = registryNodes(document),
  selectedId: string | null = null,
  lodToleranceClass: "selectedEdit" | "normalStatic" | "continuousViewport" | "settledExact"
    = "normalStatic",
): DrawingScreenDisplayList | null {
  return projectDrawingScene({
    adapter,
    document,
    frame,
    nodes,
    selectedId,
    stamp: stampFor(document, frame),
    lodToleranceClass,
  });
}

function entityPoints(list: DrawingScreenDisplayList, id: string): number[] {
  const entity = list.entities.find((candidate) => candidate.id === id);
  assert.ok(entity);
  const start = entity.pointOffset * 2;
  return Array.from(list.points.slice(start, start + entity.pointCount * 2));
}

function maximumPointToPolylineError(
  sourcePoints: readonly Readonly<{ x: number; y: number }>[],
  polyline: readonly number[],
): number {
  let maximum = 0;
  for (const point of sourcePoints) {
    let minimumSquared = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset + 3 < polyline.length; offset += 2) {
      const ax = polyline[offset];
      const ay = polyline[offset + 1];
      const bx = polyline[offset + 2];
      const by = polyline[offset + 3];
      if (![ax, ay, bx, by].every((value) => Number.isFinite(value))) continue;
      const dx = Number(bx) - Number(ax);
      const dy = Number(by) - Number(ay);
      const lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared <= 0
        ? 0
        : Math.max(0, Math.min(1, (
            (point.x - Number(ax)) * dx + (point.y - Number(ay)) * dy
          ) / lengthSquared));
      const nearestX = Number(ax) + ratio * dx;
      const nearestY = Number(ay) + ratio * dy;
      const errorX = point.x - nearestX;
      const errorY = point.y - nearestY;
      minimumSquared = Math.min(minimumSquared, errorX * errorX + errorY * errorY);
    }
    maximum = Math.max(maximum, Math.sqrt(minimumSquared));
  }
  return maximum;
}

function splitFinitePolylinePaths(polyline: readonly number[]): readonly number[][] {
  const paths: number[][] = [];
  let path: number[] = [];
  for (let offset = 0; offset < polyline.length; offset += 2) {
    const x = polyline[offset];
    const y = polyline[offset + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (path.length > 0) paths.push(path);
      path = [];
      continue;
    }
    path.push(Number(x), Number(y));
  }
  if (path.length > 0) paths.push(path);
  return paths;
}

function allKindEntities(): DrawingEntity[] {
  const span = {
    exact: {
      left: { time: 20, sourceOrdinal: 0 },
      right: { time: 40, sourceOrdinal: 0 },
    },
    fallback: { fromTime: 20, toTime: 40, leftRatio: 0, rightRatio: 1 },
  };
  return [
    createDrawingEntity({
      id: "line",
      kind: "line",
      geometry: { kind: "line", lineType: "line-segment", dataPoints: [
        { time: 10, price: 10 }, { time: 40, price: 40 },
      ] },
      style: { kind: "line", color: "#fff", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "axis",
      kind: "axis-line",
      geometry: { kind: "axis-line", axisLineType: "horizontal", dataPoint: { time: 25, price: 50 } },
      style: { kind: "axis-line", color: "#fff", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "angle",
      kind: "angle-measure",
      geometry: { kind: "angle-measure", dataPoints: [
        { time: 20, price: 30 }, { time: 60, price: 60 },
      ] },
      style: { kind: "angle-measure", color: "#fff", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "text",
      kind: "text",
      geometry: { kind: "text", dataPoint: { time: 30, price: 30 } },
      style: { kind: "text", text: "scene", fontSize: 12, padding: 4 },
    }),
    createDrawingEntity({
      id: "fib",
      kind: "fibonacci",
      geometry: { kind: "fibonacci", dataPoints: [
        { time: 30, price: 30 }, { time: 80, price: 80 },
      ] },
      style: { kind: "fibonacci", color: "#0af", lineWidth: 1 },
    }),
    createDrawingEntity({
      id: "position",
      kind: "position",
      geometry: {
        kind: "position",
        direction: "long",
        entryPrice: 60,
        tpPrice: 80,
        slPrice: 40,
        timeRange: { start: { time: 40 }, end: { time: 80 } },
      },
      style: { kind: "position", positionSize: 1_000, infoPanelOffset: { x: 0, y: 0 } },
    }),
    createDrawingEntity({
      id: "shape",
      kind: "shape",
      geometry: { kind: "shape", shapeType: "ellipse", dataPoints: [
        { time: 50, price: 50 }, { time: 100, price: 100 },
      ] },
      style: { kind: "shape", color: "#f90", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "freehand",
      kind: "freehand",
      geometry: { kind: "freehand", dataPoints: [
        { time: 15, price: 25 }, { time: 20, price: 30 }, { time: 25, price: 35 },
      ] },
      style: { kind: "freehand", color: "#fff", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "highlighter",
      kind: "highlighter",
      geometry: {
        kind: "highlighter",
        stroke: {
          version: 2,
          sourceProjection: "renko",
          sourceProjectionConfig: "dataset:renko",
          spans: [span],
          points: [
            { span: 0, ratio: 0, price: 20 },
            { span: 0, ratio: 1, price: 30 },
          ],
        },
      },
      style: { kind: "highlighter", color: "#ff0", lineWidth: 8, opacity: 0.3 },
    }),
  ];
}

test("projects all nine kinds in canonical document z-order with typed geometry", () => {
  const entities = allKindEntities();
  for (const entity of entities) {
    const single = createDrawingDocument({ scopeKey: `single-${entity.id}`, entities: [entity] });
    assert.ok(project(single, createFrame(), createAdapter()), `single ${entity.id} projection`);
  }
  const order = ["shape", "line", "position", "axis", "text", "angle", "fib", "freehand", "highlighter"];
  const document = createDrawingDocument({
    scopeKey: "all-kinds",
    documentRevision: 7,
    entities,
    zOrder: order,
  });
  const frame = createFrame();
  const adapter = createAdapter();
  const nodes = [...registryNodes(document)].reverse();
  const list = project(document, frame, adapter, nodes, "shape");
  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), order);
  assert.deepEqual(list.entities.map((entity) => entity.kind), [
    "shape", "line", "position", "axis-line", "text", "angle-measure", "fibonacci", "freehand", "highlighter",
  ]);
  assert.equal(list.points instanceof Float64Array, true);
  assert.equal(list.entities.every((entity, index) => Number.isFinite(list.bboxes[index * 4])), true);
  assert.deepEqual(list.entities.map((entity) => entity.handleCount), [8, 2, 5, 1, 8, 2, 2, 0, 0]);
  assert.equal(adapter.spanInputs.length, 1);
  assert.equal(list.entities.find((entity) => entity.id === "axis")?.unboundedAxis, "horizontal");
  assert.deepEqual(list.entities.map((entity) => entity.renderSpec?.op ?? null), [
    "shape", "line", "position", "axis-line", "text", "angle", "fibonacci", "freehand", "freehand",
  ]);
  assert.equal(list.entities.find((entity) => entity.id === "shape")?.renderSpec?.selected, true);
  assert.equal(list.entities.find((entity) => entity.id === "line")?.renderSpec?.selected, false);
  assert.deepEqual(list.entities.find((entity) => entity.id === "freehand")?.renderSpec, {
    op: "freehand",
    strokeColor: "#fff",
    selectionHighlightColor: "#ff6b6b",
    lineWidthCssPx: 2,
    opacity: 1,
    compositeOperation: "source-over",
    brushShape: "round",
    pathInterpolation: "quadratic",
    selected: false,
  });
  assert.deepEqual(list.entities.find((entity) => entity.id === "highlighter")?.renderSpec, {
    op: "freehand",
    strokeColor: "#ff0",
    selectionHighlightColor: "#ff6b6b",
    lineWidthCssPx: 8,
    opacity: 0.3,
    compositeOperation: "multiply",
    brushShape: "square",
    pathInterpolation: "quadratic",
    selected: false,
  });
});

test("batches ordinary line and shape anchors once in canonical source-slot order", () => {
  const line = createDrawingEntity({
    id: "batched-line",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const shape = createDrawingEntity({
    id: "batched-shape",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: 30, price: 40 }, { time: 50, price: 60 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "ordinary-two-point-batch",
    entities: [line, shape],
    zOrder: [shape.id, line.id],
  });
  const adapter = createAdapter();
  const list = project(document, createFrame({ width: 100, height: 100 }), adapter);

  assert.ok(list);
  assert.deepEqual(adapter.batchSizes, [4]);
  assert.deepEqual(adapter.batchInputs[0]?.map((point) => [point.time, point.price]), [
    [30, 40], [50, 60], [10, 10], [20, 20],
  ]);
  assert.deepEqual(list.entities.map((entity) => entity.id), [shape.id, line.id]);
  assert.deepEqual([...list.bboxes], [30, 40, 50, 60, 10, 10, 20, 20]);
});

test("viewport-only updates reuse cached source anchors for every static entity kind", () => {
  const entities = allKindEntities().filter(
    (entity) => entity.kind !== "freehand" && entity.kind !== "highlighter",
  );
  const document = createDrawingDocument({
    scopeKey: "static-world-cache",
    entities,
  });
  const base = createAdapter();
  let resolveCalls = 0;
  let finalProjectionCalls = 0;
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    resolveDrawingFrameDataPoints(_frame, points) {
      resolveCalls += 1;
      return Object.freeze(points.map((point): DrawingCoordinateResolution | null => {
        const logical = numeric(point.logical) ?? numeric(point.time);
        return logical === null
          ? null
          : Object.freeze({ kind: "logical" as const, logical });
      }));
    },
    projectDrawingFrameResolvedDataPoints(frame, resolutions, points) {
      finalProjectionCalls += 1;
      const viewport = frame.drawingViewport;
      if (!viewport) return null;
      const result = new Float64Array(points.length * 2);
      result.fill(Number.NaN);
      points.forEach((point, index) => {
        const resolution = resolutions[index];
        if (resolution?.kind === "logical") {
          result[index * 2] = resolution.logical - viewport.minHorizontal;
        }
        const price = numeric(point.price);
        if (price !== null) result[index * 2 + 1] = price;
      });
      return result;
    },
  };
  const factory = createDrawingFrameSnapshotFactory();
  const seriesData: DrawingFrameSnapshot["seriesData"] = [];
  const firstFrame = createFrame({
    factory,
    minHorizontal: 0,
    maxHorizontal: 200,
    seriesData,
    viewportKey: "static-a",
  });
  const secondFrame = createFrame({
    factory,
    minHorizontal: 5,
    maxHorizontal: 205,
    seriesData,
    viewportKey: "static-b",
  });

  const first = project(document, firstFrame, adapter);
  assert.ok(first);
  assert.equal(first.entities.length, entities.length);
  const resolvedAfterFirstFrame = resolveCalls;
  const finalProjectionCallsAfterFirstFrame = finalProjectionCalls;
  const second = project(document, secondFrame, adapter);

  assert.ok(second);
  assert.equal(resolveCalls - resolvedAfterFirstFrame, 0,
    "viewport-only frames must perform zero new source-anchor resolutions");
  assert.ok(finalProjectionCalls > finalProjectionCallsAfterFirstFrame,
    "every viewport still performs final public projection from cached resolutions");
  assert.notDeepEqual(entityPoints(first, "line"), entityPoints(second, "line"));

  const resolvesBeforeWorldChange = resolveCalls;
  const changedWorldFrame = createFrame({
    factory,
    minHorizontal: 5,
    maxHorizontal: 205,
    seriesData: [],
    viewportKey: "static-b",
  });
  assert.ok(project(document, changedWorldFrame, adapter));
  assert.ok(resolveCalls > resolvesBeforeWorldChange,
    "a new frame.worldRevisionKey must invalidate cached source resolutions");
});

test("exposes fail-closed read-only evidence for the adapter-scoped projection cache", () => {
  const base = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    resolveDrawingFrameDataPoints(_frame, points) {
      return Object.freeze(points.map((point): DrawingCoordinateResolution | null => {
        const logical = numeric(point.logical) ?? numeric(point.time);
        return logical === null
          ? null
          : Object.freeze({ kind: "logical" as const, logical });
      }));
    },
    projectDrawingFrameResolvedDataPoints(_frame, resolutions, points) {
      const result = new Float64Array(points.length * 2);
      result.fill(Number.NaN);
      points.forEach((point, index) => {
        const resolution = resolutions[index];
        if (resolution?.kind === "logical") result[index * 2] = resolution.logical;
        const price = numeric(point.price);
        if (price !== null) result[index * 2 + 1] = price;
      });
      return result;
    },
  };
  const entity = createDrawingEntity({
    id: "cache-evidence-line",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "cache-evidence",
    entities: [entity],
  });

  assert.equal(readDrawingSceneProjectorCacheSnapshot(adapter), null);
  assert.ok(project(document, createFrame(), adapter));

  const snapshot = readDrawingSceneProjectorCacheSnapshot(adapter);
  assert.ok(snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.ok(snapshot.totalBytes > 0);
  assert.ok(snapshot.entryCount > 0);
  assert.ok(snapshot.totalBytes <= snapshot.budgetBytes);
  assert.ok(snapshot.budgetBytes <= snapshot.hardLimitBytes);
  assert.ok(snapshot.recentRequestLimit > 0);
  assert.equal(snapshot.recentRequestLimit, 512);
  assert.ok(snapshot.recentRequestCount >= 0);
  assert.ok(snapshot.recentHierarchyKeyCount >= 0);
  assert.equal(snapshot.recentHierarchyKeysPerRequestLimit, 3);
  assert.ok(snapshot.recentRequestCount <= snapshot.recentRequestLimit);

  clearDrawingSceneProjectorCaches(adapter);
  assert.equal(readDrawingSceneProjectorCacheSnapshot(adapter), null);
});

test("bounds recent screen-hierarchy request metadata alongside the byte LRU", () => {
  const recentByRequest = new Map<number, string[]>();
  const evicted: string[] = [];
  const retain = (requestId: number, hierarchyKey: string) => {
    retainBoundedDrawingScreenHierarchyMetadata(recentByRequest, requestId, hierarchyKey, {
      onEvict: (key) => evicted.push(key),
      perRequestLimit: 2,
      requestLimit: 3,
    });
  };

  retain(1, "1a");
  retain(1, "1b");
  retain(1, "1c");
  assert.deepEqual(recentByRequest.get(1), ["1b", "1c"]);
  assert.deepEqual(evicted, ["1a"]);

  retain(2, "2a");
  retain(3, "3a");
  retain(2, "2b");
  retain(4, "4a");
  assert.equal(recentByRequest.size, 3);
  assert.equal(recentByRequest.has(1), false);
  assert.deepEqual([...recentByRequest.keys()], [3, 2, 4]);
  assert.deepEqual(evicted, ["1a", "1b", "1c"]);

  const supportedScene = new Map<number, string[]>();
  const supportedSceneEvictions: string[] = [];
  for (let requestId = 1; requestId <= 512; requestId += 1) {
    retainBoundedDrawingScreenHierarchyMetadata(
      supportedScene,
      requestId,
      `hierarchy-${requestId}`,
      {
        onEvict: (key) => supportedSceneEvictions.push(key),
        perRequestLimit: 3,
        requestLimit: 512,
      },
    );
  }
  for (let requestId = 1; requestId <= 512; requestId += 1) {
    retainBoundedDrawingScreenHierarchyMetadata(
      supportedScene,
      requestId,
      `hierarchy-${requestId}`,
      {
        onEvict: (key) => supportedSceneEvictions.push(key),
        perRequestLimit: 3,
        requestLimit: 512,
      },
    );
  }
  assert.equal(supportedScene.size, 512);
  assert.deepEqual(supportedSceneEvictions, []);
});

test("scene world warmup keeps changing cull subsets source-resolution free", () => {
  const first = createDrawingEntity({
    id: "warm-line-a",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const second = createDrawingEntity({
    id: "warm-shape-b",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: 110, price: 30 }, { time: 130, price: 50 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "world-warm-cull-subsets",
    entities: [first, second],
  });
  const nodes = registryNodes(document);
  const base = createAdapter();
  let resolvedPoints = 0;
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    resolveDrawingFrameDataPoints(_frame, points) {
      resolvedPoints += points.length;
      return Object.freeze(points.map((point) => Object.freeze({
        kind: "logical" as const,
        logical: Number(point.time ?? point.logical),
      })));
    },
    projectDrawingFrameResolvedDataPoints(frame, resolutions, points) {
      const result = new Float64Array(points.length * 2);
      points.forEach((point, index) => {
        const resolution = resolutions[index];
        result[index * 2] = resolution?.kind === "logical"
          ? resolution.logical - Number(frame.drawingViewport?.minHorizontal ?? 0)
          : Number.NaN;
        result[index * 2 + 1] = Number(point.price);
      });
      return result;
    },
  };
  const factory = createDrawingFrameSnapshotFactory();
  const seriesData: DrawingFrameSnapshot["seriesData"] = [];
  const frameA = createFrame({
    factory,
    minHorizontal: 0,
    maxHorizontal: 100,
    seriesData,
  });
  const frameB = createFrame({
    factory,
    minHorizontal: 100,
    maxHorizontal: 200,
    seriesData,
  });
  assert.equal(warmDrawingSceneWorldResolutions({ adapter, document, frame: frameA, nodes }), true);
  assert.equal(resolvedPoints, 4);
  assert.ok(project(document, frameA, adapter, [nodes[0]!], null, "continuousViewport"));
  const beforeSubsetChange = resolvedPoints;
  assert.ok(project(document, frameB, adapter, [nodes[1]!], null, "continuousViewport"));
  assert.equal(resolvedPoints, beforeSubsetChange,
    "a viewport-only cull subset change must reuse the complete world warmup");

  const changedWorldFrame = createFrame({
    factory,
    minHorizontal: 100,
    maxHorizontal: 200,
    seriesData: [],
    viewportKey: "world-change",
  });
  assert.equal(warmDrawingSceneWorldResolutions({
    adapter,
    document,
    frame: changedWorldFrame,
    nodes,
  }), true);
  assert.ok(resolvedPoints > beforeSubsetChange,
    "a changed world revision must resolve the canonical anchors again");
});

test("ordinary two-point batch failures reject the whole scene atomically", () => {
  const line = createDrawingEntity({
    id: "atomic-line",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const shape = createDrawingEntity({
    id: "atomic-shape",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: 30, price: 30 }, { time: 40, price: 40 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "ordinary-two-point-atomic",
    entities: [line, shape],
  });
  const adapter = createAdapter({ failBatch: true });

  assert.equal(project(document, createFrame(), adapter), null);
  assert.deepEqual(adapter.batchSizes, [4]);
});

test("an unresolved ordinary pair stays local without shifting later batch slots", () => {
  const unresolvedLine = createDrawingEntity({
    id: "unresolved-line",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 10, price: 13 }, { time: 20, price: 20 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const visibleShape = createDrawingEntity({
    id: "visible-shape",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: 30, price: 30 }, { time: 40, price: 40 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "ordinary-two-point-unresolved",
    entities: [unresolvedLine, visibleShape],
  });
  const adapter = createAdapter({ gapPrice: 13 });
  const list = project(document, createFrame(), adapter);

  assert.ok(list);
  assert.deepEqual(adapter.batchSizes, [4]);
  assert.deepEqual(list.entities.map((entity) => entity.id), [visibleShape.id]);
  assert.deepEqual([...list.bboxes], [30, 30, 40, 40]);
});

test("clips ray/infinite/axis geometry to viewport edges and marks it explicitly unbounded", () => {
  const entities = [
    createDrawingEntity({
      id: "ray", kind: "line",
      geometry: { kind: "line", lineType: "line-ray", dataPoints: [
        { time: 50, price: 50 }, { time: 60, price: 50 },
      ] },
      style: { kind: "line", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "infinite", kind: "line",
      geometry: { kind: "line", lineType: "line-infinite", dataPoints: [
        { time: 50, price: 50 }, { time: 60, price: 60 },
      ] },
      style: { kind: "line", lineWidth: 2 },
    }),
    createDrawingEntity({
      id: "cross", kind: "axis-line",
      geometry: { kind: "axis-line", axisLineType: "cross", dataPoint: { time: 40, price: 30 } },
      style: { kind: "axis-line", lineWidth: 2 },
    }),
  ];
  const document = createDrawingDocument({ scopeKey: "edges", entities });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());
  assert.ok(list);
  assert.deepEqual(entityPoints(list, "ray").slice(0, 4), [50, 50, 100, 50]);
  assert.deepEqual(entityPoints(list, "infinite").slice(0, 4), [0, 0, 100, 100]);
  assert.deepEqual(entityPoints(list, "cross"), [0, 30, 100, 30, 40, 0, 40, 100]);
  assert.deepEqual(list.entities.map((entity) => entity.unboundedAxis), ["both", "both", "both"]);
});

test("line-segment bboxes use parametric viewport clipping without false visibility", () => {
  const crossing = createDrawingEntity({
    id: "crossing",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: -10, price: 20 }, { time: 20, price: 50 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const outside = createDrawingEntity({
    id: "outside",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: -10, price: 5 }, { time: 5, price: -10 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "segment-clipping",
    entities: [crossing, outside],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), ["crossing"]);
  assert.deepEqual([...list.bboxes], [0, 30, 20, 50]);
  assert.deepEqual([...list.handles], [-10, 20, 20, 50]);
});

test("paint extents retain thick edge strokes but still cull geometry beyond its pixels", () => {
  const thickEdge = createDrawingEntity({
    id: "thick-edge",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 20, price: -2 }, { time: 80, price: -2 }],
    },
    style: { kind: "line", lineWidth: 8 },
  });
  const thinOutside = createDrawingEntity({
    id: "thin-outside",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 20, price: -4 }, { time: 80, price: -4 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "paint-edge-strokes",
    entities: [thickEdge, thinOutside],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [thickEdge.id]);
  assert.ok(Number(list.bboxes[1]) >= 0);
  assert.ok(Number(list.bboxes[3]) > 0);
});

test("selected endpoint paint can enter the pane even when the selected path does not", () => {
  const selectedLine = createDrawingEntity({
    id: "selected-endpoint",
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: -40, price: 50 }, { time: -10, price: 50 }],
    },
    style: { kind: "line", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "selected-endpoint-edge",
    entities: [selectedLine],
  });
  const list = project(
    document,
    createFrame({ width: 100, height: 100 }),
    createAdapter(),
    undefined,
    selectedLine.id,
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [selectedLine.id]);
  assert.ok(Number(list.bboxes[2]) > 0);
});

test("selected shape handles retain edge-only paint while ordinary outside shapes cull", () => {
  const selectedShape = createDrawingEntity({
    id: "selected-shape-edge",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: -40, price: 20 }, { time: -2, price: 80 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const ordinaryShape = createDrawingEntity({
    id: "ordinary-shape-outside",
    kind: "shape",
    geometry: {
      kind: "shape",
      shapeType: "rectangle",
      dataPoints: [{ time: -40, price: 20 }, { time: -2, price: 80 }],
    },
    style: { kind: "shape", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "selected-shape-edge",
    entities: [selectedShape, ordinaryShape],
  });
  const list = project(
    document,
    createFrame({ width: 100, height: 100 }),
    createAdapter(),
    undefined,
    selectedShape.id,
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [selectedShape.id]);
  assert.ok(Number(list.bboxes[2]) > 0);
});

test("fibonacci level labels retain edge paint while fully offscreen labels cull", () => {
  const edge = createDrawingEntity({
    id: "fibonacci-label-edge",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: -10, price: 30 }, { time: -1, price: 70 }],
      inverted: false,
    },
    style: {
      kind: "fibonacci",
      lineWidth: 2,
      levels: [{ level: 0.5, color: "#0af", enabled: true }],
    },
  });
  const far = createDrawingEntity({
    id: "fibonacci-label-far",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: -200, price: 30 }, { time: -180, price: 70 }],
      inverted: false,
    },
    style: {
      kind: "fibonacci",
      lineWidth: 2,
      levels: [{ level: 0.5, color: "#0af", enabled: true }],
    },
  });
  const document = createDrawingDocument({
    scopeKey: "fibonacci-label-culling",
    entities: [edge, far],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [edge.id]);
  assert.equal(Number(list.bboxes[0]), 0);
  assert.ok(Number(list.bboxes[2]) > 0);
});

test("position direction and price badges participate in edge culling", () => {
  const directionEdge = createDrawingEntity({
    id: "position-direction-edge",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: null,
      slPrice: null,
      timeRange: { start: { time: -40 }, end: { time: -30 } },
    },
    style: { kind: "position", infoPanelOffset: { x: 0, y: 0 } },
  });
  const directionFar = createDrawingEntity({
    id: "position-direction-far",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: null,
      slPrice: null,
      timeRange: { start: { time: -240 }, end: { time: -230 } },
    },
    style: { kind: "position", infoPanelOffset: { x: 0, y: 0 } },
  });
  const priceEdge = createDrawingEntity({
    id: "position-price-edge",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: 70,
      slPrice: null,
      timeRange: { start: { time: -100 }, end: { time: -12 } },
    },
    style: { kind: "position", infoPanelOffset: { x: 0, y: 0 } },
  });
  const priceFar = createDrawingEntity({
    id: "position-price-far",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: 70,
      slPrice: null,
      timeRange: { start: { time: -250 }, end: { time: -150 } },
    },
    style: { kind: "position", infoPanelOffset: { x: 0, y: 0 } },
  });
  const document = createDrawingDocument({
    scopeKey: "position-badge-culling",
    entities: [directionEdge, directionFar, priceEdge, priceFar],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [directionEdge.id, priceEdge.id]);
});

test("new scene selection handles retain edge-only paint for angle, fibonacci, and text", () => {
  const angle = createDrawingEntity({
    id: "selected-angle-edge",
    kind: "angle-measure",
    geometry: {
      kind: "angle-measure",
      dataPoints: [{ time: -9, price: 50 }, { time: -20, price: 50 }],
    },
    style: { kind: "angle-measure", lineWidth: 2 },
  });
  const fibonacci = createDrawingEntity({
    id: "selected-fibonacci-edge",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: -20, price: 40 }, { time: -9, price: 60 }],
      inverted: false,
    },
    style: { kind: "fibonacci", lineWidth: 2, levels: [] },
  });
  const text = createDrawingEntity({
    id: "selected-text-edge",
    kind: "text",
    geometry: { kind: "text", dataPoint: { time: -8, price: 50 } },
    style: {
      kind: "text",
      text: "x",
      fontSize: 10,
      widthPx: 4,
      padding: 0,
      borderColor: null,
      borderWidth: 0,
    },
  });
  const document = createDrawingDocument({
    scopeKey: "new-scene-selection-edge",
    entities: [angle, fibonacci, text],
  });
  const frame = createFrame({ width: 100, height: 100 });
  const nodes = registryNodes(document);

  for (const selected of [angle, fibonacci, text]) {
    const list = project(document, frame, createAdapter(), nodes, selected.id);
    assert.ok(list);
    assert.deepEqual(list.entities.map((entity) => entity.id), [selected.id]);
    assert.ok(Number(list.bboxes[2]) > 0);
  }
});

test("selected angle and fibonacci halos retain imported 100px edge paint without keeping offscreen paint", () => {
  const angleEdge = createDrawingEntity({
    id: "selected-angle-wide-edge",
    kind: "angle-measure",
    geometry: {
      kind: "angle-measure",
      dataPoints: [{ time: 20, price: -54 }, { time: 80, price: -94 }],
    },
    style: { kind: "angle-measure", lineWidth: 100 },
  });
  const angleFar = createDrawingEntity({
    id: "selected-angle-wide-far",
    kind: "angle-measure",
    geometry: {
      kind: "angle-measure",
      dataPoints: [{ time: 20, price: -56 }, { time: 80, price: -96 }],
    },
    style: { kind: "angle-measure", lineWidth: 100 },
  });
  const fibonacciEdge = createDrawingEntity({
    id: "selected-fibonacci-wide-edge",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: 20, price: -55 }, { time: 80, price: -95 }],
      inverted: false,
    },
    style: { kind: "fibonacci", lineWidth: 100, levels: [] },
  });
  const fibonacciFar = createDrawingEntity({
    id: "selected-fibonacci-wide-far",
    kind: "fibonacci",
    geometry: {
      kind: "fibonacci",
      dataPoints: [{ time: 20, price: -57 }, { time: 80, price: -97 }],
      inverted: false,
    },
    style: { kind: "fibonacci", lineWidth: 100, levels: [] },
  });
  const frame = createFrame({ width: 100, height: 100 });

  for (const [scopeKey, edge, far] of [
    ["selected-angle-wide-culling", angleEdge, angleFar],
    ["selected-fibonacci-wide-culling", fibonacciEdge, fibonacciFar],
  ] as const) {
    const edgeDocument = createDrawingDocument({ scopeKey: `${scopeKey}:edge`, entities: [edge] });
    const edgeList = project(
      edgeDocument,
      frame,
      createAdapter(),
      undefined,
      edge.id,
    );
    assert.ok(edgeList);
    assert.deepEqual(edgeList.entities.map((entity) => entity.id), [edge.id]);
    assert.equal(edgeList.entities[0]?.renderSpec?.lineWidthCssPx, 100);
    assert.equal(Number(edgeList.bboxes[1]), 0);
    assert.ok(Number(edgeList.bboxes[3]) > 0, `${edge.id} halo must enter the pane`);

    const farDocument = createDrawingDocument({ scopeKey: `${scopeKey}:far`, entities: [far] });
    const farList = project(
      farDocument,
      frame,
      createAdapter(),
      undefined,
      far.id,
    );
    assert.ok(farList);
    assert.deepEqual(farList.entities, []);
  }
});

test("position panel shadow retains edge paint without keeping a farther panel", () => {
  const shadowEdge = createDrawingEntity({
    id: "position-panel-shadow-edge",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: null,
      slPrice: null,
      timeRange: { start: { time: 200 }, end: { time: 224 } },
    },
    style: { kind: "position", infoPanelOffset: { x: -35, y: 0 } },
  });
  const shadowFar = createDrawingEntity({
    id: "position-panel-shadow-far",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 50,
      tpPrice: null,
      slPrice: null,
      timeRange: { start: { time: 200 }, end: { time: 224 } },
    },
    style: { kind: "position", infoPanelOffset: { x: -30, y: 0 } },
  });
  const document = createDrawingDocument({
    scopeKey: "position-panel-shadow-culling",
    entities: [shadowEdge, shadowFar],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [shadowEdge.id]);
  assert.ok(Number(list.bboxes[0]) < 100);
  assert.equal(Number(list.bboxes[2]), 100);
});

test("axis lines preserve independently resolvable horizontal and vertical coordinates", () => {
  const horizontal = createDrawingEntity({
    id: "horizontal-only",
    kind: "axis-line",
    geometry: {
      kind: "axis-line",
      axisLineType: "horizontal",
      dataPoint: { time: 999, price: 30 },
    },
    style: { kind: "axis-line", lineWidth: 2 },
  });
  const vertical = createDrawingEntity({
    id: "vertical-only",
    kind: "axis-line",
    geometry: {
      kind: "axis-line",
      axisLineType: "vertical",
      dataPoint: { time: 25, price: 50 },
    },
    style: { kind: "axis-line", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "partial-axis",
    entities: [horizontal, vertical],
  });
  const list = project(
    document,
    createFrame({ width: 100, height: 100 }),
    createAdapter({ gapPrice: 50, gapTime: 999 }),
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), ["horizontal-only", "vertical-only"]);
  assert.deepEqual([...list.bboxes], [0, 30, 100, 30, 25, 0, 25, 100]);
  assert.deepEqual(list.entities.map((entity) => entity.handleCount), [0, 0]);
});

test("cross axis-line hits choose the nearest axis and keep the selected center first", () => {
  const cross = createDrawingEntity({
    id: "nearest-cross",
    kind: "axis-line",
    geometry: {
      kind: "axis-line",
      axisLineType: "cross",
      dataPoint: { time: 40, price: 30 },
    },
    style: { kind: "axis-line", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "nearest-cross", entities: [cross] });
  const frame = createFrame({ width: 100, height: 100 });
  const list = project(document, frame, createAdapter());
  assert.ok(list);

  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 41, 38), {
    entityId: cross.id,
    kind: "axis-line",
    pointIndex: -1,
    zone: "vertical",
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 48, 31), {
    entityId: cross.id,
    kind: "axis-line",
    pointIndex: -1,
    zone: "horizontal",
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 45, 35), {
    entityId: cross.id,
    kind: "axis-line",
    pointIndex: -1,
    zone: "horizontal",
  });

  const selectedList = project(document, frame, createAdapter(), undefined, cross.id);
  assert.ok(selectedList);
  assert.deepEqual(hitTestDrawingScreenDisplayList(selectedList, 42, 32, cross.id), {
    entityId: cross.id,
    kind: "axis-line",
    pointIndex: 0,
    zone: "center",
  });
});

test("preserves exact v2/v3 unresolved points as NaN pairs and path breaks", () => {
  const span = {
    exact: {
      left: { time: 20, sourceOrdinal: 0 },
      right: { time: 40, sourceOrdinal: 0 },
    },
    fallback: { fromTime: 20, toTime: 40, leftRatio: 0, rightRatio: 1 },
  };
  const v2 = createDrawingEntity({
    id: "v2", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [span],
      points: [
        { span: 0, ratio: 0, price: 10 },
        { span: 0, ratio: 0.25, price: 11 },
        { span: 0, ratio: 0.5, price: 13 },
        { span: 0, ratio: 0.75, price: 19 },
        { span: 0, ratio: 1, price: 20 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const v3 = createDrawingEntity({
    id: "v3", kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [span],
      points: [
        { span: 0, ratio: 0, price: 10 },
        { time: 30, price: 11 },
        { time: 50, price: 13 },
        { anchor: { time: 60, sourceOrdinal: 0 }, price: 19 },
        { time: 70, price: 20 },
      ],
    } },
    style: { kind: "highlighter", lineWidth: 6 },
  });
  const document = createDrawingDocument({ scopeKey: "gaps", entities: [v2, v3] });
  const list = project(document, createFrame(), createAdapter({ gapPrice: 13 }));
  assert.ok(list);
  assert.deepEqual(entityPoints(list, "v2"), [
    20, 10, 25, 11, Number.NaN, Number.NaN, 35, 19, 40, 20,
  ]);
  assert.deepEqual(entityPoints(list, "v3"), [
    20, 10, 30, 11, Number.NaN, Number.NaN, 60, 19, 70, 20,
  ]);
  assert.deepEqual([...list.pathBreaks], [2, 7]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [2, 2]);
  assert.deepEqual(list.entities.map((entity) => entity.pathBreakCount), [1, 1]);
  assert.equal(list.unresolvedGapCount, 2);
});

test("v2/v3 span envelopes retain price Y when the exact-left batch X is unresolved", () => {
  const span = {
    exact: {
      left: { time: 20, sourceOrdinal: 0 },
      right: { time: 40, sourceOrdinal: 0 },
    },
    fallback: { fromTime: 20, toTime: 40, leftRatio: 0, rightRatio: 1 },
  };
  const v2 = createDrawingEntity({
    id: "span-v2", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [span],
      points: [
        { span: 0, ratio: 0.5, price: 10 },
        { span: 0, ratio: 0.75, price: 20 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const v3 = createDrawingEntity({
    id: "span-v3", kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [span],
      points: [
        { span: 0, ratio: 0.5, price: 10 },
        { span: 0, ratio: 0.75, price: 20 },
      ],
    } },
    style: { kind: "highlighter", lineWidth: 6 },
  });
  const document = createDrawingDocument({ scopeKey: "span-envelope", entities: [v2, v3] });
  const list = project(document, createFrame(), createAdapter({ gapTime: 20 }));

  assert.ok(list);
  assert.deepEqual(entityPoints(list, "span-v2"), [30, 10, 35, 20]);
  assert.deepEqual(entityPoints(list, "span-v3"), [30, 10, 35, 20]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], []);
});

test("v2/v3 unresolved lineage spans become path gaps while a stale final batch fails atomically", () => {
  const spans = [
    {
      exact: {
        left: { time: 20, sourceOrdinal: 0 },
        right: { time: 40, sourceOrdinal: 0 },
      },
      fallback: { fromTime: 20, toTime: 40, leftRatio: 0, rightRatio: 1 },
    },
    {
      exact: {
        left: { time: 60, sourceOrdinal: 0 },
        right: { time: 80, sourceOrdinal: 0 },
      },
      fallback: { fromTime: 60, toTime: 80, leftRatio: 0, rightRatio: 1 },
    },
  ];
  const points = [
    { span: 1, ratio: 0, price: 10 },
    { span: 1, ratio: 0.25, price: 11 },
    { span: 0, ratio: 0.5, price: 12 },
    { span: 1, ratio: 0.75, price: 13 },
    { span: 1, ratio: 1, price: 14 },
  ];
  const v2 = createDrawingEntity({
    id: "gap-v2", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans,
      points,
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const v3 = createDrawingEntity({
    id: "gap-v3", kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans,
      points,
    } },
    style: { kind: "highlighter", lineWidth: 6 },
  });
  const document = createDrawingDocument({ scopeKey: "unresolved-span", entities: [v2, v3] });
  const frame = createFrame();
  const base = createAdapter();
  const unresolvedAdapter: DrawingSceneProjectionAdapter = {
    ...base,
    projectDrawingFrameSourceLineageSpan(_frame, input) {
      const left = numeric(input.exact?.left?.time);
      const right = numeric(input.exact?.right?.time);
      return left === null || right === null || left === 20
        ? null
        : Object.freeze({ left, right });
    },
  };
  const list = project(document, frame, unresolvedAdapter);

  assert.ok(list);
  assert.deepEqual(entityPoints(list, "gap-v2"), [
    60, 10, 65, 11, Number.NaN, Number.NaN, 75, 13, 80, 14,
  ]);
  assert.deepEqual(entityPoints(list, "gap-v3"), [
    60, 10, 65, 11, Number.NaN, Number.NaN, 75, 13, 80, 14,
  ]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [2, 2]);

  const staleAdapter: DrawingSceneProjectionAdapter = {
    ...unresolvedAdapter,
    projectDrawingFrameDataPoints: () => null,
  };
  assert.equal(project(document, frame, staleAdapter), null);
});

test("returns whole-scene null for stale adapter batches or stamp mismatch", () => {
  const entities = allKindEntities();
  const lineDocument = createDrawingDocument({ scopeKey: "stale-batch", entities: [entities[0] as DrawingEntity] });
  const frame = createFrame();
  assert.equal(project(lineDocument, frame, createAdapter({ failBatch: true })), null);

  const nodes = registryNodes(lineDocument);
  const mismatchedStamp = { ...stampFor(lineDocument, frame), viewportRevision: frame.viewportRevision + 1 };
  assert.equal(projectDrawingScene({
    adapter: createAdapter(), document: lineDocument, frame, nodes, selectedId: null, stamp: mismatchedStamp,
  }), null);
});

test("reuses normalized freehand points until the canonical entity revision changes", () => {
  const firstEntity = createDrawingEntity({
    id: "cached-freehand",
    kind: "freehand",
    geometry: { kind: "freehand", dataPoints: [
      { time: 10, price: 10 },
      { time: 20, price: 20 },
    ] },
    style: { kind: "freehand", color: "#fff", lineWidth: 2 },
  });
  const firstDocument = createDrawingDocument({
    scopeKey: "normalization-cache",
    entities: [firstEntity],
  });
  const observedFirstPoints: Array<CoordinateDataPoint | undefined> = [];
  const baseAdapter = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...baseAdapter,
    projectDrawingFrameDataPoints(frame, points) {
      observedFirstPoints.push(points[0]);
      return baseAdapter.projectDrawingFrameDataPoints(frame, points);
    },
  };
  const frame = createFrame();

  assert.ok(project(firstDocument, frame, adapter));
  assert.ok(project(firstDocument, frame, adapter));
  assert.strictEqual(observedFirstPoints[0], observedFirstPoints[1]);

  const replacement = createDrawingEntity({
    id: firstEntity.id,
    kind: "freehand",
    geometryRevision: firstEntity.geometryRevision + 1,
    styleRevision: firstEntity.styleRevision,
    geometry: { kind: "freehand", dataPoints: [
      { time: 12, price: 10 },
      { time: 20, price: 20 },
    ] },
    style: firstEntity.style,
  });
  const nextDocument = createDrawingDocument({
    scopeKey: firstDocument.scopeKey,
    documentRevision: firstDocument.documentRevision + 1,
    entities: [replacement],
  });
  assert.ok(project(nextDocument, frame, adapter));
  assert.notStrictEqual(observedFirstPoints[1], observedFirstPoints[2]);
});

test("viewport LOD reuses adapter-scoped world/cache state and settles nonlinear prices exactly", () => {
  const rawPoints = Array.from({ length: 512 }, (_, index) => Object.freeze({
    time: index,
    price: 50 + Math.sin(index * 0.19) * 8,
  }));
  const entity = createDrawingEntity({
    id: "lod-cache",
    kind: "freehand",
    geometry: { kind: "freehand", dataPoints: rawPoints },
    style: { kind: "freehand", color: "#fff", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "lod-cache", entities: [entity] });
  const before = JSON.stringify(entity.geometry);
  const base = createAdapter();
  let resolveCalls = 0;
  const finalProjectionSizes: number[] = [];
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    resolveDrawingFrameDataPoints(_frame, points) {
      resolveCalls += 1;
      return Object.freeze(points.map((point): DrawingCoordinateResolution | null => (
        typeof point.time === "number"
          ? Object.freeze({ kind: "logical" as const, logical: point.time })
          : null
      )));
    },
    projectDrawingFrameResolvedDataPoints(frame, resolutions, points) {
      finalProjectionSizes.push(points.length);
      const viewport = frame.drawingViewport;
      if (!viewport || viewport.minLogical === undefined || viewport.maxLogical === undefined) {
        return null;
      }
      const logicalSpan = viewport.maxLogical - viewport.minLogical;
      const samples = viewport.priceProjectionSamples;
      const firstSample = samples?.[0];
      const middleSample = samples?.[1];
      const lastSample = samples?.at(-1);
      const nonlinear = !!firstSample && !!middleSample && !!lastSample
        && firstSample.price !== lastSample.price
        && Math.abs(
          firstSample.coordinateCssPx
            + (middleSample.price - firstSample.price)
              * (lastSample.coordinateCssPx - firstSample.coordinateCssPx)
              / (lastSample.price - firstSample.price)
            - middleSample.coordinateCssPx,
        ) > 0.25;
      const projected = new Float64Array(points.length * 2);
      projected.fill(Number.NaN);
      points.forEach((point, index) => {
        const resolution = resolutions[index];
        if (resolution?.kind !== "logical" || typeof point.price !== "number") return;
        projected[index * 2] = (resolution.logical - viewport.minLogical!)
          * frame.widthCssPx / logicalSpan;
        projected[index * 2 + 1] = nonlinear
          ? frame.heightCssPx - Math.sqrt(Math.max(0, point.price)) * frame.heightCssPx / 10
          : frame.heightCssPx - point.price * 2;
      });
      return projected;
    },
  };
  const factory = createDrawingFrameSnapshotFactory();
  const seriesData: DrawingFrameSnapshot["seriesData"] = [];
  const affineSamples = Object.freeze([
    Object.freeze({ price: 0, coordinateCssPx: 200 }),
    Object.freeze({ price: 50, coordinateCssPx: 100 }),
    Object.freeze({ price: 100, coordinateCssPx: 0 }),
  ]);
  const firstFrame = createFrame({
    factory,
    width: 200,
    height: 200,
    minHorizontal: 0,
    maxHorizontal: 511,
    minPrice: 0,
    maxPrice: 100,
    minLogical: 0,
    maxLogical: 511,
    priceProjectionSamples: affineSamples,
    seriesData,
    viewportKey: "lod-a",
  });
  const secondFrame = createFrame({
    factory,
    width: 200,
    height: 200,
    minHorizontal: 1,
    maxHorizontal: 512,
    minPrice: 0,
    maxPrice: 100,
    minLogical: 1,
    maxLogical: 512,
    priceProjectionSamples: affineSamples,
    seriesData,
    viewportKey: "lod-b",
  });

  const first = project(document, firstFrame, adapter);
  const fullProjectionCountBeforePan = finalProjectionSizes.filter(
    (count) => count === rawPoints.length,
  ).length;
  const resolveCallsBeforeViewport = resolveCalls;
  const second = project(document, secondFrame, adapter, registryNodes(document), null,
    "continuousViewport");
  assert.ok(first && second);
  assert.equal(resolveCalls - resolveCallsBeforeViewport, 0,
    "viewport-only changes must reuse canonical anchor and chunk-bound resolutions");
  assert.ok((first.entities[0]?.pointCount ?? 512) < rawPoints.length);
  assert.ok((second.entities[0]?.pointCount ?? 512) < rawPoints.length);
  assert.equal(finalProjectionSizes.filter((count) => count === rawPoints.length).length,
    fullProjectionCountBeforePan,
    "horizontal translation must reuse the exact nonlinear screen hierarchy");
  assert.ok(Math.abs(Number(entityPoints(second, entity.id)[0]) + 200 / 511) <= 1e-9,
    "selected vertices must still use the current translated frame");

  const nonlinearFrame = createFrame({
    factory,
    width: 200,
    height: 200,
    minHorizontal: 2,
    maxHorizontal: 513,
    minPrice: 0,
    maxPrice: 100,
    minLogical: 2,
    maxLogical: 513,
    priceProjectionSamples: Object.freeze([
      Object.freeze({ price: 0, coordinateCssPx: 200 }),
      Object.freeze({ price: 25, coordinateCssPx: 100 }),
      Object.freeze({ price: 100, coordinateCssPx: 0 }),
    ]),
    seriesData,
    viewportKey: "lod-log-like",
  });
  const continuous = project(document, nonlinearFrame, adapter, registryNodes(document), null,
    "continuousViewport");
  assert.equal(finalProjectionSizes.filter((count) => count === rawPoints.length).length,
    fullProjectionCountBeforePan + 1,
    "a changed vertical projection signature must build a fresh exact hierarchy");
  const settled = project(document, nonlinearFrame, adapter, registryNodes(document), null,
    "settledExact");
  assert.ok(continuous && settled);
  assert.ok((continuous.entities[0]?.pointCount ?? 512) < rawPoints.length,
    "unreliable affine modes publish an exact-projected low-LOD path during the gesture");
  assert.ok((settled.entities[0]?.pointCount ?? 512) < rawPoints.length / 2,
    "the settled nonlinear <=0.5px hierarchy must significantly reduce vertices");
  const settledPoints = entityPoints(settled, entity.id);
  const exactSourcePoints = rawPoints.map((point) => Object.freeze({
    x: (point.time - 2) * 200 / 511,
    y: 200 - Math.sqrt(point.price) * 20,
  }));
  assert.ok(maximumPointToPolylineError(exactSourcePoints, settledPoints) <= 0.500_001,
    "settled nonlinear LOD must stay within 0.5 CSS pixels of public exact projection");
  assert.deepEqual(settledPoints.slice(0, 2), [exactSourcePoints[0]?.x, exactSourcePoints[0]?.y]);
  assert.deepEqual(settledPoints.slice(-2), [exactSourcePoints.at(-1)?.x, exactSourcePoints.at(-1)?.y]);
  assert.ok(finalProjectionSizes.some((count) => count > 0 && count < rawPoints.length));
  assert.equal(JSON.stringify(entity.geometry), before, "LOD/cache work must not mutate canonical raw points");
});

test("source-lineage affine price evidence builds LOD without projecting every raw point", () => {
  const points = Object.freeze(Array.from({ length: 1_024 }, (_, index) => {
    const ratio = index / 1_023;
    return Object.freeze({
      span: 0,
      ratio,
      price: 15 + ratio * 70 + Math.sin(ratio * Math.PI * 10) * 4,
    });
  }));
  const spans = Object.freeze([Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: 0, sourceOrdinal: 0 }),
      right: Object.freeze({ time: 320, sourceOrdinal: 0 }),
    }),
    fallback: Object.freeze({ fromTime: 0, toTime: 320, leftRatio: 0, rightRatio: 1 }),
  })]);

  for (const inverted of [false, true]) {
    const entity = createDrawingEntity({
      id: `lineage-affine-${inverted ? "inverted" : "normal"}`,
      kind: "highlighter",
      geometry: { kind: "highlighter", stroke: {
        version: 3,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset:renko:affine",
        spans,
        points,
      } },
      style: { kind: "highlighter", brushShape: "square", lineWidth: 2 },
    });
    const document = createDrawingDocument({
      scopeKey: entity.id,
      entities: [entity],
    });
    const finalProjectionSizes: number[] = [];
    const adapter: DrawingSceneProjectionAdapter = {
      ...createAdapter(),
      resolveDrawingFrameDataPoints(_frame, requests) {
        return Object.freeze(requests.map(() => Object.freeze({
          kind: "logical" as const,
          logical: 0,
        })));
      },
      projectDrawingFrameResolvedDataPoints(_frame, _resolutions, requests) {
        finalProjectionSizes.push(requests.length);
        const projected = new Float64Array(requests.length * 2);
        projected.fill(Number.NaN);
        requests.forEach((request, index) => {
          const price = numeric(request.price);
          if (price === null) return;
          projected[index * 2] = 0;
          projected[index * 2 + 1] = inverted ? price * 2 : 200 - price * 2;
        });
        return projected;
      },
      projectDrawingFrameSourceLineageSpan() {
        return Object.freeze({ left: 0, right: 320 });
      },
    };
    const priceProjectionSamples = Object.freeze([
      Object.freeze({ price: 0, coordinateCssPx: inverted ? 0 : 200 }),
      Object.freeze({ price: 50, coordinateCssPx: 100 }),
      Object.freeze({ price: 100, coordinateCssPx: inverted ? 200 : 0 }),
    ]);
    const frame = createFrame({
      width: 320,
      height: 200,
      minHorizontal: 0,
      maxHorizontal: 320,
      minLogical: 0,
      maxLogical: 320,
      minPrice: 0,
      maxPrice: 100,
      priceProjectionSamples,
      viewportKey: `lineage-affine-${inverted}`,
    });

    const list = project(
      document,
      frame,
      adapter,
      registryNodes(document),
      null,
      "settledExact",
    );
    assert.ok(list);
    assert.ok((list.entities[0]?.pointCount ?? points.length) < points.length / 2);
    assert.deepEqual(finalProjectionSizes, [3],
      "a strict affine lineage certificate needs only candidate extrema/midpoint evidence");
    const exactSourcePoints = points.map((point) => Object.freeze({
      x: point.ratio * 320,
      y: inverted ? point.price * 2 : 200 - point.price * 2,
    }));
    assert.ok(maximumPointToPolylineError(exactSourcePoints, entityPoints(list, entity.id))
      <= 0.500_001, "affine lineage LOD must keep the settled exact CSS error contract");
  }
});

test("source-lineage publication rejects sub-pixel nonlinearity above machine precision", () => {
  const points = Object.freeze(Array.from({ length: 1_024 }, (_, index) => {
    const ratio = index / 1_023;
    return Object.freeze({
      span: 0,
      ratio,
      price: 50 + Math.sin(ratio * Math.PI * 16) * 25,
    });
  }));
  const spans = Object.freeze([Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: 0, sourceOrdinal: 0 }),
      right: Object.freeze({ time: 320, sourceOrdinal: 0 }),
    }),
    fallback: Object.freeze({ fromTime: 0, toTime: 320, leftRatio: 0, rightRatio: 1 }),
  })]);
  const entity = createDrawingEntity({
    id: "lineage-near-affine-publication",
    kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko:near-affine",
      spans,
      points,
    } },
    style: { kind: "highlighter", brushShape: "square", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: entity.id, entities: [entity] });
  const projectPrice = (price: number) => (
    200 - price * 2 + 0.02 * ((price - 50) / 50) ** 2
  );
  const finalProjectionSizes: number[] = [];
  const adapter: DrawingSceneProjectionAdapter = {
    ...createAdapter(),
    resolveDrawingFrameDataPoints(_frame, requests) {
      return Object.freeze(requests.map(() => Object.freeze({
        kind: "logical" as const,
        logical: 0,
      })));
    },
    projectDrawingFrameResolvedDataPoints(_frame, _resolutions, requests) {
      finalProjectionSizes.push(requests.length);
      const projected = new Float64Array(requests.length * 2);
      projected.fill(Number.NaN);
      requests.forEach((request, index) => {
        const price = numeric(request.price);
        if (price === null) return;
        projected[index * 2] = 0;
        projected[index * 2 + 1] = projectPrice(price);
      });
      return projected;
    },
    projectDrawingFrameSourceLineageSpan() {
      return Object.freeze({ left: 0, right: 320 });
    },
  };
  const frame = createFrame({
    width: 320,
    height: 200,
    minHorizontal: 0,
    maxHorizontal: 320,
    minLogical: 0,
    maxLogical: 320,
    minPrice: 0,
    maxPrice: 100,
    priceProjectionSamples: Object.freeze([0, 50, 100].map((price) => Object.freeze({
      price,
      coordinateCssPx: projectPrice(price),
    }))),
    viewportKey: "lineage-near-affine-publication",
  });

  const list = project(document, frame, adapter, registryNodes(document), null, "settledExact");
  assert.ok(list);
  assert.equal(finalProjectionSizes[0], 3,
    "candidate extrema/midpoint must provide public evidence for the strict certificate");
  assert.equal(finalProjectionSizes.includes(points.length), false,
    "sub-pixel nonlinearity may retain the bounded affine hierarchy proxy");
  assert.ok(finalProjectionSizes.some((size) => size > 3 && size < points.length),
    "nonlinearity above machine precision must publicly project selected vertices");
  const published = entityPoints(list, entity.id);
  for (let offset = 0; offset < published.length; offset += 2) {
    const x = Number(published[offset]);
    const y = Number(published[offset + 1]);
    const sourceIndex = Math.round(x / 320 * 1_023);
    const sourcePoint = points[sourceIndex];
    assert.ok(sourcePoint);
    assert.ok(Math.abs(x - sourcePoint.ratio * 320) <= 1e-9);
    assert.ok(Math.abs(y - projectPrice(sourcePoint.price)) <= 1e-9,
      "published Y must retain the public exact nonlinear projection");
  }
});

test("source-lineage affine evidence rejects log-like extrapolation outside its sampled price envelope", () => {
  const points = Object.freeze(Array.from({ length: 512 }, (_, index) => Object.freeze({
    span: 0,
    ratio: index / 511,
    price: index % 64 === 0 ? 50 : 100 + Math.sin(index * 0.2) * 0.2,
  })));
  const span = Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: 0, sourceOrdinal: 0 }),
      right: Object.freeze({ time: 320, sourceOrdinal: 0 }),
    }),
    fallback: Object.freeze({ fromTime: 0, toTime: 320, leftRatio: 0, rightRatio: 1 }),
  });
  const entity = createDrawingEntity({
    id: "lineage-local-log",
    kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko:local-log",
      spans: [span],
      points,
    } },
    style: { kind: "highlighter", brushShape: "square", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: entity.id, entities: [entity] });
  const finalProjectionSizes: number[] = [];
  const bottomPrice = 99.6;
  const topPrice = 100.4;
  const logSpan = Math.log(topPrice) - Math.log(bottomPrice);
  const projectPrice = (price: number) => (
    (Math.log(topPrice) - Math.log(price)) / logSpan * 200
  );
  const adapter: DrawingSceneProjectionAdapter = {
    ...createAdapter(),
    resolveDrawingFrameDataPoints(_frame, requests) {
      return Object.freeze(requests.map(() => Object.freeze({
        kind: "logical" as const,
        logical: 0,
      })));
    },
    projectDrawingFrameResolvedDataPoints(_frame, _resolutions, requests) {
      finalProjectionSizes.push(requests.length);
      const projected = new Float64Array(requests.length * 2);
      projected.fill(Number.NaN);
      requests.forEach((request, index) => {
        const price = numeric(request.price);
        if (price === null) return;
        projected[index * 2] = 0;
        projected[index * 2 + 1] = projectPrice(price);
      });
      return projected;
    },
    projectDrawingFrameSourceLineageSpan() {
      return Object.freeze({ left: 0, right: 320 });
    },
  };
  const middlePrice = Math.sqrt(bottomPrice * topPrice);
  const frame = createFrame({
    width: 320,
    height: 200,
    minHorizontal: 0,
    maxHorizontal: 320,
    minLogical: 0,
    maxLogical: 320,
    minPrice: bottomPrice,
    maxPrice: topPrice,
    priceProjectionSamples: Object.freeze([
      Object.freeze({ price: topPrice, coordinateCssPx: 0 }),
      Object.freeze({ price: middlePrice, coordinateCssPx: 100 }),
      Object.freeze({ price: bottomPrice, coordinateCssPx: 200 }),
    ]),
    viewportKey: "lineage-local-log",
  });

  const list = project(document, frame, adapter, registryNodes(document), null, "settledExact");
  assert.ok(list);
  assert.ok(finalProjectionSizes.includes(points.length),
    "out-of-envelope points must force the exact public hierarchy projection");
});

test("source-lineage LOD keeps span endpoints and gaps while reusing viewport-independent anchors", () => {
  const spanSpecs = Object.freeze([
    Object.freeze({ left: 0, right: 100, resolved: true }),
    Object.freeze({ left: -20, right: -10, resolved: false }),
    Object.freeze({ left: 110, right: 210, resolved: true }),
    Object.freeze({ left: -40, right: -30, resolved: false }),
    Object.freeze({ left: 220, right: 320, resolved: true }),
  ]);
  const spans = spanSpecs.map((spec) => Object.freeze({
    exact: Object.freeze({
      left: Object.freeze({ time: spec.left, sourceOrdinal: 0 }),
      right: Object.freeze({ time: spec.right, sourceOrdinal: 0 }),
    }),
    fallback: Object.freeze({
      fromTime: spec.left,
      toTime: spec.right,
      leftRatio: 0,
      rightRatio: 1,
    }),
  }));
  const createSegment = (span: number, count: number) => Array.from(
    { length: count },
    (_, index) => {
      const ratio = index / (count - 1);
      return Object.freeze({
        span,
        ratio,
        price: 50 + Math.sin(ratio * Math.PI * 12) * 8,
      });
    },
  );
  const firstSegment = createSegment(0, 1_365);
  const secondSegment = createSegment(2, 1_364);
  const thirdSegment = createSegment(4, 1_365);
  const points = Object.freeze([
    ...firstSegment,
    Object.freeze({ span: 1, ratio: 0.5, price: 50 }),
    ...secondSegment,
    Object.freeze({ span: 3, ratio: 0.5, price: 50 }),
    ...thirdSegment,
  ]);
  assert.equal(points.length, 4_096);
  const entity = createDrawingEntity({
    id: "lineage-lod-4096",
    kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko:lineage-lod",
      spans,
      points,
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "lineage-lod-4096",
    entities: [entity],
  });
  const canonicalBefore = JSON.stringify(entity.geometry);
  let resolveCalls = 0;
  let legacyBatchCalls = 0;
  const finalProjectionSizes: number[] = [];
  const yOnlyFinalProjectionSizes: number[] = [];
  const spanProjectionLefts: number[] = [];
  const base = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    projectDrawingFrameDataPoints() {
      legacyBatchCalls += 1;
      return null;
    },
    resolveDrawingFrameDataPoints(_frame, requests) {
      resolveCalls += 1;
      return Object.freeze(requests.map((request): DrawingCoordinateResolution | null => {
        const logical = numeric(request.logical) ?? numeric(request.time);
        return logical === null
          ? null
          : Object.freeze({ kind: "logical" as const, logical });
      }));
    },
    projectDrawingFrameResolvedDataPoints(frame, resolutions, requests) {
      finalProjectionSizes.push(requests.length);
      if (requests.length > 0 && resolutions.every((resolution) => resolution === null)) {
        yOnlyFinalProjectionSizes.push(requests.length);
      }
      const viewport = frame.drawingViewport;
      if (!viewport || viewport.minLogical === undefined || viewport.maxLogical === undefined) {
        return null;
      }
      const logicalSpan = viewport.maxLogical - viewport.minLogical;
      const projected = new Float64Array(requests.length * 2);
      projected.fill(Number.NaN);
      requests.forEach((request, index) => {
        const resolution = resolutions[index];
        if (resolution?.kind === "logical") {
          projected[index * 2] = (resolution.logical - viewport.minLogical!)
            * frame.widthCssPx / logicalSpan;
        }
        const price = numeric(request.price);
        if (price !== null) {
          projected[index * 2 + 1] = frame.heightCssPx
            - Math.sqrt(Math.max(0, price)) * frame.heightCssPx / 10;
        }
      });
      return projected;
    },
    projectDrawingFrameSourceLineageSpan(frame, span) {
      const left = numeric(span.exact?.left?.time);
      const right = numeric(span.exact?.right?.time);
      if (left === null || right === null || left < 0 || left >= right) return null;
      const viewport = frame.drawingViewport;
      if (!viewport || viewport.minLogical === undefined || viewport.maxLogical === undefined) {
        return null;
      }
      spanProjectionLefts.push(left);
      const logicalSpan = viewport.maxLogical - viewport.minLogical;
      return Object.freeze({
        left: (left - viewport.minLogical) * frame.widthCssPx / logicalSpan,
        right: (right - viewport.minLogical) * frame.widthCssPx / logicalSpan,
      });
    },
  };
  const factory = createDrawingFrameSnapshotFactory();
  const seriesData: DrawingFrameSnapshot["seriesData"] = [];
  const nonlinearSamples = Object.freeze([
    Object.freeze({ price: 0, coordinateCssPx: 240 }),
    Object.freeze({ price: 25, coordinateCssPx: 120 }),
    Object.freeze({ price: 100, coordinateCssPx: 0 }),
  ]);
  const frame = createFrame({
    factory,
    width: 320,
    height: 240,
    minHorizontal: 0,
    maxHorizontal: 320,
    minLogical: 0,
    maxLogical: 320,
    priceProjectionSamples: nonlinearSamples,
    seriesData,
    viewportKey: "lineage-lod-a",
  });

  const continuous = project(
    document,
    frame,
    adapter,
    registryNodes(document),
    null,
    "continuousViewport",
  );
  const settled = project(
    document,
    frame,
    adapter,
    registryNodes(document),
    null,
    "settledExact",
  );
  assert.ok(continuous && settled);
  assert.equal(legacyBatchCalls, 0, "modern lineage LOD must stay on split resolve/final APIs");
  assert.equal(resolveCalls, 1, "continuous and settled passes share one world-anchor resolution");
  assert.ok((continuous.entities[0]?.pointCount ?? points.length) < points.length / 2);
  assert.ok((settled.entities[0]?.pointCount ?? points.length) < points.length / 2);
  assert.ok((continuous.entities[0]?.pointCount ?? Number.POSITIVE_INFINITY) <= 3 * frame.widthCssPx);
  assert.ok((settled.entities[0]?.pointCount ?? Number.POSITIVE_INFINITY) <= 3 * frame.widthCssPx);
  assert.equal(continuous.entities[0]?.pathBreakCount, 2);
  assert.equal(settled.entities[0]?.pathBreakCount, 2);

  const settledPoints = entityPoints(settled, entity.id);
  const settledPaths = splitFinitePolylinePaths(settledPoints);
  assert.equal(settledPaths.length, 3, "two unresolved spans must remain two explicit path gaps");
  const expectedSpanEndpoints = [[0, 100], [110, 210], [220, 320]] as const;
  const endpointY = 240 - Math.sqrt(50) * 24;
  settledPaths.forEach((path, index) => {
    const expected = expectedSpanEndpoints[index];
    assert.ok(expected && path.length >= 4);
    assert.ok(Math.abs(Number(path[0]) - expected[0]) <= 1e-9);
    assert.ok(Math.abs(Number(path[1]) - endpointY) <= 1e-9);
    assert.ok(Math.abs(Number(path.at(-2)) - expected[1]) <= 1e-9);
    assert.ok(Math.abs(Number(path.at(-1)) - endpointY) <= 1e-9);
  });
  const exactSourcePoints = [
    ...firstSegment.map((point) => Object.freeze({
      x: spanSpecs[0]!.left + (spanSpecs[0]!.right - spanSpecs[0]!.left) * point.ratio,
      y: 240 - Math.sqrt(point.price) * 24,
    })),
    ...secondSegment.map((point) => Object.freeze({
      x: spanSpecs[2]!.left + (spanSpecs[2]!.right - spanSpecs[2]!.left) * point.ratio,
      y: 240 - Math.sqrt(point.price) * 24,
    })),
    ...thirdSegment.map((point) => Object.freeze({
      x: spanSpecs[4]!.left + (spanSpecs[4]!.right - spanSpecs[4]!.left) * point.ratio,
      y: 240 - Math.sqrt(point.price) * 24,
    })),
  ];
  assert.ok(maximumPointToPolylineError(exactSourcePoints, settledPoints) <= 0.500_001,
    "settled source-lineage LOD must stay within 0.5 CSS pixels of exact screen paths");
  assert.ok(finalProjectionSizes.includes(points.length),
    "the nonlinear hierarchy must be built from one exact bounded candidate projection");
  assert.ok(finalProjectionSizes.some((size) => size > 0 && size < points.length));
  assert.ok(yOnlyFinalProjectionSizes.some((size) => size > 0 && size < points.length),
    "selected lineage LOD vertices must request price Y without reprojecting overwritten X");
  assert.deepEqual(spanProjectionLefts, [0, 110, 220, 0, 110, 220],
    "the settled pass may refresh selected span coordinates but must reuse the screen hierarchy");
  assert.equal(JSON.stringify(entity.geometry), canonicalBefore);

  const fullProjectionCountBeforeViewport = finalProjectionSizes.filter(
    (size) => size === points.length,
  ).length;
  const spanProjectionCountBeforeViewport = spanProjectionLefts.length;
  const viewportFrame = createFrame({
    factory,
    width: 320,
    height: 240,
    minHorizontal: 10,
    maxHorizontal: 330,
    minLogical: 10,
    maxLogical: 330,
    priceProjectionSamples: nonlinearSamples,
    seriesData,
    viewportKey: "lineage-lod-b",
  });
  const resolveCallsBeforeViewport = resolveCalls;
  const viewportList = project(
    document,
    viewportFrame,
    adapter,
    registryNodes(document),
    null,
    "continuousViewport",
  );
  assert.ok(viewportList);
  assert.equal(resolveCalls - resolveCallsBeforeViewport, 0,
    "viewport-only lineage passes must reuse source-anchor resolutions");
  assert.equal(finalProjectionSizes.filter((size) => size === points.length).length,
    fullProjectionCountBeforeViewport,
    "translation-only lineage passes must not reproject all canonical points");
  assert.deepEqual(
    spanProjectionLefts.slice(spanProjectionCountBeforeViewport),
    [0, 110, 220],
    "translation-only reuse must refresh only selected current-frame spans",
  );
  assert.equal(viewportList.entities[0]?.pathBreakCount, 2);
  assert.ok((viewportList.entities[0]?.pointCount ?? Number.POSITIVE_INFINITY)
    <= 3 * viewportFrame.widthCssPx);
  const viewportPaths = splitFinitePolylinePaths(entityPoints(viewportList, entity.id));
  assert.ok(Math.abs(Number(viewportPaths[0]?.[0]) + 10) <= 1e-9);
  assert.ok(Math.abs(Number(viewportPaths[0]?.at(-2)) - 90) <= 1e-9,
    "cached LOD selections must publish current-frame lineage coordinates");
  assert.equal(JSON.stringify(entity.geometry), canonicalBefore);

  const zoomFrame = createFrame({
    factory,
    width: 320,
    height: 240,
    barSpacing: 24,
    minHorizontal: 10,
    maxHorizontal: 170,
    minLogical: 10,
    maxLogical: 170,
    priceProjectionSamples: nonlinearSamples,
    seriesData,
    viewportKey: "lineage-lod-zoom",
  });
  const zoomList = project(
    document,
    zoomFrame,
    adapter,
    registryNodes(document),
    null,
    "continuousViewport",
  );
  assert.ok(zoomList);
  const fullProjectionCountAfterZoom = finalProjectionSizes.filter(
    (size) => size === points.length,
  ).length;
  assert.ok(fullProjectionCountAfterZoom > fullProjectionCountBeforeViewport,
    "a new horizontal scale must build its own exact hierarchy");

  const returnToPriorScaleFrame = createFrame({
    factory,
    width: 320,
    height: 240,
    barSpacing: 12,
    minHorizontal: 20,
    maxHorizontal: 340,
    minLogical: 20,
    maxLogical: 340,
    priceProjectionSamples: nonlinearSamples,
    seriesData,
    viewportKey: "lineage-lod-return",
  });
  const returnedList = project(
    document,
    returnToPriorScaleFrame,
    adapter,
    registryNodes(document),
    null,
    "continuousViewport",
  );
  assert.ok(returnedList);
  assert.equal(finalProjectionSizes.filter((size) => size === points.length).length,
    fullProjectionCountAfterZoom,
    "the byte-LRU must retain more than one recent horizontal scale");
  const returnedPaths = splitFinitePolylinePaths(entityPoints(returnedList, entity.id));
  assert.ok(Math.abs(Number(returnedPaths[0]?.[0]) + 20) <= 1e-9);
  assert.ok(Math.abs(Number(returnedPaths[0]?.at(-2)) - 80) <= 1e-9);
  assert.equal(JSON.stringify(entity.geometry), canonicalBefore);
});

test("projects only visible long-stroke chunks and keeps canonical source gap indexes", () => {
  const points = Array.from({ length: 300 }, (_, index) => ({
    time: index,
    price: index === 130 || index === 270 ? 13 : 50,
  }));
  const entity = createDrawingEntity({
    id: "long", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 3,
      sourceProjection: "time",
      sourceProjectionConfig: "dataset:time",
      spans: [],
      points,
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "chunks", entities: [entity] });
  const frame = createFrame({
    width: 320,
    height: 100,
    minHorizontal: 140,
    maxHorizontal: 150,
    minPrice: 0,
    maxPrice: 100,
  });
  const baseAdapter = createAdapter();
  const adapter: TestAdapter = {
    ...baseAdapter,
    projectDrawingFrameDataPoints(_frame, requests) {
      baseAdapter.batchInputs.push([...requests]);
      baseAdapter.batchSizes.push(requests.length);
      const result = new Float64Array(requests.length * 2);
      result.fill(Number.NaN);
      requests.forEach((request, index) => {
        const horizontal = numeric(request.logical) ?? numeric(request.time);
        const price = numeric(request.price);
        if (horizontal !== null && horizontal !== 130 && horizontal !== 270) {
          result[index * 2] = (horizontal - 140) * 32;
        }
        if (price !== null) result[index * 2 + 1] = price;
      });
      return result;
    },
  };
  const list = project(document, frame, adapter);
  assert.ok(list);
  assert.equal(list.entities[0]?.pointCount, 131);
  const projected = entityPoints(list, "long");
  assert.equal(projected[0], -448);
  assert.equal(projected.at(-2), 3712);
  assert.deepEqual([...list.pathBreaks], [4]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [130]);
  assert.equal(list.entities[0]?.canonicalGapCoverageComplete, false);
  assert.equal(Math.max(...adapter.batchSizes), 131);
  assert.equal(adapter.batchSizes.includes(300), false);

  const canonicalGaps = projectDrawingSceneCanonicalGapIndexes({
    adapter,
    document,
    plan: list,
    frame,
  });
  assert.ok(canonicalGaps);
  assert.deepEqual([...canonicalGaps.get("long") ?? []], [130, 270]);
  assert.equal(adapter.batchSizes.includes(300), true);
});

test("preserves stroke projection identity for canonical time points", () => {
  const entity = createDrawingEntity({
    id: "derived-time-points", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 3,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko:10",
      spans: [],
      points: [
        { time: 1_000, price: 10 },
        { time: 2_000, price: 20 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "derived-time-points",
    entities: [entity],
  });
  const baseAdapter = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...baseAdapter,
    projectDrawingFrameDataPoints(frame, points) {
      if (points.some((point) => (
        point.sourceProjection !== "renko"
        || point.sourceProjectionConfig !== "dataset:renko:10"
      ))) {
        return new Float64Array(points.length * 2).fill(Number.NaN);
      }
      return baseAdapter.projectDrawingFrameDataPoints(frame, points);
    },
  };
  const frame = createFrame({
    width: 3_000,
    height: 100,
    horizontalDomain: "logical",
    maxHorizontal: 3_000,
    maxPrice: 100,
  });

  const list = project(document, frame, adapter);
  assert.ok(list);
  assert.deepEqual(entityPoints(list, entity.id), [1_000, 10, 2_000, 20]);
  assert.equal(list.entities[0]?.canonicalGapCoverageComplete, true);

  const batchCountBeforeCanonicalGaps = baseAdapter.batchSizes.length;
  const canonicalGaps = projectDrawingSceneCanonicalGapIndexes({
    adapter,
    document,
    plan: list,
    frame,
  });
  assert.ok(canonicalGaps);
  assert.deepEqual([...canonicalGaps.get(entity.id) ?? []], []);
  assert.equal(baseAdapter.batchSizes.length, batchCountBeforeCanonicalGaps);
});

test("reuses complete non-empty scene gaps and rejects a mismatched document plan", () => {
  const entity = createDrawingEntity({
    id: "complete-gaps", kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      sourceProjection: "time",
      sourceProjectionConfig: "dataset:time",
      spans: [],
      points: [
        { time: 10, price: 10 },
        { time: 20, price: 13 },
        { time: 30, price: 30 },
        { time: 40, price: 40 },
      ],
    } },
    style: { kind: "highlighter", lineWidth: 6 },
  });
  const document = createDrawingDocument({ scopeKey: "complete-gaps", entities: [entity] });
  const adapter = createAdapter({ gapPrice: 13 });
  const frame = createFrame();
  const list = project(document, frame, adapter);
  assert.ok(list);
  assert.equal(list.entities[0]?.canonicalGapCoverageComplete, true);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [1]);
  const batchCount = adapter.batchSizes.length;

  const gaps = projectDrawingSceneCanonicalGapIndexes({ adapter, document, plan: list, frame });
  assert.ok(gaps);
  assert.deepEqual([...gaps.get(entity.id) ?? []], [1]);
  assert.equal(adapter.batchSizes.length, batchCount);

  const nextDocument = createDrawingDocument({
    scopeKey: document.scopeKey,
    documentRevision: document.documentRevision + 1,
    entities: [entity],
  });
  assert.equal(projectDrawingSceneCanonicalGapIndexes({
    adapter,
    document: nextDocument,
    plan: list,
    frame,
  }), null);
});

test("normalizes unresolved plain-stroke pairs without mutating the adapter buffer", () => {
  const entity = createDrawingEntity({
    id: "plain-stroke-gap", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 3,
      sourceProjection: "time-axis",
      sourceProjectionConfig: "dataset:time",
      spans: [],
      points: [
        { time: 10, price: 10 },
        { time: 20, price: 20 },
        { time: 30, price: 30 },
        { time: 40, price: 40 },
        { time: 50, price: 50 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "plain-stroke-gap", entities: [entity] });
  const frame = createFrame();
  const adapterBuffer = new Float64Array([
    10, 10,
    20, 20,
    Number.NaN, 30,
    40, 40,
    50, 50,
  ]);
  const base = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    projectDrawingFrameDataPoints: () => adapterBuffer,
  };

  const list = project(document, frame, adapter);

  assert.ok(list);
  assert.deepEqual([...list.points], [
    10, 10, 20, 20, Number.NaN, Number.NaN, 40, 40, 50, 50,
  ]);
  assert.deepEqual([...list.pathBreaks], [2]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [2]);
  assert.deepEqual([...adapterBuffer], [
    10, 10, 20, 20, Number.NaN, 30, 40, 40, 50, 50,
  ]);
});

test("cross-domain chunk-corner anchors reuse world resolution until bounds identity changes", () => {
  const pointCount = 384;
  const points = Array.from({ length: pointCount }, (_, index) => Object.freeze({
    time: index,
    price: 50 + Math.sin(index * 0.05) * 8,
  }));
  const entity = createDrawingEntity({
    id: "cross-domain-cache",
    kind: "freehand",
    geometry: { kind: "freehand", dataPoints: points },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "cross-domain-cache",
    entities: [entity],
  });
  const registry = createDrawingSceneRegistry(document.scopeKey);
  assert.equal(registry.reconcile(document).ok, true);
  const firstNodes = registry.getSnapshot().nodes;
  const resolveBatchSizes: number[] = [];
  const base = createAdapter();
  const adapter: DrawingSceneProjectionAdapter = {
    ...base,
    resolveDrawingFrameDataPoints(_frame, requests) {
      resolveBatchSizes.push(requests.length);
      return Object.freeze(requests.map((request): DrawingCoordinateResolution | null => {
        const logical = numeric(request.logical) ?? numeric(request.time);
        return logical === null
          ? null
          : Object.freeze({ kind: "logical" as const, logical });
      }));
    },
    projectDrawingFrameResolvedDataPoints(frame, resolutions, requests) {
      const viewport = frame.drawingViewport;
      if (!viewport || viewport.minLogical === undefined || viewport.maxLogical === undefined) {
        return null;
      }
      const span = viewport.maxLogical - viewport.minLogical;
      const projected = new Float64Array(requests.length * 2);
      projected.fill(Number.NaN);
      requests.forEach((request, index) => {
        const resolution = resolutions[index];
        if (resolution?.kind === "logical") {
          projected[index * 2] = (resolution.logical - viewport.minLogical!)
            * frame.widthCssPx / span;
        }
        const price = numeric(request.price);
        if (price !== null) projected[index * 2 + 1] = frame.heightCssPx - price;
      });
      return projected;
    },
  };
  const factory = createDrawingFrameSnapshotFactory();
  const seriesData: DrawingFrameSnapshot["seriesData"] = [];
  const priceProjectionSamples = Object.freeze([
    Object.freeze({ price: 0, coordinateCssPx: 100 }),
    Object.freeze({ price: 50, coordinateCssPx: 50 }),
    Object.freeze({ price: 100, coordinateCssPx: 0 }),
  ]);
  const firstFrame = createFrame({
    factory,
    width: pointCount,
    height: 100,
    horizontalDomain: "logical",
    minHorizontal: 0,
    maxHorizontal: pointCount - 1,
    minLogical: 0,
    maxLogical: pointCount - 1,
    priceProjectionSamples,
    seriesData,
    viewportKey: "cross-domain-a",
  });
  const secondFrame = createFrame({
    factory,
    width: pointCount,
    height: 100,
    horizontalDomain: "logical",
    minHorizontal: 1,
    maxHorizontal: pointCount,
    minLogical: 1,
    maxLogical: pointCount,
    priceProjectionSamples,
    seriesData,
    viewportKey: "cross-domain-b",
  });

  assert.ok(project(document, firstFrame, adapter, firstNodes, null, "continuousViewport"));
  const firstCornerResolveCount = resolveBatchSizes.filter((size) => size !== pointCount).length;
  assert.ok(firstCornerResolveCount > 0, "derived/logical culling must resolve time-domain corners");
  const resolveCountAfterFirstFrame = resolveBatchSizes.length;
  assert.ok(project(document, secondFrame, adapter, firstNodes, null, "continuousViewport"));
  assert.equal(resolveBatchSizes.length, resolveCountAfterFirstFrame,
    "viewport-only projection must reuse both chunk-corner and canonical world anchors");

  const replacementPoints = points.map((point) => Object.freeze({
    time: point.time + 4,
    price: point.price + 1,
  }));
  const replacement = createDrawingEntity({
    id: entity.id,
    kind: entity.kind,
    geometryRevision: entity.geometryRevision + 1,
    styleRevision: entity.styleRevision,
    geometry: { kind: "freehand", dataPoints: replacementPoints },
    style: entity.style,
  });
  const nextDocument = createDrawingDocument({
    scopeKey: document.scopeKey,
    documentRevision: document.documentRevision + 1,
    entities: [replacement],
  });
  assert.equal(registry.reconcile(nextDocument).ok, true);
  const nextNodes = registry.getSnapshot().nodes;
  assert.ok(project(nextDocument, secondFrame, adapter, nextNodes, null, "continuousViewport"));
  assert.ok(
    resolveBatchSizes.filter((size) => size !== pointCount).length > firstCornerResolveCount,
    "replacement bounds identity must force a fresh chunk-corner source resolution",
  );
});

test("cross-domain chunk culling fails open for exact lineage across duplicate source times", () => {
  const lineage = {
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset:renko",
  };
  const span = {
    exact: {
      left: { time: 1_000, sourceOrdinal: 0 },
      right: { time: 1_000, sourceOrdinal: 1 },
    },
    fallback: { fromTime: 1_000, toTime: 1_001, leftRatio: 0, rightRatio: 1 },
  };
  const v1 = createDrawingEntity({
    id: "lineage-v1", kind: "freehand",
    geometry: { kind: "freehand", dataPoints: [
      { time: 1_000, sourceOrdinal: 0, ...lineage, price: 10 },
      { time: 1_000, sourceOrdinal: 1, ...lineage, price: 20 },
    ] },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const v2 = createDrawingEntity({
    id: "lineage-v2", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      ...lineage,
      spans: [span],
      points: [
        { span: 0, ratio: 0, price: 10 },
        { span: 0, ratio: 1, price: 20 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const v3 = createDrawingEntity({
    id: "lineage-v3", kind: "highlighter",
    geometry: { kind: "highlighter", stroke: {
      version: 3,
      ...lineage,
      spans: [],
      points: [
        { anchor: { time: 1_000, sourceOrdinal: 0 }, price: 10 },
        { anchor: { time: 1_000, sourceOrdinal: 1 }, price: 20 },
      ],
    } },
    style: { kind: "highlighter", lineWidth: 6 },
  });
  const document = createDrawingDocument({
    scopeKey: "duplicate-lineage",
    entities: [v1, v2, v3],
  });
  const lineageAdapter: DrawingSceneProjectionAdapter = {
    projectDrawingFrameDataPoints(_frame, points) {
      const projected = new Float64Array(points.length * 2);
      projected.fill(Number.NaN);
      points.forEach((point, index) => {
        const sourceOrdinal = numeric(point.sourceOrdinal);
        const x = sourceOrdinal === null
          ? numeric(point.logical) ?? numeric(point.time)
          : 10 + sourceOrdinal * 10;
        const y = numeric(point.price);
        if (x !== null) projected[index * 2] = x;
        if (y !== null) projected[index * 2 + 1] = y;
      });
      return projected;
    },
    projectDrawingFrameSourceLineageSpan: () => Object.freeze({ left: 10, right: 20 }),
  };
  const list = project(document, createFrame({
    horizontalDomain: "logical",
    minHorizontal: 0,
    maxHorizontal: 100,
  }), lineageAdapter);

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), ["lineage-v1", "lineage-v2", "lineage-v3"]);
  assert.deepEqual(entityPoints(list, "lineage-v1"), [10, 10, 20, 20]);
  assert.deepEqual(entityPoints(list, "lineage-v2"), [10, 10, 20, 20]);
  assert.deepEqual(entityPoints(list, "lineage-v3"), [10, 10, 20, 20]);
});

test("time-domain span chunks defer unsafe fallback-time bounds to the exact frame projector", () => {
  const entity = createDrawingEntity({
    id: "uneven-span", kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [{
        exact: {
          left: { time: 100, sourceOrdinal: 0 },
          right: { time: 200, sourceOrdinal: 1 },
        },
        fallback: { fromTime: 100, toTime: 200, leftRatio: 0.4, rightRatio: 0.6 },
      }],
      points: [
        { span: 0, ratio: 0, price: 10 },
        { span: 0, ratio: 1, price: 20 },
      ],
    } },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "uneven-span", entities: [entity] });
  const adapter: DrawingSceneProjectionAdapter = {
    projectDrawingFrameDataPoints(_frame, points) {
      const projected = new Float64Array(points.length * 2);
      points.forEach((point, index) => {
        projected[index * 2] = 10;
        projected[index * 2 + 1] = Number(point.price);
      });
      return projected;
    },
    projectDrawingFrameSourceLineageSpan: () => Object.freeze({ left: 10, right: 20 }),
  };
  const list = project(document, createFrame({
    horizontalDomain: "time",
    minHorizontal: 100,
    maxHorizontal: 120,
  }), adapter);

  assert.ok(list);
  assert.deepEqual(entityPoints(list, "uneven-span"), [10, 10, 20, 20]);
});

test("legacy v1 bridges unresolved time points but ordinal and stroke schemas expose gaps", () => {
  const entity = createDrawingEntity({
    id: "v1", kind: "freehand",
    geometry: { kind: "freehand", dataPoints: [
      { time: 10, price: 10 },
      { time: 15, price: 11 },
      { time: 20, price: 13 },
      { time: 25, price: 25 },
      { time: 30, price: 30 },
    ] },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "v1-gap-mode", entities: [entity] });
  const timeList = project(document, createFrame(), createAdapter({ gapPrice: 13 }));
  assert.ok(timeList);
  assert.deepEqual(entityPoints(timeList, "v1"), [
    10, 10, 15, 11, 25, 25, 30, 30,
  ]);
  assert.equal(timeList.entities[0]?.pathBreakCount, 0);
  assert.equal(timeList.entities[0]?.unresolvedGapCount, 0);
  assert.equal(timeList.unresolvedGapCount, 0);

  const ordinalList = project(document, createFrame({
    horizontalDomain: "logical",
    minHorizontal: 0,
    maxHorizontal: 100,
  }), createAdapter({ gapPrice: 13 }));
  assert.ok(ordinalList);
  assert.deepEqual(entityPoints(ordinalList, "v1"), [
    10, 10, 15, 11, Number.NaN, Number.NaN, 25, 25, 30, 30,
  ]);
  assert.deepEqual([...ordinalList.pathBreaks], [2]);
  assert.deepEqual([...ordinalList.unresolvedSourcePointIndexes], [2]);
  assert.equal(ordinalList.entities[0]?.unresolvedGapCount, 1);
});

test("freehand singleton paths separated by unresolved gaps are not visible", () => {
  const freehand = createDrawingEntity({
    id: "singletons",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [
        { time: 10, price: 10 },
        { time: 20, price: 13 },
        { time: 30, price: 30 },
      ],
    },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "singleton-paths", entities: [freehand] });
  const list = project(
    document,
    createFrame({ horizontalDomain: "logical" }),
    createAdapter({ gapPrice: 13 }),
  );

  assert.ok(list);
  assert.deepEqual(list.entities, []);
});

test("disconnected freehand paths outside opposite pane edges do not invent a visible bridge bbox", () => {
  const freehand = createDrawingEntity({
    id: "opposite-offscreen",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [
        { time: -20, price: 10 },
        { time: -10, price: 20 },
        { time: 0, price: 13 },
        { time: 110, price: 10 },
        { time: 120, price: 20 },
      ],
    },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "opposite-offscreen", entities: [freehand] });
  const list = project(
    document,
    createFrame({
      width: 100,
      height: 100,
      horizontalDomain: "logical",
      minHorizontal: 0,
      maxHorizontal: 100,
    }),
    createAdapter({ gapPrice: 13 }),
  );

  assert.ok(list);
  assert.deepEqual(list.entities, []);
});

test("freehand bboxes clip each segment so offscreen Y extrema cannot pollute the pane", () => {
  const freehand = createDrawingEntity({
    id: "offscreen-y-extrema",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [
        { time: -100, price: 1_000 },
        { time: -50, price: 1_000 },
        { time: -10, price: 50 },
        { time: 10, price: 50 },
        { time: 20, price: 60 },
      ],
    },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({ scopeKey: "segment-clipping", entities: [freehand] });
  const list = project(
    document,
    createFrame({
      width: 100,
      height: 100,
      minHorizontal: 0,
      maxHorizontal: 100,
      minPrice: 0,
      maxPrice: 100,
    }),
    createAdapter(),
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [freehand.id]);
  assert.deepEqual(Array.from(list.bboxes), [0, 50, 20, 60]);
});

test("raw midpoint-quadratic visibility retains a curve that enters between offscreen chords", () => {
  const freehand = createDrawingEntity({
    id: "quadratic-corner-entry",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [
        { time: 100, price: -10 },
        { time: -10, price: -10 },
        { time: -10, price: 100 },
      ],
    },
    style: { kind: "freehand", lineWidth: 2 },
  });
  const document = createDrawingDocument({
    scopeKey: "quadratic-corner-entry",
    entities: [freehand],
  });
  const list = project(
    document,
    createFrame({ width: 100, height: 100 }),
    createAdapter(),
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [freehand.id]);
  assert.equal(list.entities[0]?.renderSpec?.op, "freehand");
  assert.equal(
    list.entities[0]?.renderSpec?.op === "freehand"
      ? list.entities[0].renderSpec.pathInterpolation
      : null,
    "quadratic",
  );
  assert.equal(Number(list.bboxes[0]), 0);
  assert.equal(Number(list.bboxes[1]), 0);
  assert.ok(Number(list.bboxes[2]) > 0);
  assert.ok(Number(list.bboxes[3]) > 0);
});

test("selected square-brush diagonal caps retain their sqrt(2) pane-edge extent", () => {
  const freehand = createDrawingEntity({
    id: "square-cap-edge",
    kind: "highlighter",
    geometry: {
      kind: "highlighter",
      dataPoints: [
        { time: -16.5, price: 40 },
        { time: -6.5, price: 50 },
      ],
    },
    style: { kind: "highlighter", lineWidth: 10, brushShape: "square" },
  });
  const document = createDrawingDocument({
    scopeKey: "square-cap-edge",
    entities: [freehand],
  });
  const list = project(
    document,
    createFrame({ width: 100, height: 100 }),
    createAdapter(),
    registryNodes(document),
    freehand.id,
  );

  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), [freehand.id]);
  const displayEntity = list.entities[0];
  assert.equal(displayEntity?.renderSpec?.op, "freehand");
  assert.equal(
    displayEntity?.renderSpec?.op === "freehand" ? displayEntity.renderSpec.selected : null,
    true,
  );
  assert.equal(Number(list.bboxes[0]), 0);
  assert.ok(Number(list.bboxes[2]) > 0);
});

test("screen-culls far candidates but retains pixel boxes extending into the pane", () => {
  const farLine = createDrawingEntity({
    id: "far", kind: "line",
    geometry: { kind: "line", dataPoints: [
      { time: 500, price: 50 }, { time: 600, price: 50 },
    ] },
    style: { kind: "line", lineWidth: 2 },
  });
  const edgeText = createDrawingEntity({
    id: "edge-text", kind: "text",
    geometry: { kind: "text", dataPoint: { time: -20, price: 20 } },
    style: { kind: "text", text: "extends inside", fontSize: 12, padding: 4 },
  });
  const document = createDrawingDocument({
    scopeKey: "screen-cull",
    entities: [farLine, edgeText],
  });
  const list = project(document, createFrame({ width: 100, height: 100 }), createAdapter());
  assert.ok(list);
  assert.deepEqual(list.entities.map((entity) => entity.id), ["edge-text"]);
  assert.equal(list.bboxes[0], 0);
  assert.ok(Number(list.bboxes[2]) > 0);
});

test("projected zones return exact legacy endpoint, body, and selected-handle hits", () => {
  const line = createDrawingEntity({
    id: "line", kind: "line",
    geometry: { kind: "line", dataPoints: [
      { time: 10, price: 10 }, { time: 80, price: 10 },
    ] },
    style: { kind: "line", lineWidth: 2 },
  });
  const lineDocument = createDrawingDocument({ scopeKey: "line-hit", entities: [line] });
  const frame = createFrame({ width: 100, height: 100 });
  const lineList = project(lineDocument, frame, createAdapter());
  assert.ok(lineList);
  assert.deepEqual(hitTestDrawingScreenDisplayList(lineList, 10, 10), {
    entityId: "line", kind: "line", pointIndex: 0,
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(lineList, 50, 10), {
    entityId: "line", kind: "line", pointIndex: -1,
  });

  const shape = createDrawingEntity({
    id: "shape", kind: "shape",
    geometry: { kind: "shape", shapeType: "rectangle", dataPoints: [
      { time: 20, price: 20 }, { time: 80, price: 80 },
    ] },
    style: { kind: "shape", lineWidth: 2 },
  });
  const shapeDocument = createDrawingDocument({ scopeKey: "shape-hit", entities: [shape] });
  const shapeList = project(
    shapeDocument,
    frame,
    createAdapter(),
    registryNodes(shapeDocument),
    "shape",
  );
  assert.ok(shapeList);
  assert.deepEqual(hitTestDrawingScreenDisplayList(shapeList, 20, 20, "shape"), {
    entityId: "shape",
    kind: "shape",
    zone: "tl",
    handle: "tl",
    pointIndex: -1,
  });

  const angle = createDrawingEntity({
    id: "angle", kind: "angle-measure",
    geometry: { kind: "angle-measure", dataPoints: [
      { time: 50, price: 50 }, { time: 50, price: 150 },
    ] },
    style: { kind: "angle-measure", lineWidth: 2 },
  });
  const angleDocument = createDrawingDocument({ scopeKey: "angle-hit", entities: [angle] });
  const angleList = project(angleDocument, createFrame(), createAdapter());
  assert.ok(angleList);
  const arcCoordinate = 50 + Math.cos(Math.PI / 4) * 28;
  assert.deepEqual(hitTestDrawingScreenDisplayList(angleList, arcCoordinate, arcCoordinate), {
    entityId: "angle",
    kind: "angle-measure",
    pointIndex: -1,
    zone: "arc",
  });

  const ellipse = createDrawingEntity({
    id: "ellipse", kind: "shape",
    geometry: { kind: "shape", shapeType: "ellipse", dataPoints: [
      { time: 20, price: 20 }, { time: 80, price: 60 },
    ] },
    style: { kind: "shape", lineWidth: 2 },
  });
  const ellipseDocument = createDrawingDocument({ scopeKey: "ellipse-hit", entities: [ellipse] });
  const ellipseList = project(ellipseDocument, frame, createAdapter());
  assert.ok(ellipseList);
  assert.deepEqual(hitTestDrawingScreenDisplayList(ellipseList, 50, 40), {
    entityId: "ellipse", kind: "shape", zone: "body", pointIndex: -1,
  });
  assert.equal(hitTestDrawingScreenDisplayList(ellipseList, 20, 20), null);
});

test("position panel and badges measure current-price and PnL text from the atomic frame", () => {
  const position = createDrawingEntity({
    id: "position-panel",
    kind: "position",
    geometry: {
      kind: "position",
      direction: "long",
      entryPrice: 60,
      tpPrice: 80,
      slPrice: 40,
      timeRange: { start: { time: 40 }, end: { time: 80 } },
    },
    style: {
      kind: "position",
      positionSize: 1_000,
      infoPanelOffset: { x: 0, y: 0 },
    },
  });
  const document = createDrawingDocument({ scopeKey: "position-panel", entities: [position] });
  const measured: string[] = [];
  const adapter = createAdapter();
  adapter.measureText = (request) => {
    measured.push(request.text);
    return request.text.length * 7;
  };
  const list = project(document, createFrame({
    seriesData: [{ time: 1, close: 70 }],
  }), adapter);

  assert.ok(list);
  assert.deepEqual(measured, [
    "入场: 60.0000",
    "止盈: 80.0000 (+33.33%) +333.33",
    "止损: 40.0000 (-33.33%) -333.33",
    "现价: 70.0000 (+16.67%) +166.67",
    "盈亏比: 1 : 1.00",
    "仓位: $1000",
    "80.0000  +33.33%  +333.33",
    "40.0000  -33.33%  -333.33",
  ]);
  assert.deepEqual([...list.handles], [60, 60, 60, 80, 60, 40, 40, 60, 80, 60]);
  assert.deepEqual(list.entities[0]?.handleNames, ["entry", "tp", "sl", "left", "right"]);
});
