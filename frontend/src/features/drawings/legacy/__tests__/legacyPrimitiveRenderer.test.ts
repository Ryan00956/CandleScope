import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../../core/drawingCodec.js";
import type { DrawingDocument } from "../../core/drawingDocument.js";
import { createPrimitiveFromSavedDrawing } from "../../drawingPrimitiveFactory.js";
import type { DrawingPrimitive, SavedDrawing } from "../../drawingTypes.js";
import {
  createLegacyPrimitiveRenderer,
  legacyPrimitiveDocumentDeltaIds,
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

test("reconcileAsync yields every eight entities and commits only after pure construction", async () => {
  let clock = 0;
  let yieldCount = 0;
  const physical = new Set<string>();
  const factoryCalls: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    createPrimitive(drawing) {
      clock += 1;
      if (drawing.id) factoryCalls.push(drawing.id);
      return createPrimitiveFromSavedDrawing(drawing);
    },
    surface: {
      attachPrimitive(primitive) {
        physical.add(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        physical.delete(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }], "async-chunks");
  assert.equal(renderer.reconcile(initial), true);
  clock = 0;
  factoryCalls.length = 0;
  const next = documentFrom(Array.from({ length: 18 }, (_value, index): SavedDrawing => ({
    type: "line",
    id: `next-${index}`,
  })), "async-chunks");

  const result = await renderer.reconcileAsync(next, {
    monotonicNow: () => clock,
    maxEntitiesPerChunk: 8,
    chunkBudgetMs: 8,
    yieldToHost: async () => {
      yieldCount += 1;
      assert.strictEqual(renderer.documentSnapshot(), initial);
      assert.deepEqual([...physical], ["old"], "candidate construction must not touch the surface");
    },
  });

  assert.deepEqual(result, {
    ok: true,
    cancelled: false,
    entityCount: 18,
    chunkCount: 3,
    maxChunkDurationMs: 8,
  });
  assert.equal(yieldCount, 2, "the final partial chunk must not schedule an extra yield");
  assert.deepEqual(factoryCalls, Array.from({ length: 18 }, (_value, index) => `next-${index}`));
  assert.strictEqual(renderer.documentSnapshot(), next);
  assert.deepEqual([...physical], Array.from({ length: 18 }, (_value, index) => `next-${index}`));
});

test("reconcileAsync cancellation during a yield leaves registry and surface untouched", async () => {
  let clock = 0;
  const attached: string[] = [];
  const detached: string[] = [];
  const controller = new AbortController();
  const renderer = createLegacyPrimitiveRenderer({
    createPrimitive(drawing) {
      clock += 1;
      return createPrimitiveFromSavedDrawing(drawing);
    },
    surface: {
      attachPrimitive(primitive) {
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        detached.push(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }], "async-cancel");
  assert.equal(renderer.reconcile(initial), true);
  clock = 0;
  const next = documentFrom(Array.from({ length: 10 }, (_value, index): SavedDrawing => ({
    type: "line",
    id: `cancelled-${index}`,
  })), "async-cancel");

  const result = await renderer.reconcileAsync(next, {
    signal: controller.signal,
    monotonicNow: () => clock,
    maxEntitiesPerChunk: 2,
    yieldToHost: async () => { controller.abort("test cancellation"); },
  });

  assert.deepEqual(result, {
    ok: false,
    cancelled: true,
    entityCount: 2,
    chunkCount: 1,
    maxChunkDurationMs: 2,
  });
  assert.strictEqual(renderer.documentSnapshot(), initial);
  assert.deepEqual(ids(renderer.snapshot()), ["old"]);
  assert.deepEqual(attached, ["old"]);
  assert.deepEqual(detached, []);
});

test("reconcileAsync rejects a stale candidate after another reconcile wins during a yield", async () => {
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        attached.push(primitive.id);
        return true;
      },
      detachPrimitive(primitive) {
        detached.push(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }], "async-stale");
  const winner = documentFrom([{ type: "line", id: "winner" }], "async-stale");
  const stale = documentFrom(Array.from({ length: 10 }, (_value, index): SavedDrawing => ({
    type: "line",
    id: `stale-${index}`,
  })), "async-stale");
  assert.equal(renderer.reconcile(initial), true);
  let replaced = false;

  const result = await renderer.reconcileAsync(stale, {
    maxEntitiesPerChunk: 2,
    yieldToHost: async () => {
      if (replaced) return;
      replaced = true;
      assert.equal(renderer.reconcile(winner), true);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.entityCount, 10);
  assert.equal(result.chunkCount, 5);
  assert.strictEqual(renderer.documentSnapshot(), winner);
  assert.deepEqual(ids(renderer.snapshot()), ["winner"]);
  assert.deepEqual(attached, ["old", "winner"]);
  assert.deepEqual(detached, ["old"]);
});

test("reconcileAsync compensates cancellation raised by a surface attach callback", async () => {
  const controller = new AbortController();
  const physical = new Set<string>();
  let cancelOnCandidate = false;
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        physical.add(primitive.id);
        if (cancelOnCandidate && primitive.id === "candidate-a") controller.abort();
        return true;
      },
      detachPrimitive(primitive) {
        physical.delete(primitive.id);
        return true;
      },
    },
  });
  const initial = documentFrom([{ type: "line", id: "old" }], "async-commit-cancel");
  const next = documentFrom([
    { type: "line", id: "candidate-a" },
    { type: "line", id: "candidate-b" },
  ], "async-commit-cancel");
  assert.equal(renderer.reconcile(initial), true);
  cancelOnCandidate = true;

  const result = await renderer.reconcileAsync(next, { signal: controller.signal });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.strictEqual(renderer.documentSnapshot(), initial);
  assert.deepEqual(ids(renderer.snapshot()), ["old"]);
  assert.deepEqual([...physical], ["old"]);
});

test("detached document adoption materializes only affected ids and preserves every other owner", () => {
  const factoryCalls: string[] = [];
  const attached: DrawingPrimitive[] = [];
  const detached: DrawingPrimitive[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    createPrimitive(drawing) {
      if (!drawing.id) return null;
      factoryCalls.push(drawing.id);
      return createPrimitiveFromSavedDrawing(drawing);
    },
    surface: {
      attachPrimitive(primitive) {
        attached.push(primitive);
        return true;
      },
      detachPrimitive(primitive) {
        detached.push(primitive);
        return true;
      },
    },
  });
  const initial = documentFrom([
    { type: "line", id: "a", color: "#fff" },
    { type: "line", id: "b", color: "#fff" },
    { type: "text", id: "c", dataPoint: { time: 3, price: 3 }, text: "same" },
  ], "detached-delta");
  assert.equal(renderer.reconcile(initial), true);
  const [oldA, oldB, oldC] = renderer.snapshot();
  assert.ok(oldA && oldB && oldC);
  factoryCalls.length = 0;
  attached.length = 0;
  detached.length = 0;

  const styledAndReordered = documentFrom([
    { type: "text", id: "c", dataPoint: { time: 3, price: 3 }, text: "same" },
    { type: "line", id: "a", color: "#fff" },
    { type: "line", id: "b", color: "#f00" },
  ], "detached-delta");
  assert.deepEqual(legacyPrimitiveDocumentDeltaIds(initial, styledAndReordered), ["b"]);
  assert.equal(renderer.adoptDetached(styledAndReordered), true);
  const [nextC, nextA, nextB] = renderer.snapshot();
  assert.strictEqual(nextA, oldA);
  assert.strictEqual(nextC, oldC);
  assert.notStrictEqual(nextB, oldB);
  assert.deepEqual(factoryCalls, ["b"]);
  assert.deepEqual(detached, [oldB]);
  assert.deepEqual(attached, [nextB]);

  factoryCalls.length = 0;
  attached.length = 0;
  detached.length = 0;
  const reorderedOnly = documentFrom([
    { type: "line", id: "a", color: "#fff" },
    { type: "line", id: "b", color: "#f00" },
    { type: "text", id: "c", dataPoint: { time: 3, price: 3 }, text: "same" },
  ], "detached-delta");
  assert.deepEqual(legacyPrimitiveDocumentDeltaIds(styledAndReordered, reorderedOnly), []);
  assert.equal(renderer.adoptDetached(reorderedOnly), true);
  assert.strictEqual(renderer.getPrimitiveById("a"), oldA);
  assert.strictEqual(renderer.getPrimitiveById("b"), nextB);
  assert.strictEqual(renderer.getPrimitiveById("c"), oldC);
  assert.deepEqual(factoryCalls, []);
  assert.deepEqual(attached, []);
  assert.deepEqual(detached, []);
});

test("detached adoption keeps the committed document authoritative after candidate attach failure", () => {
  let rejectChangedCandidate = false;
  let rejectedCandidate: DrawingPrimitive | null = null;
  const physical = new Set<DrawingPrimitive>();
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        if (rejectChangedCandidate && primitive.id === "changed") {
          rejectedCandidate = primitive;
          return false;
        }
        physical.add(primitive);
        return true;
      },
      detachPrimitive(primitive) {
        physical.delete(primitive);
        return true;
      },
    },
  });
  const initial = documentFrom([
    { type: "line", id: "stable", color: "#fff" },
    { type: "line", id: "changed", color: "#fff" },
  ], "detached-attach-failure");
  assert.equal(renderer.reconcile(initial), true);
  const retainedStable = renderer.getPrimitiveById("stable");
  const retainedOldChanged = renderer.getPrimitiveById("changed");
  assert.ok(retainedStable && retainedOldChanged);

  const committed = documentFrom([
    { type: "line", id: "stable", color: "#fff" },
    { type: "line", id: "changed", color: "#f00" },
  ], "detached-attach-failure");
  rejectChangedCandidate = true;
  assert.equal(renderer.adoptDetached(committed), false);
  const detachedCandidate = renderer.getPrimitiveById("changed");
  assert.ok(detachedCandidate);
  assert.strictEqual(renderer.documentSnapshot(), committed);
  assert.strictEqual(renderer.getPrimitiveById("stable"), retainedStable);
  assert.notStrictEqual(detachedCandidate, retainedOldChanged);
  assert.equal(physical.has(retainedStable), true);
  assert.equal(physical.has(retainedOldChanged), false);
  assert.equal(physical.has(detachedCandidate), false);
  assert.equal([...physical].filter((primitive) => primitive.id === "changed").length, 0);
  assert.strictEqual(rejectedCandidate, detachedCandidate);

  rejectChangedCandidate = false;
  rejectedCandidate = null;
  assert.equal(renderer.rebindSurface(), true);
  assert.equal(physical.has(retainedStable), true);
  assert.equal(physical.has(detachedCandidate), true);
  assert.equal([...physical].filter((primitive) => primitive.id === "changed").length, 1);
});

test("detached adoption never attaches a replacement when the old same-id owner cannot detach", () => {
  let rejectDetach = false;
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
        if (rejectDetach && primitive.id === "changed") return false;
        physical.delete(primitive);
        return true;
      },
    },
  });
  const initial = documentFrom([
    { type: "line", id: "stable", color: "#fff" },
    { type: "line", id: "changed", color: "#fff" },
  ], "detached-detach-failure");
  assert.equal(renderer.reconcile(initial), true);
  const stable = renderer.getPrimitiveById("stable");
  const oldChanged = renderer.getPrimitiveById("changed");
  assert.ok(stable && oldChanged);

  rejectDetach = true;
  const committed = documentFrom([
    { type: "line", id: "stable", color: "#fff" },
    { type: "line", id: "changed", color: "#f00" },
  ], "detached-detach-failure");
  assert.equal(renderer.adoptDetached(committed), false);
  const candidate = renderer.getPrimitiveById("changed");
  assert.ok(candidate);
  assert.strictEqual(renderer.documentSnapshot(), committed);
  assert.equal(physical.has(oldChanged), true);
  assert.equal(physical.has(candidate), false);
  assert.equal([...physical].filter((primitive) => primitive.id === "changed").length, 1);
  assert.equal(attachCounts.get("stable"), 1);
  assert.equal(attachCounts.get("changed"), 1);

  rejectDetach = false;
  assert.equal(renderer.rebindSurface(), true);
  assert.equal(physical.has(oldChanged), false);
  assert.equal(physical.has(candidate), true);
  assert.equal([...physical].filter((primitive) => primitive.id === "changed").length, 1);
  assert.equal(attachCounts.get("stable"), 1, "unaffected owner must not reattach");
  assert.equal(attachCounts.get("changed"), 2);
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

test("hybrid attachment policy retains full interaction registry but binds only legacy owners", () => {
  const attached: string[] = [];
  const detached: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    shouldAttachPrimitive: (primitive) => primitive.id === "legacy-text",
    surface: {
      attachPrimitive(primitive) {
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
    { type: "line", id: "scene-line" },
    { type: "text", id: "legacy-text", dataPoint: { time: 2, price: 2 } },
    { type: "shape", id: "scene-shape" },
  ], "hybrid-surface");

  assert.equal(renderer.reconcile(document), true);
  assert.deepEqual(ids(renderer.snapshot()), ["scene-line", "legacy-text", "scene-shape"]);
  assert.deepEqual(attached, ["legacy-text"]);
  assert.equal(renderer.attachedCount(), 1);

  renderer.releaseSurfaceCredentials();
  assert.equal(renderer.rebindSurface(), true);
  assert.deepEqual(attached, ["legacy-text", "legacy-text"]);
  assert.equal(renderer.attachedCount(), 1);
  assert.deepEqual(detached, []);
});
