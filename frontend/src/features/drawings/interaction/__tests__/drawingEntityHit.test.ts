import assert from "node:assert/strict";
import test from "node:test";

import { drawingEntityHitFromDisplay } from "../drawingEntityHit.js";

test("scene hits resolve to canonical SavedDrawing identities for all kind aliases", () => {
  const drawings = [
    { type: "line" as const, id: "line-1" },
    { type: "angle-measure" as const, id: "angle-1" },
  ];
  assert.deepEqual(drawingEntityHitFromDisplay(drawings, {
    entityId: "angle-1",
    kind: "angle-measure",
    pointIndex: 1,
    zone: "ray",
  }), {
    id: "angle-1",
    saved: drawings[1],
    type: "angle",
    pointIndex: 1,
    zone: "ray",
  });
});

test("scene hits fail closed for stale ids and kind mismatches", () => {
  const drawings = [{ type: "text" as const, id: "text-1" }];
  assert.equal(drawingEntityHitFromDisplay(drawings, null), null);
  assert.equal(drawingEntityHitFromDisplay(drawings, {
    entityId: "stale",
    kind: "text",
  }), null);
  assert.equal(drawingEntityHitFromDisplay(drawings, {
    entityId: "text-1",
    kind: "position",
  }), null);
});
