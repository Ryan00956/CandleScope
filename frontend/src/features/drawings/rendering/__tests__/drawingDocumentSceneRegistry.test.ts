import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingDocument,
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingPrimitive } from "../../drawingTypes.js";
import { createDrawingDocumentSceneRegistry } from "../drawingDocumentSceneRegistry.js";

function documentWithEntities(
  count: number,
  scopeKey = "scene-registry",
  documentRevision = 7,
) {
  return createDrawingDocument({
    scopeKey,
    documentRevision,
    entities: Array.from({ length: count }, (_, index) => createDrawingEntity({
      id: `line-${index + 1}`,
      kind: "line",
      geometry: {
        kind: "line",
        lineType: "line-segment",
        dataPoints: [
          { time: index + 1, price: index + 1 },
          { time: index + 2, price: index + 2 },
        ],
      },
      style: { kind: "line", color: "#f59e0b", lineWidth: 2 },
    })),
  });
}

test("scene registry adopts 512 canonical entities without per-drawing objects", async () => {
  const registry = createDrawingDocumentSceneRegistry();
  const document = documentWithEntities(512);

  const result = await registry.reconcileAsync(document);

  assert.deepEqual(result, {
    ok: true,
    cancelled: false,
    entityCount: 512,
    chunkCount: 1,
    maxChunkDurationMs: 0,
  });
  assert.equal(registry.documentSnapshot(), document);
  assert.equal(registry.snapshot().length, 0);
  assert.equal(registry.attachedCount(), 0);
  assert.equal(registry.getPrimitiveById("line-1"), null);
  assert.deepEqual(registry.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 512,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: false,
  });
});

test("scene registry rejects every non-empty legacy candidate projection", () => {
  const registry = createDrawingDocumentSceneRegistry();
  const document = documentWithEntities(1);
  const candidate = {} as DrawingPrimitive;

  assert.equal(registry.canAdopt(document, [candidate]), false);
  assert.equal(registry.adopt(document, [candidate]), false);
  assert.equal(registry.adoptAttached(document, [candidate]), false);
  assert.equal(registry.adoptDetached(document, [candidate]), false);
  assert.throws(() => registry.stageAttached([candidate]), /cannot stage legacy primitives/);
  assert.equal(registry.documentSnapshot(), null);
});

test("load, clear, surface rebind and scope switch preserve the zero-instance invariant", () => {
  const registry = createDrawingDocumentSceneRegistry();
  const first = documentWithEntities(3, "scope-a", 1);
  const cleared = documentWithEntities(0, "scope-a", 2);
  const switched = documentWithEntities(2, "scope-b", 1);

  assert.equal(registry.replaceDocument(first), true);
  assert.equal(registry.detachSurface(), true);
  assert.equal(registry.rebindSurface(), true);
  assert.equal(registry.adopt(cleared, []), true);
  assert.equal(registry.restoreDocument(switched), true);
  assert.strictEqual(registry.documentSnapshot(), switched);
  assert.deepEqual(registry.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 2,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: false,
  });
  assert.deepEqual(registry.snapshot(), []);
});

test("scene registry abort and dispose are fail-closed and idempotent", async () => {
  const registry = createDrawingDocumentSceneRegistry();
  const document = documentWithEntities(1);
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(await registry.reconcileAsync(document, { signal: controller.signal }), {
    ok: false,
    cancelled: true,
    entityCount: 0,
    chunkCount: 0,
    maxChunkDurationMs: 0,
  });
  assert.equal(registry.reconcile(document), true);
  assert.equal(registry.detachSurface(), true);
  assert.equal(registry.rebindSurface(), true);
  registry.dispose();
  registry.dispose();
  assert.equal(registry.documentSnapshot(), null);
  assert.deepEqual(registry.evidence(), {
    registryKind: "scene-document-only",
    documentEntityCount: 0,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    disposed: true,
  });
  assert.equal(registry.reconcile(document), false);
  assert.equal(registry.detachSurface(), false);
  assert.equal(registry.rebindSurface(), false);
});
