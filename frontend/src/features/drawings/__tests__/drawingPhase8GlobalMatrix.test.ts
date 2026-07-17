import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDrawingFrameSnapshotFactory,
} from "../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  DrawingFrameSnapshot,
} from "../../../chart-adapter/drawingFrameSnapshot.js";
import type {
  CoordinateDataPoint,
  SourceLineageSpanInput,
} from "../../../chart-adapter/coordinateBridge.js";
import {
  applyDrawingCommands,
} from "../core/drawingCommands.js";
import {
  exportDrawingDocument,
  importSavedDrawings,
} from "../core/drawingCodec.js";
import {
  createDrawingDocument,
} from "../core/drawingDocument.js";
import type {
  DrawingDocument,
} from "../core/drawingDocument.js";
import {
  drawingCommandsForSavedDrawing,
} from "../core/drawingDocumentRuntime.js";
import {
  createDrawingDocumentStore,
} from "../core/drawingDocumentStore.js";
import type {
  DrawingDragDescriptor,
} from "../drawingDragResizeController.js";
import {
  normalizeSavedDrawingItemStrict,
} from "../drawingPersistence.js";
import type {
  DrawingDataPoint,
  DrawingKind,
  FreehandStrokeV3,
  SavedDrawing,
  ScreenBox,
  ScreenPoint,
} from "../drawingTypes.js";
import {
  createDrawingSceneRuntime,
} from "../engine/drawingSceneRuntime.js";
import type {
  DrawingSceneFrameAdapter,
} from "../engine/drawingSceneRuntime.js";
import type {
  DrawingRenderRevisionStamp,
} from "../engine/drawingRenderScheduler.js";
import {
  projectDrawingScene,
} from "../engine/drawingSceneProjector.js";
import type {
  DrawingSceneProjectionAdapter,
  DrawingSceneTextMeasureRequest,
} from "../engine/drawingSceneProjector.js";
import {
  createDrawingSceneRegistry,
} from "../engine/drawingSceneRegistry.js";
import {
  createDrawingHitIndex,
  hitTestDrawingHitIndex,
} from "../geometry/drawingHitIndex.js";
import {
  createAxisLineSavedDrawing,
  createFinalizedFreehandSavedDrawing,
  createPositionSavedDrawing,
  createTextSavedDrawing,
  createTwoPointSavedDrawing,
  drawingCreateCommandsForSavedDrawing,
} from "../interaction/drawingEntityCreation.js";
import {
  applyDrawingEntityDrag,
  drawingEntityGeometryCommandForDrag,
} from "../interaction/drawingEntityDrag.js";
import {
  drawingEntityHitFromDisplay,
} from "../interaction/drawingEntityHit.js";
import type {
  DrawingEntityHit,
} from "../interaction/drawingEntityHit.js";
import type {
  DrawingDisplayHitResult,
  DrawingDisplayRenderSpec,
  DrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";
import {
  createDrawingDocumentSceneRegistry,
} from "../rendering/drawingDocumentSceneRegistry.js";

type CreatedDrawing = SavedDrawing & Readonly<{ id: string }>;

interface Phase8MatrixRow {
  readonly create: () => CreatedDrawing | null;
  readonly draggable: boolean;
  readonly kind: DrawingKind;
  readonly renderOp: DrawingDisplayRenderSpec["op"];
}

const SOURCE_PROJECTION = "renko";
const SOURCE_PROJECTION_CONFIG = "phase8-matrix:renko:10";
const DERIVED_ANCHOR = Object.freeze({
  time: 30,
  sourceOrdinal: 2,
  sourceProjection: SOURCE_PROJECTION,
  sourceProjectionConfig: SOURCE_PROJECTION_CONFIG,
});
const SOURCE_POINT = Object.freeze({ time: 50, price: 55 });
const DERIVED_POINT = Object.freeze({ ...DERIVED_ANCHOR, price: 75 });
const FUTURE_POINT = Object.freeze({ time: 180, price: 95 });

function finalizedStroke(): FreehandStrokeV3 {
  return {
    version: 3,
    sourceProjection: SOURCE_PROJECTION,
    sourceProjectionConfig: SOURCE_PROJECTION_CONFIG,
    spans: [],
    points: [
      { anchor: { time: 30, sourceOrdinal: 2 }, price: 120 },
      { time: 180, price: 125 },
    ],
  };
}

/**
 * Audit table: adding a DrawingKind requires an explicit creation, render, and
 * interaction decision here. Freehand/highlighter intentionally have no move
 * descriptor; they still traverse strict creation, document, scene, and hit.
 */
const PHASE8_TOOL_MATRIX: readonly Phase8MatrixRow[] = Object.freeze([
  {
    kind: "line",
    renderOp: "line",
    draggable: true,
    create: () => createTwoPointSavedDrawing({
      tool: "line-segment",
      dataPoints: [SOURCE_POINT, DERIVED_POINT],
      color: "#60a5fa",
      lineWidth: 2,
    }),
  },
  {
    kind: "axis-line",
    renderOp: "axis-line",
    draggable: true,
    create: () => createAxisLineSavedDrawing({
      tool: "line-cross",
      dataPoint: DERIVED_POINT,
      color: "#f8fafc",
      lineWidth: 1,
    }),
  },
  {
    kind: "angle-measure",
    renderOp: "angle",
    draggable: true,
    create: () => createTwoPointSavedDrawing({
      tool: "angle-measure",
      dataPoints: [SOURCE_POINT, FUTURE_POINT],
      color: "#34d399",
      lineWidth: 2,
    }),
  },
  {
    kind: "fibonacci",
    renderOp: "fibonacci",
    draggable: true,
    create: () => createTwoPointSavedDrawing({
      tool: "fibonacci",
      dataPoints: [DERIVED_POINT, FUTURE_POINT],
      color: "#f59e0b",
      lineWidth: 1.5,
      fibLevels: [
        { level: 0, color: "#f8fafc", enabled: true },
        { level: 0.618, color: "#f59e0b", enabled: true },
        { level: 1, color: "#f8fafc", enabled: true },
      ],
    }),
  },
  {
    kind: "text",
    renderOp: "text",
    draggable: true,
    create: () => createTextSavedDrawing({
      dataPoint: SOURCE_POINT,
      text: "Phase 8 九类矩阵",
      color: "#f8fafc",
      fontFamily: "Inter",
      fontSize: 16,
      widthPx: 120,
    }),
  },
  {
    kind: "position",
    renderOp: "position",
    draggable: true,
    create: () => createPositionSavedDrawing({
      tool: "position-long",
      dataPoint: { time: 90, price: 100 },
      timeRange: {
        start: DERIVED_ANCHOR,
        end: { time: 180 },
      },
      visiblePriceRange: 100,
      positionSize: 0,
    }),
  },
  {
    kind: "shape",
    renderOp: "shape",
    draggable: true,
    create: () => createTwoPointSavedDrawing({
      tool: "shape-rectangle",
      dataPoints: [{ time: 70, price: 135 }, { time: 145, price: 185 }],
      color: "#c084fc",
      lineWidth: 2,
      lineStyle: "dashed",
    }),
  },
  {
    kind: "freehand",
    renderOp: "freehand",
    draggable: false,
    create: () => createFinalizedFreehandSavedDrawing({
      tool: "pen",
      stroke: finalizedStroke(),
      color: "#38bdf8",
      lineWidth: 3,
    }),
  },
  {
    kind: "highlighter",
    renderOp: "freehand",
    draggable: false,
    create: () => createFinalizedFreehandSavedDrawing({
      tool: "highlighter",
      stroke: finalizedStroke(),
      color: "#fde047",
      lineWidth: 12,
    }),
  },
]);

function mustCreate(row: Phase8MatrixRow): CreatedDrawing {
  const drawing = row.create();
  assert.ok(drawing, `${row.kind} strict creation`);
  assert.equal(drawing.type, row.kind);
  assert.equal(typeof drawing.id, "string");
  assert.ok(drawing.id.length > 0);
  return drawing;
}

function createFrame(): DrawingFrameSnapshot {
  return createDrawingFrameSnapshotFactory().capture({
    axisKind: "time",
    barSpacing: 8,
    coordinateKey: "phase8-matrix-coordinate",
    dpr: 1.5,
    drawingViewport: {
      horizontalDomain: "time",
      minHorizontal: 0,
      maxHorizontal: 240,
      minPrice: 0,
      maxPrice: 240,
    },
    heightCssPx: 240,
    projectionKey: "phase8-matrix-projection",
    seriesData: [],
    surfaceToken: "phase8-matrix-surface",
    themeKey: "phase8-matrix-theme",
    themePalette: { upColor: "#22c55e", downColor: "#ef4444" },
    viewportKey: "phase8-matrix-viewport",
    widthCssPx: 240,
  });
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function horizontalCoordinate(point: Readonly<Record<string, unknown>>): number | null {
  if (finite(point.sourceOrdinal)) return 20 + point.sourceOrdinal * 20;
  if (finite(point.logical)) return point.logical;
  return finite(point.time) ? point.time : null;
}

const projectionAdapter: DrawingSceneProjectionAdapter = Object.freeze({
  measureText(request: DrawingSceneTextMeasureRequest) {
    return [...request.text].length * request.fontSize * 0.55;
  },
  projectDrawingFrameDataPoints(
    _frame: DrawingFrameSnapshot,
    points: readonly CoordinateDataPoint[],
  ) {
    const projected = new Float64Array(points.length * 2);
    projected.fill(Number.NaN);
    points.forEach((point, index) => {
      const x = horizontalCoordinate(point);
      if (x !== null) projected[index * 2] = x;
      if (finite(point.price)) projected[index * 2 + 1] = point.price;
    });
    return projected;
  },
  projectDrawingFrameSourceLineageSpan(
    _frame: DrawingFrameSnapshot,
    span: SourceLineageSpanInput,
  ) {
    const left = span.exact?.left
      ? horizontalCoordinate(span.exact.left)
      : null;
    const right = span.exact?.right
      ? horizontalCoordinate(span.exact.right)
      : null;
    return left !== null && right !== null && left < right
      ? Object.freeze({ left, right })
      : null;
  },
});

function stampFor(
  document: DrawingDocument,
  frame: DrawingFrameSnapshot,
): DrawingRenderRevisionStamp {
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

function projectDocument(
  document: DrawingDocument,
  selectedId: string | null,
  frame = createFrame(),
): DrawingScreenDisplayList {
  const registry = createDrawingSceneRegistry(document.scopeKey);
  const reconciled = registry.reconcile(document);
  assert.equal(reconciled.ok, true);
  const displayList = projectDrawingScene({
    document,
    selectedId,
    frame,
    adapter: projectionAdapter,
    nodes: registry.getSnapshot().nodes,
    stamp: stampFor(document, frame),
    lodToleranceClass: "settledExact",
  });
  assert.ok(displayList);
  return displayList;
}

function screenBox(
  bbox: readonly [number, number, number, number] | null,
): ScreenBox | null {
  if (!bbox) return null;
  const [left, top, right, bottom] = bbox;
  if (![left, top, right, bottom].every(finite) || right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    right,
    bottom,
  };
}

function displayEntityBox(
  list: DrawingScreenDisplayList,
  entityId: string,
): ScreenBox | null {
  const entityIndex = list.entities.findIndex((entity) => entity.id === entityId);
  if (entityIndex < 0) return null;
  const offset = entityIndex * 4;
  return screenBox([
    Number(list.bboxes[offset]),
    Number(list.bboxes[offset + 1]),
    Number(list.bboxes[offset + 2]),
    Number(list.bboxes[offset + 3]),
  ]);
}

function pointAt(values: Float64Array, pointIndex: number): ScreenPoint | null {
  const x = values[pointIndex * 2];
  const y = values[pointIndex * 2 + 1];
  return finite(x) && finite(y) ? { x, y } : null;
}

interface MatrixHitProbe {
  readonly hit: DrawingDisplayHitResult;
  readonly point: ScreenPoint;
}

function hitProbe(
  list: DrawingScreenDisplayList,
  drawing: CreatedDrawing,
): MatrixHitProbe {
  const entity = list.entities.find((candidate) => candidate.id === drawing.id);
  assert.ok(entity, `${drawing.type} display entity`);
  const candidates: ScreenPoint[] = [];
  const bbox = displayEntityBox(list, drawing.id);

  // Prefer production-relevant zones: text body, shape resize handle, position
  // entry, and endpoint/body samples for all remaining kinds.
  if (drawing.type === "text" && bbox) {
    candidates.push({ x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 });
  } else if (drawing.type === "shape") {
    const handle = pointAt(list.handles, entity.handleOffset);
    if (handle) candidates.push(handle);
  } else if (drawing.type === "freehand" || drawing.type === "highlighter") {
    const first = pointAt(list.points, entity.pointOffset);
    const second = pointAt(list.points, entity.pointOffset + 1);
    if (first && second) {
      candidates.push({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
    }
  } else {
    const handle = pointAt(list.handles, entity.handleOffset);
    if (handle) candidates.push(handle);
  }

  for (let index = 0; index < entity.handleCount; index += 1) {
    const handle = pointAt(list.handles, entity.handleOffset + index);
    if (handle) candidates.push(handle);
  }
  for (let index = 0; index < entity.pointCount; index += 1) {
    const point = pointAt(list.points, entity.pointOffset + index);
    if (point) candidates.push(point);
    if (index + 1 < entity.pointCount) {
      const next = pointAt(list.points, entity.pointOffset + index + 1);
      if (point && next) {
        candidates.push({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 });
      }
    }
  }
  if (bbox) {
    candidates.push(
      { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 },
      { x: bbox.x, y: bbox.y },
      { x: bbox.right ?? bbox.x + bbox.width, y: bbox.bottom ?? bbox.y + bbox.height },
    );
  }

  const index = createDrawingHitIndex(list);
  for (const point of candidates) {
    const hit = hitTestDrawingHitIndex(index, point.x, point.y, drawing.id);
    if (hit?.entityId === drawing.id) return { hit, point };
  }
  assert.fail(`${drawing.type} must expose a scene hit zone`);
}

function dragDescriptor(
  drawing: CreatedDrawing,
  hit: DrawingEntityHit,
  startMouse: ScreenPoint,
  box: ScreenBox | null,
): DrawingDragDescriptor | null {
  switch (drawing.type) {
    case "line":
      return drawing.dataPoints?.length
        ? {
            id: drawing.id,
            type: "line",
            pointIndex: hit.pointIndex ?? -1,
            startMouse,
            origPoints: drawing.dataPoints.map((point) => ({ ...point })),
          }
        : null;
    case "angle-measure":
      return drawing.dataPoints?.length
        ? {
            id: drawing.id,
            type: "angle",
            pointIndex: hit.pointIndex ?? -1,
            startMouse,
            origPoints: drawing.dataPoints.map((point) => ({ ...point })),
          }
        : null;
    case "fibonacci":
      return drawing.dataPoints?.length
        ? {
            id: drawing.id,
            type: "fibonacci",
            pointIndex: hit.pointIndex ?? -1,
            startMouse,
            origPoints: drawing.dataPoints.map((point) => ({ ...point })),
          }
        : null;
    case "axis-line":
      return drawing.dataPoint
        ? {
            id: drawing.id,
            type: "axis-line",
            zone: hit.zone ?? "body",
            startMouse,
            origDataPoint: { ...drawing.dataPoint },
          }
        : null;
    case "shape":
      return drawing.dataPoints?.length
        ? {
            id: drawing.id,
            type: "shape",
            zone: hit.zone ?? "body",
            startMouse,
            origPoints: drawing.dataPoints.map((point) => ({ ...point })),
            origBox: box,
          }
        : null;
    case "text":
      if (!drawing.dataPoint) return null;
      return hit.handle && box
        ? {
            id: drawing.id,
            type: "text-handle",
            handle: hit.handle,
            startMouse,
            origBox: box,
            origFontSize: drawing.fontSize ?? 14,
            origWidthPx: drawing.widthPx ?? null,
            origDataPoint: { ...drawing.dataPoint },
          }
        : {
            id: drawing.id,
            type: "text",
            startMouse,
            origDataPoint: { ...drawing.dataPoint },
          };
    case "position": {
      if (!drawing.timeRange || !finite(drawing.entryPrice)) return null;
      if (hit.zone === "tp") {
        return {
          id: drawing.id,
          type: "position-tp",
          startMouse,
          origTpPrice: drawing.tpPrice ?? null,
        };
      }
      if (hit.zone === "sl") {
        return {
          id: drawing.id,
          type: "position-sl",
          startMouse,
          origSlPrice: drawing.slPrice ?? null,
        };
      }
      if (hit.zone === "panel") {
        return {
          id: drawing.id,
          type: "position-panel",
          startMouse,
          origInfoPanelOffset: { ...(drawing.infoPanelOffset ?? { x: 10, y: 10 }) },
        };
      }
      if (hit.zone === "left" || hit.zone === "right") {
        return {
          id: drawing.id,
          type: hit.zone === "left" ? "position-left" : "position-right",
          startMouse,
          origTimeRange: { ...drawing.timeRange },
        };
      }
      return {
        id: drawing.id,
        type: "position-move",
        startMouse,
        origEntry: drawing.entryPrice,
        origTp: drawing.tpPrice ?? null,
        origSl: drawing.slPrice ?? null,
        origTimeRange: { ...drawing.timeRange },
      };
    }
    case "freehand":
    case "highlighter":
      return null;
  }
}

function dataToScreen(point: DrawingDataPoint): ScreenPoint | null {
  const x = horizontalCoordinate(point);
  return x === null || !finite(point.price) ? null : { x, y: point.price };
}

function displayListEntityCount(list: DrawingScreenDisplayList | null): number | null {
  return list === null ? null : list.entities.length;
}

test("Phase 8 global matrix: nine SavedDrawing kinds cross document, scene, hit, and entity interaction", async (context) => {
  assert.deepEqual(
    PHASE8_TOOL_MATRIX.map((row) => row.kind),
    [
      "line",
      "axis-line",
      "angle-measure",
      "fibonacci",
      "text",
      "position",
      "shape",
      "freehand",
      "highlighter",
    ],
  );

  const creationSource = readFileSync(
    new URL("../interaction/drawingEntityCreation.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(creationSource, /drawingPrimitiveFactory|\/primitives\/|new\s+\w*Primitive/);

  let accumulated = createDrawingDocument({ scopeKey: "phase8-global-matrix" });
  const drawings: CreatedDrawing[] = [];

  for (const row of PHASE8_TOOL_MATRIX) {
    await context.test(`${row.kind}: strict create -> codec -> scene -> hit${row.draggable ? " -> drag -> update" : ""}`, () => {
      const drawing = mustCreate(row);
      const normalized = normalizeSavedDrawingItemStrict(drawing);
      assert.deepEqual(normalized, drawing);
      assert.equal(Object.values(drawing).some((value) => typeof value === "function"), false);
      assert.equal("setHidden" in drawing, false);
      assert.equal("updateAllViews" in drawing, false);

      const createCommands = drawingCreateCommandsForSavedDrawing(drawing);
      assert.ok(createCommands);
      assert.equal(createCommands.length, 1);
      assert.equal(createCommands[0]?.type, "create");
      const accumulatedResult = applyDrawingCommands(accumulated, createCommands);
      assert.equal(accumulatedResult.ok, true);
      if (!accumulatedResult.ok) return;
      accumulated = accumulatedResult.document;
      drawings.push(drawing);

      const singleDocument = importSavedDrawings(`phase8-matrix:${row.kind}`, [drawing]);
      assert.ok(singleDocument);
      const displayList = projectDocument(singleDocument, drawing.id);
      assert.equal(displayList.entities.length, 1);
      assert.equal(displayList.entities[0]?.kind, row.kind);
      assert.equal(displayList.entities[0]?.renderSpec?.op, row.renderOp);

      const probe = hitProbe(displayList, drawing);
      const entityHit = drawingEntityHitFromDisplay([drawing], probe.hit);
      assert.ok(entityHit);
      assert.equal(entityHit.id, drawing.id);
      assert.strictEqual(entityHit.saved, drawing);

      const descriptor = dragDescriptor(
        drawing,
        entityHit,
        probe.point,
        displayEntityBox(displayList, drawing.id),
      );
      assert.equal(descriptor !== null, row.draggable);
      if (!descriptor) return;

      const dragged = applyDrawingEntityDrag({
        descriptor,
        drawing,
        pos: { x: probe.point.x + 11, y: probe.point.y + 7 },
        screenToData: (x, y) => ({ time: x, price: y }),
        screenToDrawingData: (x, y) => ({ time: x, price: y }),
        dataToScreen,
        snap: false,
      });
      assert.ok(dragged, `${row.kind} entity drag must produce a canonical draft`);
      assert.notStrictEqual(dragged, drawing);
      assert.equal(Object.isFrozen(dragged), true);

      const geometryCommand = drawingEntityGeometryCommandForDrag(descriptor);
      const updateCommands = drawingCommandsForSavedDrawing(dragged, { type: geometryCommand });
      assert.ok(updateCommands);
      assert.equal(updateCommands.length, 1);
      assert.equal(updateCommands[0]?.type, geometryCommand);
      const updateResult = applyDrawingCommands(singleDocument, updateCommands);
      assert.equal(updateResult.ok, true);
      if (!updateResult.ok) return;
      assert.deepEqual(exportDrawingDocument(updateResult.document), [dragged]);
    });
  }

  assert.equal(accumulated.entities.size, PHASE8_TOOL_MATRIX.length);
  assert.deepEqual(accumulated.zOrder, drawings.map((drawing) => drawing.id));
  assert.deepEqual(exportDrawingDocument(accumulated), drawings);
});

test("Phase 8 global matrix: reload and hidden/clear/recreate keep document-only scene ownership", () => {
  const drawings = PHASE8_TOOL_MATRIX.map(mustCreate);
  const imported = importSavedDrawings("phase8-global-lifecycle", drawings);
  assert.ok(imported);
  const serialized = JSON.stringify(exportDrawingDocument(imported));
  const reloaded = importSavedDrawings(
    "phase8-global-lifecycle",
    JSON.parse(serialized) as unknown,
  );
  assert.ok(reloaded);
  assert.deepEqual(exportDrawingDocument(reloaded), drawings);

  const store = createDrawingDocumentStore(reloaded);
  const renderer = createDrawingDocumentSceneRegistry();
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  assert.deepEqual(renderer.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 9,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: false,
  });
  assert.deepEqual(renderer.snapshot(), []);
  assert.equal(renderer.attachedCount(), 0);

  const frame = createFrame();
  const listeners = new Set<(reason?: "manual" | "viewport") => void>();
  const adapter: DrawingSceneFrameAdapter = {
    ...projectionAdapter,
    captureDrawingFrame: () => frame,
    isDrawingFrameCurrent: (candidate) => candidate === frame,
    subscribeDrawingFrameInvalidation(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  let published: DrawingScreenDisplayList | null = null;
  let clearCount = 0;
  const runtime = createDrawingSceneRuntime({
    mode: "scene-canary",
    rasterBackend: "main-thread",
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  const binding = {
    adapter,
    renderer,
    store,
    projectScene: projectDrawingScene,
    publishScene(plan: DrawingScreenDisplayList) {
      published = plan;
      return true;
    },
    clearScene() {
      clearCount += 1;
      published = null;
    },
  };

  assert.equal(runtime.activate(binding), true);
  assert.equal(runtime.flushNow(), true);
  assert.equal(displayListEntityCount(published), 9);
  assert.equal(runtime.snapshot().hitIndex?.list.entities.length, 9);

  // Hidden uses the same synchronous suspend seam as the lifecycle hook: the
  // public plan/hit index disappear, while the canonical document survives.
  runtime.suspend();
  assert.equal(clearCount, 1);
  assert.equal(published, null);
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(runtime.snapshot().hitIndex, null);
  assert.strictEqual(renderer.documentSnapshot(), store.getSnapshot());

  // A chart surface can detach/rebind and reactivate the one composite scene
  // without recreating any of the nine per-drawing legacy objects.
  assert.equal(renderer.detachSurface(), true);
  assert.equal(renderer.rebindSurface(), true);
  assert.equal(runtime.activate(binding), true);
  assert.equal(runtime.flushNow(), true);
  assert.equal(displayListEntityCount(published), 9);
  assert.deepEqual(renderer.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 9,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: false,
  });

  const cleared = store.dispatch({ type: "clear" });
  assert.equal(cleared.ok, true);
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  runtime.invalidate("phase8-matrix-clear");
  assert.equal(runtime.flushNow(), true);
  assert.equal(store.getSnapshot().entities.size, 0);
  assert.equal(displayListEntityCount(published), 0);
  assert.equal(runtime.snapshot().hitIndex?.list.entities.length, 0);
  assert.deepEqual(renderer.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 0,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: false,
  });

  runtime.dispose();
  renderer.dispose();
});
