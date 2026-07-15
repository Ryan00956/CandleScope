import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingPrimitive } from "../../drawingTypes.js";
import { TextDrawingPrimitive } from "../../primitives/TextDrawingPrimitive.js";
import {
  PHASE4_SCENE_DRAWING_KINDS,
  PHASE6_SCENE_DRAWING_KINDS,
  PHASE8_SCENE_DRAWING_KINDS,
  isPhase4SceneDrawingKind,
  isPhase4SceneDrawingPrimitive,
  isPhase6SceneDrawingKind,
  isPhase6SceneDrawingPrimitive,
  isPhase8SceneDrawingKind,
  isPhase8SceneDrawingPrimitive,
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

test("Phase 8 assigns static scene ownership to all nine drawing kinds", () => {
  assert.deepEqual([...PHASE8_SCENE_DRAWING_KINDS], [
    "line",
    "axis-line",
    "angle-measure",
    "text",
    "fibonacci",
    "position",
    "shape",
    "freehand",
    "highlighter",
  ]);
  for (const kind of PHASE8_SCENE_DRAWING_KINDS) {
    assert.equal(isPhase8SceneDrawingKind(kind), true);
  }
  assert.equal(isPhase8SceneDrawingKind("eraser"), false);
  assert.equal(isPhase8SceneDrawingKind(null), false);
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

test("Phase 8 recognizes every legacy compatibility primitive as scene-owned", () => {
  const candidates = [
    primitive({ _lineType: "line-segment" }),
    primitive({ _type: "axis-line" }),
    primitive({ _type: "angle-measure" }),
    primitive({ _type: "text" }),
    primitive({ _type: "fibonacci" }),
    primitive({ _type: "position" }),
    primitive({ _shapeType: "ellipse" }),
    primitive({ _type: "freehand" }),
    primitive({ type: "highlighter" }),
  ];
  for (const candidate of candidates) {
    assert.equal(isPhase8SceneDrawingPrimitive(candidate), true);
  }
  const realTextPrimitive = new TextDrawingPrimitive({
    id: "phase8-real-text",
    dataPoint: { time: 10, price: 20 },
    text: "Phase 8",
  });
  assert.equal(isPhase8SceneDrawingPrimitive(realTextPrimitive), true);
  assert.equal(isPhase8SceneDrawingPrimitive(null), false);
});
