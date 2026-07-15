import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingPrimitive } from "../../drawingTypes.js";
import {
  PHASE4_SCENE_DRAWING_KINDS,
  PHASE6_SCENE_DRAWING_KINDS,
  isPhase4SceneDrawingKind,
  isPhase4SceneDrawingPrimitive,
  isPhase6SceneDrawingKind,
  isPhase6SceneDrawingPrimitive,
} from "../drawingSceneMigration.js";

function primitive(fields: Readonly<Record<string, unknown>>): DrawingPrimitive {
  return fields as unknown as DrawingPrimitive;
}

test("Phase 6 adds committed freehand kinds without changing the Phase 4 checkpoint", () => {
  assert.deepEqual([...PHASE4_SCENE_DRAWING_KINDS], ["line", "axis-line", "shape"]);
  assert.deepEqual([...PHASE6_SCENE_DRAWING_KINDS], [
    "line",
    "axis-line",
    "shape",
    "freehand",
    "highlighter",
  ]);

  for (const kind of PHASE6_SCENE_DRAWING_KINDS) {
    assert.equal(isPhase6SceneDrawingKind(kind), true);
  }
  assert.equal(isPhase4SceneDrawingKind("freehand"), false);
  assert.equal(isPhase4SceneDrawingKind("highlighter"), false);
  assert.equal(isPhase6SceneDrawingKind("text"), false);
  assert.equal(isPhase6SceneDrawingKind(null), false);
});

test("Phase 6 detaches freehand compatibility primitives from chart ownership", () => {
  const phase4Line = primitive({ _lineType: "line-segment" });
  const phase4Shape = primitive({ _shapeType: "rectangle" });
  const freehand = primitive({ _type: "freehand" });
  const highlighter = primitive({ _type: "highlighter" });
  const highlighterGetterShape = primitive({ type: "highlighter" });
  const legacyText = primitive({ _type: "text" });

  assert.equal(isPhase4SceneDrawingPrimitive(phase4Line), true);
  assert.equal(isPhase4SceneDrawingPrimitive(phase4Shape), true);
  assert.equal(isPhase4SceneDrawingPrimitive(freehand), false);
  assert.equal(isPhase4SceneDrawingPrimitive(highlighter), false);

  for (const migrated of [
    phase4Line,
    phase4Shape,
    freehand,
    highlighter,
    highlighterGetterShape,
  ]) {
    assert.equal(isPhase6SceneDrawingPrimitive(migrated), true);
  }
  assert.equal(isPhase6SceneDrawingPrimitive(legacyText), false);
  assert.equal(isPhase6SceneDrawingPrimitive(null), false);
});
