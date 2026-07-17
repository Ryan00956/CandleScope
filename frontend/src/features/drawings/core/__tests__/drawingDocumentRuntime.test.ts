import assert from "node:assert/strict";
import test from "node:test";

import {
  commitLegacyPrimitiveCommands,
  drawingCommandsForLegacyPrimitive,
  loadSavedDrawingsIntoDocumentStore,
  persistDrawingDocumentStore,
} from "../drawingDocumentRuntime.js";
import type { LegacyPrimitiveCommandRequest } from "../drawingDocumentRuntime.js";
import type { DrawingCommand } from "../drawingCommands.js";
import { createDrawingDocumentStore } from "../drawingDocumentStore.js";
import type { DrawingPrimitive, SavedDrawing } from "../../drawingTypes.js";
import { TextDrawingPrimitive } from "../../primitives/TextDrawingPrimitive.js";
import { mustBeDefined } from "../../../../test/testHelpers.js";

function savedLine(id: string, color = "#fff", priceOffset = 0): SavedDrawing {
  return {
    type: "line",
    id,
    lineType: "line-segment",
    dataPoints: [
      { time: 100, price: 10 + priceOffset },
      { time: 200, price: 20 + priceOffset },
    ],
    color,
    lineWidth: 2,
  };
}

function linePrimitive(id: string, color = "#fff", priceOffset = 0): DrawingPrimitive {
  return {
    _id: id,
    _lineType: "line-segment",
    _dataPoints: [
      { time: 100, price: 10 + priceOffset },
      { time: 200, price: 20 + priceOffset },
    ],
    _color: color,
    _lineWidth: 2,
  } as unknown as DrawingPrimitive;
}

function primitiveCommands(
  primitive: DrawingPrimitive,
  request: LegacyPrimitiveCommandRequest,
): readonly DrawingCommand[] {
  return mustBeDefined(drawingCommandsForLegacyPrimitive(primitive, request));
}

function withLocalStorage<T>(
  setItem: (key: string, value: string, values: Map<string, string>) => void,
  run: (values: Map<string, string>) => T,
): T {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => setItem(key, value, values),
  };
  try {
    return run(values);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else globalThis.localStorage = previous;
  }
}

test("load is clean and explicit commands commit style and geometry revisions independently", () => {
  const store = createDrawingDocumentStore("scope-a");
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  const loaded = loadSavedDrawingsIntoDocumentStore(store, "scope-a", [savedLine("line")]);
  assert.equal(loaded.ok, true);
  assert.equal(store.dirty, false);
  assert.equal(store.getSnapshot().documentRevision, 0);
  assert.equal(notifications, 1);

  const styledPrimitive = linePrimitive("line", "#f00");
  const style = commitLegacyPrimitiveCommands(
    store,
    "scope-a",
    [styledPrimitive],
    primitiveCommands(styledPrimitive, { type: "update-style" }),
  );
  assert.equal(style.ok, true);
  assert.equal(style.changed, true);
  const styleEntity = mustBeDefined(store.getSnapshot().entities.get("line"));
  assert.equal(styleEntity.geometryRevision, 1);
  assert.equal(styleEntity.styleRevision, 2);
  assert.equal(store.getSnapshot().documentRevision, 1);

  const movedPrimitive = linePrimitive("line", "#f00", 5);
  const move = commitLegacyPrimitiveCommands(
    store,
    "scope-a",
    [movedPrimitive],
    primitiveCommands(movedPrimitive, { type: "move" }),
  );
  assert.equal(move.ok, true);
  assert.equal(move.changed, true);
  const movedEntity = mustBeDefined(store.getSnapshot().entities.get("line"));
  assert.equal(movedEntity.geometryRevision, 2);
  assert.equal(movedEntity.styleRevision, 2);
  assert.equal(store.getSnapshot().documentRevision, 2);
  assert.equal(notifications, 3);
});

test("clear is one document transaction and persists a legacy-readable empty array", () => {
  withLocalStorage((_key, value, values) => values.set(_key, value), (values) => {
    const store = createDrawingDocumentStore("scope-clear");
    const loaded = loadSavedDrawingsIntoDocumentStore(store, "scope-clear", [
      savedLine("first"),
      savedLine("second"),
    ]);
    assert.equal(loaded.ok, true);

    const cleared = commitLegacyPrimitiveCommands(
      store,
      "scope-clear",
      [],
      [Object.freeze({ type: "clear" })],
    );
    assert.equal(cleared.ok, true);
    assert.equal(cleared.changed, true);
    assert.equal(store.getSnapshot().documentRevision, 1);
    assert.equal(store.getSnapshot().entities.size, 0);
    assert.equal(store.dirty, true);

    assert.equal(persistDrawingDocumentStore(store), true);
    assert.equal(store.dirty, false);
    assert.equal(values.get("candlescope-drawings-scope-clear"), "[]");
  });
});

test("stale commands and invalid primitive projections fail atomically without a half revision", () => {
  const store = createDrawingDocumentStore("scope-a");
  assert.equal(
    loadSavedDrawingsIntoDocumentStore(store, "scope-a", [savedLine("line")]).ok,
    true,
  );
  const before = store.getSnapshot();

  const redPrimitive = linePrimitive("line", "#f00");
  const redCommands = primitiveCommands(redPrimitive, { type: "update-style" });
  const stale = commitLegacyPrimitiveCommands(store, "scope-b", [redPrimitive], redCommands);
  assert.equal(stale.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.dirty, false);

  const denied = commitLegacyPrimitiveCommands(
    store,
    "scope-a",
    [redPrimitive],
    redCommands,
    () => false,
  );
  assert.equal(denied.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.dirty, false);

  const invalid = commitLegacyPrimitiveCommands(
    store,
    "scope-a",
    [{ _id: "unknown" } as unknown as DrawingPrimitive],
    [],
  );
  assert.equal(invalid.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.getSnapshot().documentRevision, 0);
  assert.equal(store.dirty, false);

  const staleLoad = loadSavedDrawingsIntoDocumentStore(store, "scope-b", [savedLine("other")]);
  assert.equal(staleLoad.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.dirty, false);
});

test("preview and unconfirmed empty text primitives are excluded before renderer preflight and commit", () => {
  const store = createDrawingDocumentStore("scope-preview");
  let preflightCount = -1;
  const line = linePrimitive("line");
  const result = commitLegacyPrimitiveCommands(
    store,
    "scope-preview",
    [
      line,
      { _id: "__preview__", _isPreview: true } as unknown as DrawingPrimitive,
      { _id: "empty-text", _text: "  \n ", _unconfirmedText: true } as unknown as DrawingPrimitive,
    ],
    primitiveCommands(line, { type: "create" }),
    (_document, primitives) => {
      preflightCount = primitives.length;
      return true;
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(preflightCount, 1);
  assert.equal(result.primitives.length, 1);
  assert.equal(store.getSnapshot().entities.size, 1);
});

test("confirmed legacy empty text remains canonical data", () => {
  const store = createDrawingDocumentStore("scope-empty-text");
  const emptyText = new TextDrawingPrimitive({
    id: "legacy-empty-text",
    dataPoint: { time: 100, price: 10 },
    text: "",
  });

  const result = commitLegacyPrimitiveCommands(
    store,
    "scope-empty-text",
    [emptyText],
    primitiveCommands(emptyText, { type: "create" }),
  );
  assert.equal(result.ok, true);
  const entity = store.getSnapshot().entities.get("legacy-empty-text");
  assert.equal(entity?.kind, "text");
  assert.equal(entity?.style.kind === "text" ? entity.style.text : undefined, "");
});

test("storage failure leaves the exact document revision dirty for retry", () => {
  withLocalStorage(() => { throw new Error("quota exceeded"); }, () => {
    const store = createDrawingDocumentStore("scope-retry");
    assert.equal(
      (() => {
        const line = linePrimitive("line");
        return commitLegacyPrimitiveCommands(
          store,
          "scope-retry",
          [line],
          primitiveCommands(line, { type: "create" }),
        ).ok;
      })(),
      true,
    );
    assert.equal(store.dirtyRevision, 1);

    assert.equal(persistDrawingDocumentStore(store), false);
    assert.equal(store.dirty, true);
    assert.equal(store.dirtyRevision, 1);
    assert.equal(store.getSnapshot().documentRevision, 1);
  });
});
