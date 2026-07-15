import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingDocument,
  createDrawingEntity,
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../../core/drawingDocument.js";
import type {
  DrawingDocument,
  DrawingEntity,
} from "../../core/drawingDocument.js";
import { createDrawingDocumentStore } from "../../core/drawingDocumentStore.js";
import { createDrawingEntityGeometryBounds } from "../../geometry/drawingBounds.js";
import type { DrawingEntityGeometryBounds } from "../../geometry/drawingBounds.js";
import {
  createDrawingSceneRegistry,
  DRAWING_PACKED_BOUND_DEFERRED,
  DRAWING_PACKED_BOUND_UNBOUNDED_HORIZONTAL,
  DRAWING_PACKED_BOUND_UNBOUNDED_VERTICAL,
} from "../drawingSceneRegistry.js";

function lineEntity(id: string, startTime: number, price: number): DrawingEntity {
  return createDrawingEntity({
    id,
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [
        { time: startTime, price },
        { time: startTime + 1, price: price + 1 },
      ],
    },
    style: { kind: "line", color: "#fff", lineWidth: 1 },
  });
}

test("registry incrementally retains node identity and skips bounds work for style-only updates", () => {
  let boundsCalls = 0;
  const registry = createDrawingSceneRegistry("scope-A", {
    createBounds: (entity) => {
      boundsCalls += 1;
      return createDrawingEntityGeometryBounds(entity);
    },
  });
  const initial = createDrawingDocument({
    scopeKey: "scope-A",
    entities: [lineEntity("a", 1, 1), lineEntity("b", 2, 2)],
    zOrder: ["a", "b"],
  });
  const store = createDrawingDocumentStore(initial);
  const first = registry.reconcile(store.getSnapshot());
  assert.equal(first.ok, true);
  assert.equal(boundsCalls, 2);
  const nodeA = registry.getNode("a");
  const nodeB = registry.getNode("b");
  const firstPacked = registry.getSnapshot().packedBounds;
  assert.ok(nodeA);
  assert.ok(nodeB);

  const styled = store.dispatch({ type: "update-style", id: "a", patch: { color: "#f00" } });
  assert.equal(styled.ok, true);
  const styleReconcile = registry.reconcile(store.getSnapshot());
  assert.equal(styleReconcile.ok, true);
  assert.equal(styleReconcile.ok && styleReconcile.recomputedBoundsCount, 0);
  assert.equal(boundsCalls, 2);
  assert.strictEqual(registry.getNode("a"), nodeA);
  assert.strictEqual(registry.getSnapshot().packedBounds, firstPacked);
  assert.equal(registry.getNode("a")?.styleRevision, 2);

  const moved = store.dispatch({
    type: "move",
    id: "a",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 100, price: 100 }, { time: 110, price: 110 }],
    },
  });
  assert.equal(moved.ok, true);
  const moveReconcile = registry.reconcile(store.getSnapshot());
  assert.equal(moveReconcile.ok, true);
  assert.equal(moveReconcile.ok && moveReconcile.recomputedBoundsCount, 1);
  assert.equal(boundsCalls, 3);
  assert.strictEqual(registry.getNode("a"), nodeA);
  assert.notStrictEqual(registry.getSnapshot().packedBounds, firstPacked);

  const reordered = store.dispatch({ type: "reorder", order: ["b", "a"] });
  assert.equal(reordered.ok, true);
  const reorderReconcile = registry.reconcile(store.getSnapshot());
  assert.equal(reorderReconcile.ok, true);
  assert.equal(reorderReconcile.ok && reorderReconcile.reordered, true);
  assert.equal(reorderReconcile.ok && reorderReconcile.recomputedBoundsCount, 0);
  assert.equal(boundsCalls, 3);
  assert.deepEqual(registry.getSnapshot().nodes.map((node) => node.id), ["b", "a"]);
  assert.strictEqual(registry.getNode("a"), nodeA);
  assert.strictEqual(registry.getNode("b"), nodeB);
});

test("registry reports style content changes captured before updating a retained node", () => {
  let boundsCalls = 0;
  const registry = createDrawingSceneRegistry("scope-same-revision", {
    createBounds: (entity) => {
      boundsCalls += 1;
      return createDrawingEntityGeometryBounds(entity);
    },
  });
  const originalEntity = lineEntity("same-id", 1, 1);
  const original = createDrawingDocument({
    scopeKey: "scope-same-revision",
    documentRevision: 7,
    entities: [originalEntity],
  });
  assert.equal(registry.reconcile(original).ok, true);
  const retained = registry.getNode("same-id");
  assert.equal(boundsCalls, 1);

  const styleContentChanged = createDrawingDocument({
    scopeKey: "scope-same-revision",
    documentRevision: 7,
    entities: [createDrawingEntity({
      id: originalEntity.id,
      kind: "line",
      geometryRevision: originalEntity.geometryRevision,
      styleRevision: originalEntity.styleRevision,
      geometry: originalEntity.geometry,
      style: { kind: "line", color: "#f00", lineWidth: 1 },
    })],
  });
  const reconciled = registry.reconcile(styleContentChanged);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.ok && reconciled.changed, true);
  assert.equal(reconciled.ok && reconciled.recomputedBoundsCount, 0);
  assert.equal(boundsCalls, 1);
  assert.strictEqual(registry.getNode("same-id"), retained);
  const currentStyle = registry.getNode("same-id")?.entity.style;
  assert.equal(currentStyle?.kind, "line");
  if (currentStyle?.kind === "line") {
    assert.equal(currentStyle.color, "#f00");
  }
});

test("packed bbox arrays scan sequentially, constrain unbounded axes, dedupe chunks, and preserve z-order", () => {
  const freehandPoints = Array.from({ length: 260 }, (_, index) => ({
    time: 5,
    price: index,
  }));
  const document = createDrawingDocument({
    scopeKey: "scope-packed",
    entities: [
      lineEntity("outside", 100, 100),
      createDrawingEntity({
        id: "horizontal",
        kind: "axis-line",
        geometry: {
          kind: "axis-line",
          axisLineType: "horizontal",
          dataPoint: { time: 1_000, price: 5 },
        },
        style: { kind: "axis-line" },
      }),
      createDrawingEntity({
        id: "vertical",
        kind: "axis-line",
        geometry: {
          kind: "axis-line",
          axisLineType: "vertical",
          dataPoint: { time: 5, price: 1_000 },
        },
        style: { kind: "axis-line" },
      }),
      createDrawingEntity({
        id: "freehand",
        kind: "freehand",
        geometry: { kind: "freehand", dataPoints: freehandPoints },
        style: { kind: "freehand" },
      }),
      createDrawingEntity({
        id: "deferred",
        kind: "text",
        geometry: { kind: "text" },
        style: { kind: "text", text: "pending" },
      }),
    ],
    zOrder: ["outside", "horizontal", "vertical", "freehand", "deferred"],
  });
  const registry = createDrawingSceneRegistry("scope-packed");
  const reconciled = registry.reconcile(document);
  assert.equal(reconciled.ok, true);
  const packed = registry.getSnapshot().packedBounds;

  assert.ok(packed.nodeIndexes instanceof Uint16Array);
  assert.ok(packed.chunkIndexes instanceof Int32Array);
  assert.ok(packed.flags instanceof Uint8Array);
  assert.ok(packed.minHorizontal instanceof Float64Array);
  assert.equal(packed.nodeCount, 5);
  assert.equal(packed.count, 7);
  assert.deepEqual([...packed.chunkIndexes], [-1, -1, -1, 0, 1, 2, -1]);
  assert.ok((packed.flags[1] ?? 0) & DRAWING_PACKED_BOUND_UNBOUNDED_HORIZONTAL);
  assert.ok((packed.flags[2] ?? 0) & DRAWING_PACKED_BOUND_UNBOUNDED_VERTICAL);
  assert.ok((packed.flags[6] ?? 0) & DRAWING_PACKED_BOUND_DEFERRED);

  const visible = registry.query({
    horizontalDomain: "time",
    minHorizontal: 0,
    maxHorizontal: 10,
    minPrice: 0,
    maxPrice: 10,
  });
  assert.deepEqual(visible.map((node) => node.id), [
    "horizontal",
    "vertical",
    "freehand",
    "deferred",
  ]);
  assert.equal(visible.filter((node) => node.id === "freehand").length, 1);
});

test("span chunks requiring exact frame projection fail open in the packed registry", () => {
  const entity = createDrawingEntity({
    id: "span-freehand",
    kind: "freehand",
    geometry: {
      kind: "freehand",
      dataPoints: [{ time: 1_000, price: 1_000 }, { time: 1_010, price: 1_010 }],
    },
    style: { kind: "freehand" },
  });
  const exactBounds: DrawingEntityGeometryBounds = Object.freeze({
    bounds: Object.freeze({ kind: "deferred" as const }),
    chunks: Object.freeze([Object.freeze({
      startPointIndex: 0,
      endPointIndex: 2,
      segmentStartPointIndex: 0,
      requiresExactProjection: true,
      bounds: Object.freeze({
        kind: "bounded" as const,
        horizontalDomain: "time" as const,
        minHorizontal: 1_000,
        maxHorizontal: 1_010,
        minPrice: 1_000,
        maxPrice: 1_010,
      }),
    })]),
    gapPointIndexes: Object.freeze([]),
    pointCount: 2,
  });
  const registry = createDrawingSceneRegistry("scope-exact-span", {
    createBounds: () => exactBounds,
  });
  assert.equal(registry.reconcile(createDrawingDocument({
    scopeKey: "scope-exact-span",
    entities: [entity],
  })).ok, true);

  const packed = registry.getSnapshot().packedBounds;
  assert.equal(packed.count, 1);
  assert.ok((packed.flags[0] ?? 0) & DRAWING_PACKED_BOUND_DEFERRED);
  assert.deepEqual(registry.query({
    horizontalDomain: "time",
    minHorizontal: 0,
    maxHorizontal: 10,
    minPrice: 0,
    maxPrice: 10,
  }).map((node) => node.id), [entity.id]);
});

test("registry rejects cross-scope documents atomically", () => {
  const registry = createDrawingSceneRegistry("scope-A");
  const accepted = registry.reconcile(createDrawingDocument({
    scopeKey: "scope-A",
    entities: [lineEntity("a", 1, 1)],
  }));
  assert.equal(accepted.ok, true);
  const before = registry.getSnapshot();
  const beforeNode = registry.getNode("a");

  const rejected = registry.reconcile(createDrawingDocument({
    scopeKey: "scope-B",
    entities: [lineEntity("b", 2, 2)],
  }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.error, /scope/);
  assert.strictEqual(registry.getSnapshot(), before);
  assert.strictEqual(registry.getNode("a"), beforeNode);
  assert.equal(registry.getNode("b"), null);
});

test("registry accepts exactly 512 entities and rejects a forged 513th without mutation", () => {
  const entities = Array.from(
    { length: MAX_DRAWING_DOCUMENT_ENTITIES },
    (_, index) => lineEntity(`line-${index}`, index, index),
  );
  const registry = createDrawingSceneRegistry("scope-budget");
  const accepted = registry.reconcile(createDrawingDocument({
    scopeKey: "scope-budget",
    entities,
  }));
  assert.equal(accepted.ok, true);
  assert.equal(registry.getSnapshot().nodes.length, MAX_DRAWING_DOCUMENT_ENTITIES);
  const before = registry.getSnapshot();

  const overflowEntity = lineEntity("overflow", 1_000, 1_000);
  const overflowEntities = new Map(entities.map((entry) => [entry.id, entry] as const));
  overflowEntities.set(overflowEntity.id, overflowEntity);
  const forgedOverflow = Object.freeze({
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION,
    scopeKey: "scope-budget",
    documentRevision: 1,
    entities: overflowEntities,
    zOrder: Object.freeze([...overflowEntities.keys()]),
  }) as DrawingDocument;
  const rejected = registry.reconcile(forgedOverflow);
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.error, /budget/);
  assert.strictEqual(registry.getSnapshot(), before);
  assert.equal(registry.getSnapshot().nodes.length, MAX_DRAWING_DOCUMENT_ENTITIES);
});
