import assert from "node:assert/strict";
import test from "node:test";

import {
  commitLegacyPrimitiveCommands,
  drawingCommandsForLegacyPrimitive,
  loadSavedDrawingsIntoDocumentStore,
} from "../drawingDocumentRuntime.js";
import type { LegacyPrimitiveCommandRequest } from "../drawingDocumentRuntime.js";
import { createDrawingDocumentStore } from "../drawingDocumentStore.js";
import type { DrawingCommand } from "../drawingCommands.js";
import { createPrimitiveFromSavedDrawing } from "../../drawingPrimitiveFactory.js";
import type { DrawingPrimitive, SavedDrawing } from "../../drawingTypes.js";
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

function allSavedDrawingKinds(): SavedDrawing[] {
  const first = { time: 100, price: 10 };
  const second = { time: 200, price: 20 };
  return [
    {
      type: "line",
      id: "line-command",
      lineType: "line-ray",
      dataPoints: [first, second],
      color: "#111",
      lineWidth: 2,
    },
    {
      type: "axis-line",
      id: "axis-command",
      axisLineType: "cross",
      dataPoint: first,
      color: "#222",
      lineWidth: 3,
    },
    {
      type: "angle-measure",
      id: "angle-command",
      dataPoints: [first, second],
      color: "#333",
      lineWidth: 4,
    },
    {
      type: "text",
      id: "text-command",
      dataPoint: first,
      text: "command payload",
      color: "#444",
      fontSize: 16,
    },
    {
      type: "fibonacci",
      id: "fibonacci-command",
      dataPoints: [first, second],
      color: "#555",
      lineWidth: 2,
      levels: [{ level: 0.618, color: "#abcdef", enabled: true }],
      inverted: true,
    },
    {
      type: "position",
      id: "position-command",
      direction: "long",
      entryPrice: 10,
      tpPrice: 20,
      slPrice: 5,
      timeRange: { start: 100, end: 200 },
      positionSize: 1_000,
    },
    {
      type: "shape",
      id: "shape-command",
      shapeType: "ellipse",
      dataPoints: [first, second],
      color: "#666",
      lineWidth: 5,
      fillColor: "#777",
      fillOpacity: 0.25,
      lineStyle: "dashed",
    },
    {
      type: "freehand",
      id: "freehand-command",
      dataPoints: [first, second],
      color: "#888",
      lineWidth: 6,
    },
    {
      type: "highlighter",
      id: "highlighter-command",
      dataPoints: [first, second],
      color: "#ff0",
      lineWidth: 12,
      opacity: 0.35,
      compositeOperation: "multiply",
      brushShape: "square",
    },
  ];
}

test("all drawing kinds produce a complete create-command entity payload", () => {
  const savedDrawings = allSavedDrawingKinds();
  assert.equal(savedDrawings.length, 9);

  for (const saved of savedDrawings) {
    const primitive = mustBeDefined(createPrimitiveFromSavedDrawing(saved));
    const commands = primitiveCommands(primitive, { type: "create" });
    assert.equal(commands.length, 1, saved.type);
    const command = mustBeDefined(commands[0]);
    assert.equal(command.type, "create", saved.type);
    if (command.type !== "create") throw new Error(`Expected create command for ${saved.type}`);

    assert.equal(command.entity.id, saved.id, saved.type);
    assert.equal(command.entity.kind, saved.type, saved.type);
    assert.equal(typeof command.entity.geometry, "object", saved.type);
    assert.equal(typeof command.entity.style, "object", saved.type);
    assert.deepEqual(
      Object.keys(command.entity).sort(),
      ["bounds", "geometry", "geometryRevision", "id", "kind", "style", "styleRevision"],
      saved.type,
    );
  }
});

test("explicit command payloads publish the matching command revisions", () => {
  const store = createDrawingDocumentStore("scope-command");

  const created = commitLegacyPrimitiveCommands(
    store,
    "scope-command",
    [linePrimitive("line")],
    primitiveCommands(linePrimitive("line"), { type: "create" }),
  );
  assert.equal(created.ok, true);
  assert.equal(store.getSnapshot().documentRevision, 1);

  const styledPrimitive = linePrimitive("line", "#f00");
  const styled = commitLegacyPrimitiveCommands(
    store,
    "scope-command",
    [styledPrimitive],
    primitiveCommands(styledPrimitive, { type: "update-style" }),
  );
  assert.equal(styled.ok, true);
  let entity = mustBeDefined(store.getSnapshot().entities.get("line"));
  assert.equal(entity.geometryRevision, 1);
  assert.equal(entity.styleRevision, 2);

  const resizedPrimitive = linePrimitive("line", "#f00", 5);
  const resized = commitLegacyPrimitiveCommands(
    store,
    "scope-command",
    [resizedPrimitive],
    primitiveCommands(resizedPrimitive, { type: "resize" }),
  );
  assert.equal(resized.ok, true);
  entity = mustBeDefined(store.getSnapshot().entities.get("line"));
  assert.equal(entity.geometryRevision, 2);
  assert.equal(entity.styleRevision, 2);

  const deleted = commitLegacyPrimitiveCommands(
    store,
    "scope-command",
    [],
    [Object.freeze({ type: "delete", id: "line" })],
  );
  assert.equal(deleted.ok, true);
  assert.equal(store.getSnapshot().entities.size, 0);
  assert.equal(store.getSnapshot().documentRevision, 4);
});

test("candidate primitives only validate and cannot replace command payloads", () => {
  const store = createDrawingDocumentStore("scope-atomic");
  assert.equal(loadSavedDrawingsIntoDocumentStore(store, "scope-atomic", [
    savedLine("first"),
    savedLine("second"),
  ]).ok, true);
  const before = store.getSnapshot();

  const redFirst = linePrimitive("first", "#f00");
  const unrelatedGeometry = commitLegacyPrimitiveCommands(
    store,
    "scope-atomic",
    [redFirst, linePrimitive("second", "#fff", 5)],
    primitiveCommands(redFirst, { type: "update-style" }),
  );
  assert.equal(unrelatedGeometry.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
  assert.equal(store.dirty, false);

  const third = linePrimitive("third");
  const extraCreate = commitLegacyPrimitiveCommands(
    store,
    "scope-atomic",
    [linePrimitive("first"), linePrimitive("second"), third, linePrimitive("fourth")],
    primitiveCommands(third, { type: "create" }),
  );
  assert.equal(extraCreate.ok, false);
  assert.strictEqual(store.getSnapshot(), before);

  const mismatchedPayload = commitLegacyPrimitiveCommands(
    store,
    "scope-atomic",
    [redFirst, linePrimitive("second")],
    [Object.freeze({ type: "update-style", id: "first", patch: { kind: "line", color: "#00f" } })],
  );
  assert.equal(mismatchedPayload.ok, false);
  assert.strictEqual(store.getSnapshot(), before);

  const missingStyleTarget = commitLegacyPrimitiveCommands(
    store,
    "scope-atomic",
    [linePrimitive("first"), linePrimitive("second")],
    [Object.freeze({ type: "update-style", id: "missing", patch: { color: "#f00" } })],
  );
  assert.equal(missingStyleTarget.ok, false);
  assert.strictEqual(store.getSnapshot(), before);
});

test("clear command requires and publishes an empty renderer candidate", () => {
  const store = createDrawingDocumentStore("scope-clear-command");
  assert.equal(loadSavedDrawingsIntoDocumentStore(store, "scope-clear-command", [
    savedLine("first"),
    savedLine("second"),
  ]).ok, true);

  const invalid = commitLegacyPrimitiveCommands(
    store,
    "scope-clear-command",
    [linePrimitive("first")],
    [Object.freeze({ type: "clear" })],
  );
  assert.equal(invalid.ok, false);
  assert.equal(store.getSnapshot().entities.size, 2);

  const cleared = commitLegacyPrimitiveCommands(
    store,
    "scope-clear-command",
    [],
    [Object.freeze({ type: "clear" })],
  );
  assert.equal(cleared.ok, true);
  assert.equal(store.getSnapshot().entities.size, 0);
  assert.equal(store.getSnapshot().documentRevision, 1);
});
