import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingDocumentSessionRegistry,
  createDrawingDocumentStore,
} from "../drawingDocumentStore.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../drawingDocument.js";
import type { DrawingEntityInput } from "../drawingDocument.js";
import { mustBeDefined } from "../../../../test/testHelpers.js";

function lineInput(id: string, color = "#fff"): DrawingEntityInput {
  return {
    id,
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    },
    style: { kind: "line", color, lineWidth: 2 },
  };
}

test("successful dispatch publishes once, marks the exact revision dirty, and supports revision-safe ack", () => {
  const store = createDrawingDocumentStore("scope-a");
  const notifications: number[] = [];
  store.subscribe((snapshot) => notifications.push(snapshot.documentRevision));

  const first = store.dispatch({ type: "create", entity: lineInput("line") });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(notifications, [1]);
  assert.equal(store.dirty, true);
  assert.equal(store.dirtyRevision, 1);

  const second = store.dispatch({
    type: "update-style",
    id: "line",
    patch: { color: "#f00" },
  });
  assert.equal(second.ok, true);
  assert.deepEqual(notifications, [1, 2]);
  assert.equal(store.dirtyRevision, 2);

  assert.equal(store.acknowledgePersisted("scope-a", 1), false);
  assert.equal(store.acknowledgePersisted("scope-b", 2), false);
  assert.equal(store.dirty, true);
  assert.equal(store.acknowledgePersisted("scope-a", 2), true);
  assert.equal(store.dirty, false);
  assert.equal(store.dirtyRevision, null);
});

test("an unchanged empty document can require a revision-safe persistence tombstone", () => {
  const store = createDrawingDocumentStore("scope-tombstone");
  assert.equal(store.dirty, false);
  assert.equal(store.requirePersistence("other-scope"), false);
  assert.equal(store.dirty, false);
  assert.equal(store.requirePersistence("scope-tombstone"), true);
  assert.equal(store.dirty, true);
  assert.equal(store.dirtyRevision, 0);
  assert.equal(store.acknowledgePersisted("scope-tombstone", 0), true);
  assert.equal(store.dirty, false);
});

test("dispatchMany commits one document revision and one subscriber notification", () => {
  const store = createDrawingDocumentStore("scope-a");
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  const result = store.dispatchMany([
    { type: "create", entity: lineInput("a") },
    { type: "create", entity: lineInput("b") },
    { type: "update-style", id: "a", patch: { color: "#0f0" } },
    { type: "reorder", order: ["b", "a"] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(store.getSnapshot().documentRevision, 1);
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot().zOrder, ["b", "a"]);
  assert.equal(mustBeDefined(store.getSnapshot().entities.get("a")).styleRevision, 2);
});

test("failed and no-op dispatches preserve snapshot, dirty state, and notifications", () => {
  const store = createDrawingDocumentStore("scope-a");
  store.dispatch({ type: "create", entity: lineInput("line") });
  assert.equal(store.acknowledgePersisted("scope-a", 1), true);
  const before = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  const noOps = [
    store.dispatchMany([]),
    store.dispatch({ type: "update-style", id: "line", patch: { color: "#fff" } }),
    store.dispatch({ type: "delete", id: "missing" }),
    store.dispatch({ type: "reorder", order: ["line"] }),
  ];
  for (const result of noOps) {
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.strictEqual(result.document, before);
  }

  const failed = store.dispatchMany([
    { type: "update-style", id: "line", patch: { color: "#0f0" } },
    { type: "update-style", id: "line", patch: { lineWidth: Number.NaN } },
  ]);
  assert.equal(failed.ok, false);
  assert.strictEqual(failed.document, before);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.dirty, false);
  assert.equal(store.dirtyRevision, null);
  assert.equal(notifications, 0);
  const line = mustBeDefined(store.getSnapshot().entities.get("line"));
  assert.deepEqual(line.style, { kind: "line", color: "#fff", lineWidth: 2 });
});

test("loadDocument deep-clones one scope without dirtying it and rejects cross-scope replacement", () => {
  const scopeA = createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: 7,
    entities: [createDrawingEntity(lineInput("same-id", "#a00"))],
  });
  const scopeB = createDrawingDocument({
    scopeKey: "scope-b",
    documentRevision: 3,
    entities: [createDrawingEntity(lineInput("same-id", "#00b"))],
  });
  const store = createDrawingDocumentStore(scopeA);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  store.dispatch({ type: "update-style", id: "same-id", patch: { color: "#f00" } });
  assert.equal(store.dirty, true);
  const wrongScope = store.loadDocument(scopeB);
  assert.equal(wrongScope.ok, false);
  assert.equal(store.dirty, true);
  assert.equal(store.getSnapshot().scopeKey, "scope-a");

  const load = store.loadDocument(scopeA);
  assert.equal(load.ok, true);
  assert.equal(load.changed, true);
  assert.equal(store.dirty, false);
  assert.equal(store.getSnapshot().scopeKey, "scope-a");
  assert.equal(store.getSnapshot().documentRevision, 7);
  const a = mustBeDefined(store.getSnapshot().entities.get("same-id"));
  assert.notStrictEqual(a, scopeA.entities.get("same-id"));
  assert.equal(a.style.kind === "line" ? a.style.color : null, "#a00");

  const sameLoad = store.loadDocument(scopeA);
  assert.equal(sameLoad.ok, true);
  assert.equal(sameLoad.changed, false);
  assert.equal(notifications, 2, "one command publish plus one scope-load publish");
  assert.equal(store.acknowledgePersisted("scope-a", 8), false);
});

test("subscriber re-entry cannot overwrite the newest dirty revision", () => {
  const store = createDrawingDocumentStore("scope-a");
  let nested = false;
  store.subscribe(() => {
    if (nested) return;
    nested = true;
    const result = store.dispatch({ type: "create", entity: lineInput("nested") });
    assert.equal(result.ok, true);
  });

  const outer = store.dispatch({ type: "create", entity: lineInput("outer") });
  assert.equal(outer.ok, true);
  assert.equal(store.getSnapshot().documentRevision, 2);
  assert.equal(store.dirtyRevision, 2);
  assert.equal(store.acknowledgePersisted("scope-a", 2), true);
});

test("snapshots are runtime-frozen and listener failures cannot roll back a commit", () => {
  const store = createDrawingDocumentStore("scope-a");
  let secondListenerCalls = 0;
  store.subscribe(() => { throw new Error("listener failed"); });
  const unsubscribe = store.subscribe(() => { secondListenerCalls += 1; });

  const result = store.dispatch({ type: "create", entity: lineInput("line") });
  assert.equal(result.ok, true);
  assert.equal(secondListenerCalls, 1);
  assert.equal(store.getSnapshot().entities.has("line"), true);
  assert.equal(Object.isFrozen(store.getSnapshot()), true);
  assert.equal(typeof (store.getSnapshot().entities as unknown as { set?: unknown }).set, "undefined");

  unsubscribe();
  store.dispatch({ type: "delete", id: "line" });
  assert.equal(secondListenerCalls, 1);
});

test("session registry retains dirty scopes across host reacquisition without mixing symbols", () => {
  const registry = createDrawingDocumentSessionRegistry();
  const scopeA = registry.getStore("scope-a");
  scopeA.dispatch({ type: "create", entity: lineInput("same-id", "#a00") });
  assert.equal(scopeA.dirty, true);

  assert.strictEqual(registry.getStore("scope-a"), scopeA);
  const scopeB = registry.getStore("scope-b");
  assert.notStrictEqual(scopeB, scopeA);
  assert.equal(scopeB.getSnapshot().entities.size, 0);
  assert.equal(registry.isLoaded("scope-a"), false);
  assert.equal(
    registry.shouldLoadFromPersistence("scope-a", scopeA),
    false,
    "a dirty session snapshot must take precedence over an older disk payload",
  );
  assert.equal(registry.shouldLoadFromPersistence("scope-b", scopeB), true);
  assert.equal(registry.markLoaded("scope-a", scopeA), true);
  assert.equal(registry.isLoaded("scope-a"), true);
  assert.equal(registry.shouldLoadFromPersistence("scope-a", scopeA), false);
  assert.equal(registry.markLoaded("scope-a", scopeB), false);
});
