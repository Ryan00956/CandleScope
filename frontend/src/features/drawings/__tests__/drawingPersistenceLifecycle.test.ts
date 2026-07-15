import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../core/drawingCodec.js";
import { createDrawingDocument } from "../core/drawingDocument.js";
import type { DrawingEntityInput } from "../core/drawingDocument.js";
import { createDrawingDocumentStore } from "../core/drawingDocumentStore.js";
import { createPrimitiveFromSavedDrawing } from "../drawingPrimitiveFactory.js";
import type { DrawingKind, DrawingPrimitive, SavedDrawing } from "../drawingTypes.js";
import { createLegacyPrimitiveRenderer } from "../legacy/legacyPrimitiveRenderer.js";
import {
  commitDetachedDrawingCommands,
  createDrawingCommittedPaintTicket,
  shouldProjectVisibleSceneEntity,
  visibleSceneSelectedId,
} from "../useDrawingPersistenceLifecycle.js";

function lineFixture(id: string, color = "#fff"): {
  entity: DrawingEntityInput;
  primitive: DrawingPrimitive;
} {
  const saved: SavedDrawing = {
    type: "line",
    id,
    lineType: "line-segment",
    dataPoints: [
      { time: 100, price: 10 },
      { time: 200, price: 20 },
    ],
    color,
    lineWidth: 2,
  };
  const document = importSavedDrawings("fixture", [saved]);
  const primitive = createPrimitiveFromSavedDrawing(saved);
  const entity = document?.entities.get(id);
  if (!document || !primitive || !entity) throw new Error("Invalid lifecycle line fixture");
  return { entity, primitive };
}

test("detached commits publish the document before the first surface mutation", () => {
  const scopeKey = "detached-document-first";
  const store = createDrawingDocumentStore(scopeKey);
  const events: string[] = [];
  store.subscribe((document) => {
    events.push(`document:${document.documentRevision}`);
  });
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        events.push(`attach:${primitive.id}`);
        assert.equal(store.getSnapshot().entities.has(primitive.id), true);
        assert.equal(store.getSnapshot().documentRevision, 1);
        return true;
      },
      detachPrimitive(primitive) {
        events.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  events.length = 0;
  const { entity, primitive } = lineFixture("created");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity }],
    primitives: [primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.ok(result);
  assert.equal(result.changed, true);
  assert.equal(result.rendererAdopted, true);
  assert.equal(result.surfaceSynchronized, true);
  assert.strictEqual(result.document, store.getSnapshot());
  assert.strictEqual(renderer.documentSnapshot(), store.getSnapshot());
  assert.deepEqual(events, ["document:1", "attach:created"]);
});

test("detached commit validation failures preserve the document and never touch the surface", () => {
  const scopeKey = "detached-validation-failure";
  const store = createDrawingDocumentStore(scopeKey);
  const initial = store.getSnapshot();
  const surfaceEvents: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        surfaceEvents.push(`attach:${primitive.id}`);
        return true;
      },
      detachPrimitive(primitive) {
        surfaceEvents.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(initial), true);
  const commandFixture = lineFixture("command-id");
  const mismatchedCandidate = lineFixture("candidate-id");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity: commandFixture.entity }],
    primitives: [mismatchedCandidate.primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.equal(result, null);
  assert.strictEqual(store.getSnapshot(), initial);
  assert.strictEqual(renderer.documentSnapshot(), initial);
  assert.equal(store.dirty, false);
  assert.deepEqual(surfaceEvents, []);
});

test("surface failures cannot roll back an already committed detached document", () => {
  const scopeKey = "detached-surface-failure";
  const store = createDrawingDocumentStore(scopeKey);
  const events: string[] = [];
  store.subscribe((document) => {
    events.push(`document:${document.documentRevision}`);
  });
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        events.push(`attach-rejected:${primitive.id}`);
        return false;
      },
      detachPrimitive(primitive) {
        events.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  events.length = 0;
  const { entity, primitive } = lineFixture("retained");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity }],
    primitives: [primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.ok(result);
  assert.equal(result.changed, true);
  assert.equal(result.rendererAdopted, true);
  assert.equal(result.surfaceSynchronized, false);
  assert.strictEqual(result.document, store.getSnapshot());
  assert.strictEqual(renderer.documentSnapshot(), store.getSnapshot());
  assert.equal(store.getSnapshot().entities.has("retained"), true);
  assert.equal(store.dirty, true);
  assert.deepEqual(events, ["document:1", "attach-rejected:retained"]);
});

test("committed paint tickets require the exact attached surface and retain the viewport revision", () => {
  const document = createDrawingDocument({
    scopeKey: "paint-ticket",
    documentRevision: 7,
  });
  const frame = Object.freeze({ surfaceGeneration: 11, viewportRevision: 29 });

  const ticket = createDrawingCommittedPaintTicket(document, frame, 11);

  assert.deepEqual(ticket, {
    scopeKey: "paint-ticket",
    documentRevision: 7,
    surfaceGeneration: 11,
    viewportRevision: 29,
  });
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(createDrawingCommittedPaintTicket(document, frame, 10), null);
  assert.equal(createDrawingCommittedPaintTicket(document, frame, null), null);
  assert.equal(createDrawingCommittedPaintTicket(document, null, 11), null);
});

test("committed paint tickets reject non-exact surface and viewport coordinates", () => {
  const document = createDrawingDocument({ scopeKey: "invalid-paint-ticket" });
  const invalidFrames = [
    { surfaceGeneration: -1, viewportRevision: 0 },
    { surfaceGeneration: 0.5, viewportRevision: 0 },
    { surfaceGeneration: Number.MAX_SAFE_INTEGER + 1, viewportRevision: 0 },
    { surfaceGeneration: 0, viewportRevision: -1 },
    { surfaceGeneration: 0, viewportRevision: 0.5 },
    { surfaceGeneration: 0, viewportRevision: Number.MAX_SAFE_INTEGER + 1 },
  ] as const;

  for (const frame of invalidFrames) {
    assert.equal(
      createDrawingCommittedPaintTicket(document, frame, frame.surfaceGeneration),
      null,
    );
  }
});

test("dynamic overlay owns selection and excludes only its active migrated entity", () => {
  assert.equal(visibleSceneSelectedId("selected", false), "selected");
  assert.equal(visibleSceneSelectedId("selected", true), null);
  assert.equal(visibleSceneSelectedId(null, true), null);

  const migratedKinds: readonly DrawingKind[] = ["line", "axis-line", "shape"];
  for (const kind of migratedKinds) {
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", false, "active"), true);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", true, "active"), false);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "other", true, "active"), true);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", true, null), true);
  }

  const legacyKinds: readonly DrawingKind[] = [
    "angle-measure",
    "text",
    "fibonacci",
    "position",
    "freehand",
    "highlighter",
  ];
  for (const kind of legacyKinds) {
    assert.equal(shouldProjectVisibleSceneEntity(kind, "legacy", false, null), false);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "legacy", true, "legacy"), false);
  }
});
