import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingFrameSnapshotFactory } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "../../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
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
  projectDrawingScene,
  projectDrawingSceneCanonicalGapIndexes,
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
  width = 200,
  height = 200,
  barSpacing = 12,
  horizontalDomain = "time",
  minHorizontal = 0,
  maxHorizontal = width,
  minPrice = 0,
  maxPrice = height,
  seriesData = [],
}: {
  width?: number;
  height?: number;
  barSpacing?: number;
  horizontalDomain?: "logical" | "time";
  minHorizontal?: number;
  maxHorizontal?: number;
  minPrice?: number;
  maxPrice?: number;
  seriesData?: DrawingFrameSnapshot["seriesData"];
} = {}): DrawingFrameSnapshot {
  return createDrawingFrameSnapshotFactory().capture({
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
    },
    heightCssPx: height,
    projectionKey: "test-projection",
    seriesData,
    surfaceToken: "surface",
    themeKey: "dark",
    viewportKey: `${horizontalDomain}:${minHorizontal}:${maxHorizontal}`,
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
): DrawingScreenDisplayList | null {
  return projectDrawingScene({
    adapter,
    document,
    frame,
    nodes,
    selectedId,
    stamp: stampFor(document, frame),
  });
}

function entityPoints(list: DrawingScreenDisplayList, id: string): number[] {
  const entity = list.entities.find((candidate) => candidate.id === id);
  assert.ok(entity);
  const start = entity.pointOffset * 2;
  return Array.from(list.points.slice(start, start + entity.pointCount * 2));
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
  assert.deepEqual(list.entities.map((entity) => entity.handleCount), [8, 2, 2, 1, 8, 2, 2, 0, 0]);
  assert.equal(adapter.spanInputs.length, 1);
  assert.equal(list.entities.find((entity) => entity.id === "axis")?.unboundedAxis, "horizontal");
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
  const adapter = createAdapter({ gapPrice: 13 });
  const list = project(document, frame, adapter);
  assert.ok(list);
  assert.equal(list.entities[0]?.pointCount, 129);
  const projected = entityPoints(list, "long");
  assert.equal(projected[0], 127);
  assert.equal(projected.at(-2), 255);
  assert.deepEqual([...list.pathBreaks], [3]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [130]);
  assert.equal(list.entities[0]?.canonicalGapCoverageComplete, false);
  assert.equal(Math.max(...adapter.batchSizes), 129);
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

test("position panel measures the legacy current-price and PnL lines from the atomic frame", () => {
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
  ]);
  assert.deepEqual([...list.handles], [40, 60, 80, 60]);
  assert.deepEqual(list.entities[0]?.handleNames, ["left", "right"]);
});
