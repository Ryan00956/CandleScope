import assert from "node:assert/strict";
import test from "node:test";

import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "../drawingDisplayList.js";
import { drawAngleSceneEntity } from "../drawingSceneAnglePainter.js";

interface CanvasCall {
  readonly name: string;
  readonly values: readonly (number | string)[];
}

function recordingContext(): {
  readonly calls: CanvasCall[];
  readonly context: CanvasRenderingContext2D;
} {
  const calls: CanvasCall[] = [];
  const record = (name: string, ...values: readonly (number | string)[]) => {
    calls.push(Object.freeze({ name, values: Object.freeze([...values]) }));
  };
  let fillStyle: string | CanvasGradient | CanvasPattern = "";
  let font = "";
  let globalAlpha = 1;
  let lineCap: CanvasLineCap = "butt";
  let lineJoin: CanvasLineJoin = "miter";
  let lineWidth = 1;
  let shadowBlur = 0;
  let shadowColor = "";
  let strokeStyle: string | CanvasGradient | CanvasPattern = "";
  let textAlign: CanvasTextAlign = "start";
  let textBaseline: CanvasTextBaseline = "alphabetic";
  const context = {
    save: () => record("save"),
    restore: () => record("restore"),
    beginPath: () => record("beginPath"),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
    stroke: () => record("stroke"),
    fill: () => record("fill"),
    arc: (x: number, y: number, radius: number) => record("arc", x, y, radius),
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => (
      record("roundRect", x, y, width, height, radius)
    ),
    setLineDash: (values: number[]) => record("setLineDash", ...values),
    fillText: (text: string, x: number, y: number) => record("fillText", text, x, y),
    get fillStyle() { return fillStyle; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
      if (typeof value === "string") record("fillStyle", value);
    },
    get font() { return font; },
    set font(value: string) { font = value; record("font", value); },
    get globalAlpha() { return globalAlpha; },
    set globalAlpha(value: number) { globalAlpha = value; record("globalAlpha", value); },
    get lineCap() { return lineCap; },
    set lineCap(value: CanvasLineCap) { lineCap = value; record("lineCap", value); },
    get lineJoin() { return lineJoin; },
    set lineJoin(value: CanvasLineJoin) { lineJoin = value; record("lineJoin", value); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value: number) { lineWidth = value; record("lineWidth", value); },
    get shadowBlur() { return shadowBlur; },
    set shadowBlur(value: number) { shadowBlur = value; record("shadowBlur", value); },
    get shadowColor() { return shadowColor; },
    set shadowColor(value: string) { shadowColor = value; record("shadowColor", value); },
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      strokeStyle = value;
      if (typeof value === "string") record("strokeStyle", value);
    },
    get textAlign() { return textAlign; },
    set textAlign(value: CanvasTextAlign) { textAlign = value; record("textAlign", value); },
    get textBaseline() { return textBaseline; },
    set textBaseline(value: CanvasTextBaseline) {
      textBaseline = value;
      record("textBaseline", value);
    },
  } as unknown as CanvasRenderingContext2D;
  return { calls, context };
}

function angleFixture(selected = true): {
  readonly entity: DrawingDisplayEntity;
  readonly list: DrawingScreenDisplayList;
} {
  // The first pair is unrelated prefix data, proving all spec offsets are
  // resolved relative to entity.pointOffset rather than the display-list root.
  const points = new Float64Array([
    999, 999,
    10, 20, 50, 40,
    10, 20, 42, 20,
    28, 20, 22, 30, 10, 38,
    12, 44, 42, 61,
  ]);
  const entity = {
    id: "angle",
    kind: "angle-measure",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "angle-measure", color: "#3b82f6", lineWidth: 2 },
    renderSpec: {
      op: "angle",
      strokeColor: "#3b82f6",
      selectionHighlightColor: "rgba(59,130,246,0.18)",
      lineWidthCssPx: 2,
      selected,
      rayPointOffset: 0,
      baselinePointOffset: 2,
      arcPointOffset: 4,
      arcPointCount: 3,
      labelBoxPointOffset: 7,
      labelText: "26.6°",
    },
    pointOffset: 1,
    pointCount: 9,
    handleOffset: 0,
    handleCount: 0,
    handleNames: [],
    handleResults: null,
    handleTolerance: 0,
    pathBreakOffset: 0,
    pathBreakCount: 0,
    unresolvedGapOffset: 0,
    unresolvedGapCount: 0,
    canonicalGapCoverageComplete: true,
    hitZones: [],
    unboundedAxis: null,
  } as unknown as DrawingDisplayEntity;
  return {
    entity,
    list: { points } as unknown as DrawingScreenDisplayList,
  };
}

function findCall(
  calls: readonly CanvasCall[],
  name: string,
  values: readonly (number | string)[],
): CanvasCall | undefined {
  return calls.find((call) => call.name === name && assertValues(call.values, values));
}

function assertValues(
  actual: readonly (number | string)[],
  expected: readonly (number | string)[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((value, index) => {
    const candidate = actual[index];
    return typeof value === "number" && typeof candidate === "number"
      ? Math.abs(candidate - value) < 1e-9
      : candidate === value;
  });
}

for (const ratio of [1, 1.5, 2]) {
  test(`angle scene painter scales ray, arc, label and selected handles at DPR ${ratio}`, () => {
    const { entity, list } = angleFixture(true);
    const { calls, context } = recordingContext();
    drawAngleSceneEntity(context, entity, list, ratio, ratio);

    assert.ok(findCall(calls, "moveTo", [10 * ratio, 20 * ratio]));
    assert.ok(findCall(calls, "lineTo", [50 * ratio, 40 * ratio]));
    assert.ok(findCall(calls, "lineTo", [42 * ratio, 20 * ratio]));
    assert.ok(findCall(calls, "lineTo", [22 * ratio, 30 * ratio]));
    assert.ok(findCall(calls, "lineTo", [10 * ratio, 38 * ratio]));
    assert.ok(findCall(calls, "setLineDash", [4 * ratio, 4 * ratio]));
    assert.ok(findCall(calls, "roundRect", [
      12 * ratio,
      44 * ratio,
      30 * ratio,
      17 * ratio,
      4 * ratio,
    ]));
    assert.ok(findCall(calls, "fillText", ["26.6°", 27 * ratio, 53 * ratio]));
    assert.ok(findCall(calls, "font", [`600 ${11 * ratio}px sans-serif`]));
    assert.ok(findCall(calls, "lineWidth", [12 * ratio]), "selected ray halo");
    assert.ok(findCall(calls, "lineWidth", [1.7 * ratio]), "arc stroke width");
    assert.deepEqual(
      calls.filter((call) => call.name === "arc").map((call) => call.values),
      [
        [10 * ratio, 20 * ratio, 6 * ratio],
        [50 * ratio, 40 * ratio, 6 * ratio],
      ],
    );
    assert.ok(findCall(calls, "strokeStyle", ["rgba(59,130,246,0.18)"]));
  });
}

test("angle scene painter keeps legacy non-selected endpoint dots", () => {
  const { entity, list } = angleFixture(false);
  const { calls, context } = recordingContext();
  drawAngleSceneEntity(context, entity, list, 1, 1);
  assert.deepEqual(
    calls.filter((call) => call.name === "arc").map((call) => call.values),
    [[10, 20, 3.5], [50, 40, 3.5]],
  );
  assert.ok(findCall(calls, "fillStyle", ["rgba(59,130,246,0.5)"]));
  assert.equal(findCall(calls, "strokeStyle", ["rgba(59,130,246,0.18)"]), undefined);
});

test("angle scene painter fails closed before painting incomplete projected geometry", () => {
  const { entity, list } = angleFixture();
  const invalid = {
    ...entity,
    pointCount: 5,
  } as DrawingDisplayEntity;
  const { calls, context } = recordingContext();
  drawAngleSceneEntity(context, invalid, list, 1, 1);
  assert.deepEqual(calls, []);
});
