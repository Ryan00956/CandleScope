import assert from "node:assert/strict";
import test from "node:test";

import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "../drawingDisplayList.js";
import { drawFibonacciSceneEntity } from "../drawingSceneFibonacciPainter.js";

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
    fillRect: (x: number, y: number, width: number, height: number) => (
      record("fillRect", x, y, width, height)
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

function fibonacciFixture(selected = true): {
  readonly entity: DrawingDisplayEntity;
  readonly list: DrawingScreenDisplayList;
} {
  // Prefix data proves every render-spec offset is entity-local. Levels are
  // deliberately emitted out of Y order to exercise legacy band sorting.
  const points = new Float64Array([
    999, 999,
    10, 20, 50, 80,
    10, 80, 50, 80,
    10, 20, 50, 20,
    10, 50, 50, 50,
  ]);
  const entity = {
    id: "fibonacci",
    kind: "fibonacci",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "fibonacci", color: "#3b82f6", lineWidth: 2 },
    renderSpec: {
      op: "fibonacci",
      strokeColor: "#3b82f6",
      selectionHighlightColor: "rgba(59,130,246,0.15)",
      lineWidthCssPx: 2,
      selected,
      trendPointOffset: 0,
      startPrice: 100,
      endPrice: 200,
      levelLines: [
        { color: "#f44336", level: 1, logicalPrice: 200, pointOffset: 2 },
        { color: "#787b86", level: 0, logicalPrice: 100, pointOffset: 4 },
        { color: "#4caf50", level: 0.5, logicalPrice: 150.125, pointOffset: 6 },
      ],
    },
    pointOffset: 1,
    pointCount: 8,
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

function findCall(
  calls: readonly CanvasCall[],
  name: string,
  values: readonly (number | string)[],
): CanvasCall | undefined {
  return calls.find((call) => call.name === name && assertValues(call.values, values));
}

for (const ratio of [1, 1.5, 2]) {
  test(`fibonacci scene painter scales trend, bands, labels and handles at DPR ${ratio}`, () => {
    const { entity, list } = fibonacciFixture(true);
    const { calls, context } = recordingContext();
    drawFibonacciSceneEntity(context, entity, list, ratio, ratio);

    assert.ok(findCall(calls, "setLineDash", [4 * ratio, 4 * ratio]));
    assert.ok(findCall(calls, "setLineDash", []));
    assert.ok(findCall(calls, "globalAlpha", [0.1]));
    assert.ok(findCall(calls, "moveTo", [10 * ratio, 20 * ratio]));
    assert.ok(findCall(calls, "lineTo", [50 * ratio, 80 * ratio]));
    assert.deepEqual(
      calls.filter((call) => call.name === "fillRect").map((call) => call.values),
      [
        [10 * ratio, 20 * ratio, 40 * ratio, 30 * ratio],
        [10 * ratio, 50 * ratio, 40 * ratio, 30 * ratio],
      ],
    );
    assert.ok(findCall(calls, "fillStyle", ["#4caf50"]), "first band uses lower band's color");
    assert.ok(findCall(calls, "fillStyle", ["#f44336"]), "second band uses lower band's color");
    assert.ok(findCall(calls, "font", [`${11 * ratio}px sans-serif`]));
    assert.ok(findCall(calls, "fillText", ["0 (100.00)", 14 * ratio, 18 * ratio]));
    assert.ok(findCall(calls, "fillText", ["0.5 (150.13)", 14 * ratio, 48 * ratio]));
    assert.ok(findCall(calls, "fillText", ["1 (200.00)", 14 * ratio, 78 * ratio]));
    assert.deepEqual(
      calls.filter((call) => call.name === "arc").map((call) => call.values),
      [
        [10 * ratio, 20 * ratio, 6 * ratio],
        [50 * ratio, 80 * ratio, 6 * ratio],
      ],
    );
    assert.ok(findCall(calls, "lineWidth", [16 * ratio]), "selected trend halo");
    assert.ok(findCall(calls, "strokeStyle", ["rgba(59,130,246,0.15)"]));
  });
}

test("fibonacci scene painter keeps legacy non-selected endpoint dots", () => {
  const { entity, list } = fibonacciFixture(false);
  const { calls, context } = recordingContext();
  drawFibonacciSceneEntity(context, entity, list, 1, 1);

  assert.deepEqual(
    calls.filter((call) => call.name === "arc").map((call) => call.values),
    [[10, 20, 3], [50, 80, 3]],
  );
  assert.ok(findCall(calls, "globalAlpha", [0.5]));
  assert.equal(findCall(calls, "fillStyle", ["#ffffff"]), undefined);
  assert.equal(findCall(calls, "strokeStyle", ["rgba(59,130,246,0.15)"]), undefined);
});

test("fibonacci scene painter fails closed before painting incomplete level geometry", () => {
  const { entity, list } = fibonacciFixture();
  const invalid = { ...entity, pointCount: 7 } as DrawingDisplayEntity;
  const { calls, context } = recordingContext();
  drawFibonacciSceneEntity(context, invalid, list, 1, 1);
  assert.deepEqual(calls, []);
});
