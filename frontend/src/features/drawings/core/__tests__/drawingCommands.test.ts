import assert from "node:assert/strict";
import test from "node:test";

import { applyDrawingCommands } from "../drawingCommands.js";
import type { DrawingCommandApplyResult } from "../drawingCommands.js";
import {
  createDrawingDocument,
  createDrawingEntity,
} from "../drawingDocument.js";
import type {
  CanonicalDrawingGeometry,
  DrawingDocument,
  DrawingEntityInput,
} from "../drawingDocument.js";
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

function documentWithLines(...ids: string[]): DrawingDocument {
  return createDrawingDocument({
    scopeKey: "scope-a",
    entities: ids.map((id) => createDrawingEntity(lineInput(id))),
  });
}

function success(result: DrawingCommandApplyResult): DrawingDocument {
  if (!result.ok) {
    assert.fail(result.error);
  }
  return result.document;
}

test("style, move, and resize commands advance only their owned revisions", () => {
  const initial = documentWithLines("line");
  const styledResult = applyDrawingCommands(initial, [{
    type: "update-style",
    id: "line",
    patch: { color: "#f00" },
  }]);
  const styled = success(styledResult);
  const styledEntity = mustBeDefined(styled.entities.get("line"));
  assert.equal(styled.documentRevision, 1);
  assert.equal(styledEntity.geometryRevision, 1);
  assert.equal(styledEntity.styleRevision, 2);

  const movedGeometry: CanonicalDrawingGeometry = {
    kind: "line",
    lineType: "line-segment",
    dataPoints: [{ time: 150, price: 15 }, { time: 250, price: 25 }],
  };
  const moved = success(applyDrawingCommands(styled, [{
    type: "move",
    id: "line",
    geometry: movedGeometry,
  }]));
  const movedEntity = mustBeDefined(moved.entities.get("line"));
  assert.equal(moved.documentRevision, 2);
  assert.equal(movedEntity.geometryRevision, 2);
  assert.equal(movedEntity.styleRevision, 2);
  assert.deepEqual(movedEntity.bounds, { kind: "deferred" });

  const resized = success(applyDrawingCommands(moved, [{
    type: "resize",
    id: "line",
    geometry: {
      kind: "line",
      lineType: "line-segment",
      dataPoints: [{ time: 150, price: 15 }, { time: 300, price: 30 }],
    },
  }]));
  const resizedEntity = mustBeDefined(resized.entities.get("line"));
  assert.equal(resized.documentRevision, 3);
  assert.equal(resizedEntity.geometryRevision, 3);
  assert.equal(resizedEntity.styleRevision, 2);
});

test("create, reorder, delete, and clear keep entity order a bijection", () => {
  const created = success(applyDrawingCommands(createDrawingDocument({ scopeKey: "scope-a" }), [
    { type: "create", entity: lineInput("a") },
    { type: "create", entity: lineInput("b"), at: 0 },
  ]));
  assert.equal(created.documentRevision, 1);
  assert.deepEqual(created.zOrder, ["b", "a"]);
  assert.equal(created.entities.size, 2);

  const reordered = success(applyDrawingCommands(created, [{
    type: "reorder",
    order: ["a", "b"],
  }]));
  assert.equal(reordered.documentRevision, 2);
  assert.deepEqual(reordered.zOrder, ["a", "b"]);

  const deleted = success(applyDrawingCommands(reordered, [{ type: "delete", id: "a" }]));
  assert.equal(deleted.documentRevision, 3);
  assert.deepEqual(deleted.zOrder, ["b"]);
  assert.equal(deleted.entities.has("a"), false);

  const cleared = success(applyDrawingCommands(deleted, [{ type: "clear" }]));
  assert.equal(cleared.documentRevision, 4);
  assert.equal(cleared.entities.size, 0);
  assert.deepEqual(cleared.zOrder, []);
});

test("create reuses only module-authenticated canonical entities", () => {
  const canonical = createDrawingEntity(lineInput("canonical"));
  const canonicalResult = success(applyDrawingCommands(
    createDrawingDocument({ scopeKey: "scope-a" }),
    [{ type: "create", entity: canonical }],
  ));
  assert.strictEqual(canonicalResult.entities.get("canonical"), canonical);

  const frozenInput = Object.freeze(lineInput("frozen-input"));
  const frozenResult = success(applyDrawingCommands(
    createDrawingDocument({ scopeKey: "scope-a" }),
    [{ type: "create", entity: frozenInput }],
  ));
  assert.notStrictEqual(frozenResult.entities.get("frozen-input"), frozenInput);
});

test("dispatchMany is one atomic document commit and rolls every staged command back on failure", () => {
  const initial = createDrawingDocument({ scopeKey: "scope-a" });
  const batchResult = applyDrawingCommands(initial, [
    { type: "create", entity: lineInput("a") },
    { type: "update-style", id: "a", patch: { color: "#0f0" } },
    { type: "create", entity: lineInput("b") },
    {
      type: "move",
      id: "b",
      geometry: {
        kind: "line",
        lineType: "line-segment",
        dataPoints: [{ time: 300, price: 30 }, { time: 400, price: 40 }],
      },
    },
  ]);
  const batch = success(batchResult);
  assert.equal(batchResult.changed, true);
  assert.equal(batch.documentRevision, 1);
  assert.equal(mustBeDefined(batch.entities.get("a")).styleRevision, 2);
  assert.equal(mustBeDefined(batch.entities.get("b")).geometryRevision, 2);

  const failed = applyDrawingCommands(initial, [
    { type: "create", entity: lineInput("a") },
    { type: "create", entity: lineInput("a") },
  ]);
  assert.equal(failed.ok, false);
  assert.strictEqual(failed.document, initial);
  assert.equal(failed.changed, false);
  assert.equal(initial.entities.size, 0);

  const existing = documentWithLines("line");
  const invalidPatch = applyDrawingCommands(existing, [{
    type: "update-style",
    id: "line",
    patch: { color: "#f00", lineWidth: Number.NaN },
  }]);
  assert.equal(invalidPatch.ok, false);
  assert.strictEqual(invalidPatch.document, existing);
  const unchanged = mustBeDefined(existing.entities.get("line"));
  assert.deepEqual(unchanged.style, { kind: "line", color: "#fff", lineWidth: 2 });
});

test("no-op commands preserve snapshot identity and payloads cannot mutate committed geometry", () => {
  const initial = documentWithLines("line");
  for (const commands of [
    [] as const,
    [{ type: "update-style", id: "line", patch: { color: "#fff" } }] as const,
    [{ type: "delete", id: "missing" }] as const,
    [{ type: "reorder", order: ["line"] }] as const,
  ]) {
    const result = applyDrawingCommands(initial, commands);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.strictEqual(result.document, initial);
  }

  const mutablePoints = [{ time: 300, price: 30 }, { time: 400, price: 40 }];
  const geometry: CanonicalDrawingGeometry = {
    kind: "line",
    lineType: "line-segment",
    dataPoints: mutablePoints,
  };
  const moved = success(applyDrawingCommands(initial, [{
    type: "move",
    id: "line",
    geometry,
  }]));
  mutablePoints[0] = { time: 999, price: 999 };
  const movedEntity = mustBeDefined(moved.entities.get("line"));
  if (movedEntity.geometry.kind !== "line") throw new Error("Expected line");
  assert.deepEqual(mustBeDefined(movedEntity.geometry.dataPoints)[0], { time: 300, price: 30 });
});

test("invalid geometry, style keys, duplicate ids, and reorder permutations fail without a revision", () => {
  const initial = documentWithLines("a", "b");
  const results = [
    applyDrawingCommands(initial, [{
      type: "move",
      id: "a",
      geometry: { kind: "shape", shapeType: "rectangle" },
    }]),
    applyDrawingCommands(initial, [{
      type: "update-style",
      id: "a",
      patch: { rawChartRef: {} },
    }]),
    applyDrawingCommands(initial, [{ type: "create", entity: lineInput("a") }]),
    applyDrawingCommands(initial, [{ type: "reorder", order: ["a", "a"] }]),
    applyDrawingCommands(initial, [{ type: "reorder", order: ["a", "missing"] }]),
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.strictEqual(result.document, initial);
    assert.equal(result.changed, false);
    assert.equal(initial.documentRevision, 0);
  }
});

test("a command cannot overflow the document revision", () => {
  const exhausted = createDrawingDocument({
    scopeKey: "scope-a",
    documentRevision: Number.MAX_SAFE_INTEGER,
    entities: [createDrawingEntity(lineInput("line"))],
  });
  const result = applyDrawingCommands(exhausted, [{
    type: "update-style",
    id: "line",
    patch: { color: "#f00" },
  }]);
  assert.equal(result.ok, false);
  assert.strictEqual(result.document, exhausted);
  assert.equal(exhausted.documentRevision, Number.MAX_SAFE_INTEGER);
});
