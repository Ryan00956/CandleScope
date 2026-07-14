import assert from "node:assert/strict";
import test from "node:test";
import { resolveDrawingDocumentAuthorityMode } from "../drawingDocumentAuthority.js";
import { clearDrawingScopeAuthoritatively } from "../drawingScopePersistence.js";
import { drawingDocumentSessionRegistry } from "../core/drawingDocumentStore.js";
import type { DrawingEntityInput } from "../core/drawingDocument.js";

function memoryStorage(values: Map<string, string>): Storage {
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function lineInput(id: string): DrawingEntityInput {
  return {
    id,
    kind: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    },
    style: { kind: "line", color: "#fff", lineWidth: 2 },
  };
}

test("drawing document authority is the default", () => {
  assert.equal(resolveDrawingDocumentAuthorityMode(undefined), "document");
  assert.equal(resolveDrawingDocumentAuthorityMode("document"), "document");
  assert.equal(resolveDrawingDocumentAuthorityMode("unexpected"), "document");
});

test("drawing document authority only rolls back for the exact legacy value", () => {
  assert.equal(resolveDrawingDocumentAuthorityMode("legacy"), "legacy");
  assert.equal(resolveDrawingDocumentAuthorityMode("LEGACY"), "document");
  assert.equal(resolveDrawingDocumentAuthorityMode(true), "document");
});

test("authoritative scope clear cannot be revived by the session registry", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = memoryStorage(values);
  const scopeKey = `removed-indicator-${Date.now()}`;
  const storageKey = `candlescope-drawings-${scopeKey}`;

  try {
    const store = drawingDocumentSessionRegistry.getStore(scopeKey);
    const created = store.dispatch({ type: "create", entity: lineInput("line") });
    assert.equal(created.ok, true);
    values.set(storageKey, JSON.stringify([{
      type: "line",
      id: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
      color: "#fff",
      lineWidth: 2,
    }]));

    assert.equal(clearDrawingScopeAuthoritatively(scopeKey, "document"), true);
    assert.equal(store.getSnapshot().entities.size, 0);
    assert.equal(store.dirty, false);
    assert.equal(values.get(storageKey), "[]");
    assert.equal(drawingDocumentSessionRegistry.getStore(scopeKey), store);
    assert.equal(drawingDocumentSessionRegistry.isLoaded(scopeKey), true);
    assert.equal(drawingDocumentSessionRegistry.shouldLoadFromPersistence(scopeKey, store), false);
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});

test("failed first clear write retains a dirty empty tombstone for retry", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  const scopeKey = `removed-indicator-write-failure-${Date.now()}`;
  const storageKey = `candlescope-drawings-${scopeKey}`;
  values.set(storageKey, JSON.stringify([{
    type: "line",
    id: "disk-line",
    lineType: "line-segment",
    dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    color: "#fff",
    lineWidth: 2,
  }]));
  const storage = memoryStorage(values);
  let rejectWrites = true;
  globalThis.localStorage = {
    ...storage,
    setItem(key, value) {
      if (rejectWrites) throw new Error("quota unavailable");
      storage.setItem(key, value);
    },
  };

  try {
    assert.equal(clearDrawingScopeAuthoritatively(scopeKey, "document"), false);
    const store = drawingDocumentSessionRegistry.getStore(scopeKey);
    assert.equal(store.getSnapshot().entities.size, 0);
    assert.equal(store.dirty, true);
    assert.notEqual(values.get(storageKey), "[]");

    rejectWrites = false;
    assert.equal(clearDrawingScopeAuthoritatively(scopeKey, "document"), true);
    assert.equal(store.dirty, false);
    assert.equal(values.get(storageKey), "[]");
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});

test("unavailable first read also retains an empty tombstone until storage recovers", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  const scopeKey = `removed-indicator-read-failure-${Date.now()}`;
  const storageKey = `candlescope-drawings-${scopeKey}`;
  values.set(storageKey, JSON.stringify([{
    type: "line",
    id: "inaccessible-line",
    lineType: "line-segment",
    dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    color: "#fff",
    lineWidth: 2,
  }]));
  globalThis.localStorage = {
    get length() { return 1; },
    clear() { throw new Error("storage unavailable"); },
    getItem() { throw new Error("storage unavailable"); },
    key() { return null; },
    removeItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
  };

  try {
    assert.equal(clearDrawingScopeAuthoritatively(scopeKey, "document"), false);
    const store = drawingDocumentSessionRegistry.getStore(scopeKey);
    assert.equal(store.getSnapshot().entities.size, 0);
    assert.equal(store.dirty, true);
    assert.equal(drawingDocumentSessionRegistry.isLoaded(scopeKey), true);

    globalThis.localStorage = memoryStorage(values);
    assert.equal(clearDrawingScopeAuthoritatively(scopeKey, "document"), true);
    assert.equal(store.dirty, false);
    assert.equal(values.get(storageKey), "[]");
  } finally {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previousLocalStorage;
  }
});
