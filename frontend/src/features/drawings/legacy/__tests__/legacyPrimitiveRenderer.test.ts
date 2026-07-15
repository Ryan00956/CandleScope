import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../../core/drawingCodec.js";
import type { DrawingDocument } from "../../core/drawingDocument.js";
import { createPrimitiveFromSavedDrawing } from "../../drawingPrimitiveFactory.js";
import type { DrawingPrimitive, SavedDrawing } from "../../drawingTypes.js";
import {
  createLegacyPrimitiveRenderer,
  materializeLegacyPrimitives,
} from "../legacyPrimitiveRenderer.js";

function documentFrom(drawings: SavedDrawing[], scopeKey = "renderer"): DrawingDocument {
  const document = importSavedDrawings(scopeKey, drawings);
  if (!document) throw new Error("Invalid renderer fixture");
  return document;
}

function ids(primitives: readonly DrawingPrimitive[]): string[] {
  return primitives.map((primitive) => primitive.id);
}

test("renderer materializes and replaces snapshots in stable document z-order", () => {
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) { attached.push(primitive.id); },
      detachPrimitive(primitive) { detached.push(primitive.id); },
    },
  });
  const first = documentFrom([
    { type: "text", id: "text", dataPoint: { time: 1, price: 1 }, text: "one" },
    { type: "line", id: "line", dataPoints: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
    { type: "shape", id: "shape", dataPoints: [{ time: 2, price: 2 }, { time: 3, price: 3 }] },
  ]);

  assert.equal(renderer.reconcile(first), true);
  assert.strictEqual(renderer.documentSnapshot(), first);
  assert.deepEqual(ids(renderer.snapshot()), ["text", "line", "shape"]);
  assert.deepEqual(attached, ["text", "line", "shape"]);
  assert.deepEqual(detached, []);
  assert.equal(renderer.getPrimitiveById("line")?.id, "line");

  const second = documentFrom([
    { type: "axis-line", id: "axis", dataPoint: { time: 4, price: 4 } },
    { type: "line", id: "next-line", dataPoints: [{ time: 4, price: 4 }, { time: 5, price: 5 }] },
  ]);
  assert.equal(renderer.replaceDocument(second), true);
  assert.strictEqual(renderer.documentSnapshot(), second);
  assert.deepEqual(ids(renderer.snapshot()), ["axis", "next-line"]);
  assert.deepEqual(attached, ["text", "line", "shape", "axis", "next-line"]);
  assert.deepEqual(detached, ["text", "line", "shape"]);
  assert.equal(renderer.getPrimitiveById("line"), null);
});

test("factory failure preserves the complete old primitive collection", () => {
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    createPrimitive(drawing) {
      if (drawing.id === "bad") return null;
      return createPrimitiveFromSavedDrawing(drawing);
    },
    surface: {
      attachPrimitive(primitive) { attached.push(primitive.id); },
      detachPrimitive(primitive) { detached.push(primitive.id); },
    },
  });
  const initial = documentFrom([
    { type: "line", id: "old-a" },
    { type: "line", id: "old-b" },
  ]);
  assert.equal(renderer.reconcile(initial), true);
  const previous = renderer.snapshot();

  const failing = documentFrom([
    { type: "line", id: "candidate" },
    { type: "line", id: "bad" },
  ]);
  assert.equal(renderer.reconcile(failing), false);
  const afterFailure = renderer.snapshot();
  assert.strictEqual(afterFailure[0], previous[0]);
  assert.strictEqual(afterFailure[1], previous[1]);
  assert.deepEqual(ids(afterFailure), ["old-a", "old-b"]);
  assert.deepEqual(attached, ["old-a", "old-b"]);
  assert.deepEqual(detached, []);
});

test("surface attach failure rolls back candidates without detaching the old snapshot", () => {
  let rejectId: string | null = null;
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        if (primitive.id === rejectId) return false;
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        detached.push(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }]);
  assert.equal(renderer.reconcile(initial), true);
  const old = renderer.snapshot()[0];

  rejectId = "reject";
  const failing = documentFrom([
    { type: "line", id: "candidate" },
    { type: "line", id: "reject" },
  ]);
  assert.equal(renderer.reconcile(failing), false);
  assert.strictEqual(renderer.snapshot()[0], old);
  assert.deepEqual(attached, ["old", "candidate"]);
  assert.deepEqual(detached, ["candidate"]);
});

test("failed candidate compensation retains the orphan credential for a later retry", () => {
  let rejectedAttachId: string | null = null;
  let rejectedDetachId: string | null = null;
  const surface = new Set<string>();
  const attachCounts = new Map<string, number>();
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        if (primitive.id === rejectedAttachId) return false;
        attachCounts.set(primitive.id, (attachCounts.get(primitive.id) ?? 0) + 1);
        surface.add(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        if (primitive.id === rejectedDetachId) return false;
        surface.delete(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }]);
  assert.equal(renderer.reconcile(initial), true);

  rejectedAttachId = "candidate-b";
  rejectedDetachId = "candidate-a";
  assert.equal(renderer.reconcile(documentFrom([
    { type: "line", id: "candidate-a" },
    { type: "line", id: "candidate-b" },
  ])), false);
  assert.deepEqual([...surface].sort(), ["candidate-a", "old"]);

  rejectedAttachId = null;
  rejectedDetachId = null;
  assert.equal(renderer.reconcile(initial), true);
  assert.deepEqual([...surface], ["old"]);
  assert.equal(attachCounts.get("old"), 1, "canonical attachment must not be duplicated");
  assert.equal(attachCounts.get("candidate-a"), 1);
});

test("adopt validates exact ids/order and updates registry without chart operations", () => {
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) { attached.push(primitive.id); },
      detachPrimitive(primitive) { detached.push(primitive.id); },
    },
  });
  const document = documentFrom([
    { type: "line", id: "manual-a" },
    { type: "text", id: "manual-b", dataPoint: { time: 2, price: 2 } },
  ]);
  const manuallyAttached = materializeLegacyPrimitives(document);
  assert.ok(manuallyAttached);

  assert.equal(renderer.canAdopt(document, manuallyAttached), true);
  assert.equal(renderer.canAdopt(document, [...manuallyAttached].reverse()), false);
  assert.equal(renderer.adopt(document, manuallyAttached), true);
  assert.strictEqual(renderer.snapshot()[0], manuallyAttached[0]);
  assert.strictEqual(renderer.snapshot()[1], manuallyAttached[1]);
  assert.deepEqual(attached, []);
  assert.deepEqual(detached, []);

  assert.equal(renderer.adopt(document, [...manuallyAttached].reverse()), false);
  assert.equal(renderer.adopt(document, manuallyAttached.slice(0, 1)), false);
  assert.strictEqual(renderer.snapshot()[0], manuallyAttached[0]);
  assert.strictEqual(renderer.snapshot()[1], manuallyAttached[1]);
  assert.deepEqual(attached, []);
  assert.deepEqual(detached, []);
});

test("adopt keeps unverified surface state unsynchronized until identity reconcile", () => {
  const attached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive() { return true; },
    },
  });
  const document = documentFrom([
    { type: "line", id: "unverified-a" },
    { type: "line", id: "unverified-b" },
  ]);
  const primitives = materializeLegacyPrimitives(document);
  assert.ok(primitives);

  assert.equal(renderer.adopt(document, primitives), true);
  assert.deepEqual(attached, [], "registry adoption itself must not claim or mutate surface state");
  assert.equal(renderer.reconcile(document), true);
  assert.deepEqual(attached, ["unverified-a", "unverified-b"]);
  assert.equal(renderer.reconcile(document), true);
  assert.deepEqual(attached, ["unverified-a", "unverified-b"]);
});

test("adoptAttached records checked controller surface credentials", () => {
  const attached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive() { return true; },
    },
  });
  const document = documentFrom([{ type: "line", id: "verified" }]);
  const primitives = materializeLegacyPrimitives(document);
  assert.ok(primitives);

  assert.equal(renderer.adoptAttached(document, primitives), true);
  assert.equal(renderer.reconcile(document), true);
  assert.deepEqual(attached, [], "verified adoption must not duplicate an existing attachment");
});

test("detached registries rebind atomically and retry an identity snapshot after attach failure", () => {
  let rejectedId: string | null = null;
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        if (primitive.id === rejectedId) return false;
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        detached.push(primitive.id);
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ]);
  const primitives = materializeLegacyPrimitives(document);
  assert.ok(primitives);
  assert.equal(renderer.adoptAttached(document, primitives), true);

  assert.equal(renderer.detachSurface(), true);
  assert.deepEqual(detached, ["first", "second"]);
  assert.deepEqual(ids(renderer.snapshot()), ["first", "second"]);

  rejectedId = "second";
  assert.equal(renderer.rebindSurface(), false);
  assert.deepEqual(attached, ["first"]);
  assert.deepEqual(detached, ["first", "second", "first"]);
  assert.deepEqual(ids(renderer.snapshot()), ["first", "second"]);

  rejectedId = null;
  assert.equal(renderer.reconcile(document), true, "identity reconcile retries an unsynchronized surface");
  assert.deepEqual(attached, ["first", "first", "second"]);
});

test("detach failure retains the canonical registry for a later fail-closed retry", () => {
  let rejectDetach = true;
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive() { return true; },
      detachPrimitive(primitive) {
        if (rejectDetach && primitive.id === "second") return false;
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ]);
  assert.equal(renderer.reconcile(document), true);

  assert.equal(renderer.detachSurface(), false);
  assert.deepEqual(ids(renderer.snapshot()), ["first", "second"]);

  rejectDetach = false;
  assert.equal(renderer.detachSurface(), true);
  assert.deepEqual(ids(renderer.snapshot()), ["first", "second"]);
});

test("partial detach rebind attaches only the missing primitive", () => {
  let rejectedDetachId: string | null = null;
  const surface = new Set<string>();
  const attachCounts = new Map<string, number>();
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attachCounts.set(primitive.id, (attachCounts.get(primitive.id) ?? 0) + 1);
        surface.add(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        if (primitive.id === rejectedDetachId) return false;
        surface.delete(primitive.id);
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ]);
  assert.equal(renderer.reconcile(document), true);

  rejectedDetachId = "second";
  assert.equal(renderer.detachSurface(), false);
  assert.deepEqual([...surface], ["second"]);

  rejectedDetachId = null;
  assert.equal(renderer.rebindSurface(), true);
  assert.deepEqual([...surface].sort(), ["first", "second"]);
  assert.equal(attachCounts.get("first"), 2);
  assert.equal(attachCounts.get("second"), 1, "retained credentials must not be attached twice");
});

test("confirmed chart removal invalidates failed-detach credentials before rebind", () => {
  let rejectDetach = true;
  const physical = new Set<DrawingPrimitive>();
  let attachCalls = 0;
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attachCalls += 1;
        physical.add(primitive);
        return true;
      },
      detachPrimitive(primitive) {
        if (rejectDetach) return false;
        physical.delete(primitive);
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ]);
  assert.equal(renderer.reconcile(document), true);
  const primitives = renderer.snapshot();
  assert.equal(renderer.detachSurface(), false);

  physical.clear(); // chart.remove() owns the final physical release
  renderer.releaseSurfaceCredentials();
  assert.equal(renderer.adopt(document, primitives), true);
  rejectDetach = false;
  assert.equal(renderer.rebindSurface(), true);
  assert.equal(physical.size, 2);
  assert.equal(attachCalls, 4, "both canonical primitives must bind to the replacement surface");
});

test("main-series replacement reattaches every entity after credential invalidation", () => {
  let surfaceGeneration = 0;
  const attachedGenerations: number[] = [];
  const physicalByGeneration = new Map<number, Set<DrawingPrimitive>>([
    [0, new Set<DrawingPrimitive>()],
    [1, new Set<DrawingPrimitive>()],
  ]);
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attachedGenerations.push(surfaceGeneration);
        physicalByGeneration.get(surfaceGeneration)?.add(primitive);
        return true;
      },
      detachPrimitive(primitive) {
        physicalByGeneration.get(surfaceGeneration)?.delete(primitive);
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ], "series-replacement");

  assert.equal(renderer.reconcile(document), true);
  const primitives = renderer.snapshot();
  assert.deepEqual(attachedGenerations, [0, 0]);
  assert.equal(physicalByGeneration.get(0)?.size, 2);

  // Lightweight Charts has removed the old series out-of-band.
  physicalByGeneration.get(0)?.clear();
  surfaceGeneration = 1;
  renderer.releaseSurfaceCredentials();
  assert.equal(renderer.adopt(document, primitives), true);
  assert.equal(renderer.rebindSurface(), true);
  assert.deepEqual(attachedGenerations, [0, 0, 1, 1]);
  assert.equal(physicalByGeneration.get(0)?.size, 0);
  assert.equal(physicalByGeneration.get(1)?.size, 2);
  for (const primitive of primitives) {
    assert.equal(physicalByGeneration.get(1)?.has(primitive), true);
  }
});

test("failed main-series replacement recovery retains surviving old-series credentials", () => {
  let rejectedDetachId: string | null = "second";
  const physical = new Set<DrawingPrimitive>();
  const attachCounts = new Map<string, number>();
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attachCounts.set(primitive.id, (attachCounts.get(primitive.id) ?? 0) + 1);
        physical.add(primitive);
        return true;
      },
      detachPrimitive(primitive) {
        if (primitive.id === rejectedDetachId) return false;
        physical.delete(primitive);
        return true;
      },
    },
  });
  const document = documentFrom([
    { type: "line", id: "first" },
    { type: "line", id: "second" },
  ], "series-replacement-rollback");

  assert.equal(renderer.reconcile(document), true);
  const primitives = renderer.snapshot();
  assert.equal(renderer.detachSurface(), false);
  assert.deepEqual([...physical].map((primitive) => primitive.id), ["second"]);

  // Preparation failed, so the old series remains authoritative. The
  // replacement-only credential invalidation must not run: generation recovery
  // should attach only the primitive that was successfully detached.
  rejectedDetachId = null;
  assert.equal(renderer.adopt(document, primitives), true);
  assert.equal(renderer.rebindSurface(), true);
  assert.deepEqual([...physical].map((primitive) => primitive.id).sort(), ["first", "second"]);
  assert.equal(attachCounts.get("first"), 2);
  assert.equal(attachCounts.get("second"), 1);
});

test("style adoption cannot certify an existing primitive missing after partial detach", () => {
  let rejectedDetachId: string | null = null;
  const attachCounts = new Map<string, number>();
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attachCounts.set(primitive.id, (attachCounts.get(primitive.id) ?? 0) + 1);
        return true;
      },
      detachPrimitive(primitive) {
        return primitive.id !== rejectedDetachId;
      },
    },
  });
  const initial = documentFrom([
    { type: "line", id: "first", color: "#fff" },
    { type: "line", id: "second", color: "#fff" },
  ]);
  assert.equal(renderer.reconcile(initial), true);
  const primitives = renderer.snapshot();

  rejectedDetachId = "second";
  assert.equal(renderer.detachSurface(), false);
  const styled = documentFrom([
    { type: "line", id: "first", color: "#f00" },
    { type: "line", id: "second", color: "#fff" },
  ]);
  assert.equal(renderer.adoptAttached(styled, primitives), false);

  rejectedDetachId = null;
  assert.equal(renderer.reconcile(styled), true);
  assert.equal(attachCounts.get("first"), 2, "the missing primitive must be physically rebound");
  assert.equal(attachCounts.get("second"), 1);
});

test("a staged 513th raw candidate is recoverable after document validation rejects it", () => {
  const surface = new Set<DrawingPrimitive>();
  const detached: DrawingPrimitive[] = [];
  const attachExternally = (primitive: DrawingPrimitive): boolean => {
    surface.add(primitive);
    return true;
  };
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive: attachExternally,
      detachPrimitive(primitive) {
        detached.push(primitive);
        surface.delete(primitive);
        return true;
      },
    },
  });
  const saved = Array.from({ length: 512 }, (_value, index): SavedDrawing => ({
    type: "line",
    id: `line-${index}`,
  }));
  const canonical = documentFrom(saved, "max-candidates");
  assert.equal(renderer.reconcile(canonical), true);

  const overflow = createPrimitiveFromSavedDrawing({ type: "line", id: "line-overflow" });
  assert.ok(overflow);
  assert.equal(attachExternally(overflow), true);
  renderer.stageAttached([...renderer.snapshot(), overflow]);
  assert.equal(
    importSavedDrawings("max-candidates", [...saved, { type: "line", id: "line-overflow" }]),
    null,
  );

  assert.equal(renderer.restoreDocument(canonical), true);
  assert.ok(detached.includes(overflow));
  assert.equal([...surface].some((primitive) => primitive.id === "line-overflow"), false);
  assert.equal(surface.size, 512);
});

test("restoreDocument replaces a mutated legacy draft with fresh canonical primitives", () => {
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive() { return true; },
      detachPrimitive() { return true; },
    },
  });
  const document = documentFrom([{ type: "line", id: "line", color: "#fff" }]);
  assert.equal(renderer.reconcile(document), true);
  const mutated = renderer.snapshot()[0];
  assert.ok(mutated && "setColor" in mutated && typeof mutated.setColor === "function");
  mutated.setColor("#f00");

  assert.equal(renderer.restoreDocument(document), true);
  const restored = renderer.snapshot()[0];
  assert.ok(restored);
  assert.notStrictEqual(restored, mutated);
  assert.equal("color" in restored ? restored.color : null, "#fff");
});

test("pure materialization rejects primitive factories that change canonical ids", () => {
  const document = documentFrom([{ type: "line", id: "canonical-id" }]);
  const materialized = materializeLegacyPrimitives(document, (drawing) => {
    return createPrimitiveFromSavedDrawing({ ...drawing, id: "wrong-id" });
  });
  assert.equal(materialized, null);
});
