import assert from "node:assert/strict";
import test from "node:test";

import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "../drawingDisplayList.js";
import { drawTextSceneEntity } from "../drawingSceneTextPainter.js";

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
  let lineWidth = 1;
  let strokeStyle: string | CanvasGradient | CanvasPattern = "";
  let textAlign: CanvasTextAlign = "start";
  let textBaseline: CanvasTextBaseline = "alphabetic";
  const context = {
    save: () => record("save"),
    restore: () => record("restore"),
    scale: (x: number, y: number) => record("scale", x, y),
    beginPath: () => record("beginPath"),
    closePath: () => record("closePath"),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
    quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => (
      record("quadraticCurveTo", cpx, cpy, x, y)
    ),
    fill: () => record("fill"),
    stroke: () => record("stroke"),
    fillText: (text: string, x: number, y: number) => record("fillText", text, x, y),
    strokeRect: (x: number, y: number, width: number, height: number) => (
      record("strokeRect", x, y, width, height)
    ),
    rect: (x: number, y: number, width: number, height: number) => (
      record("rect", x, y, width, height)
    ),
    setLineDash: (values: number[]) => record("setLineDash", ...values),
    get fillStyle() { return fillStyle; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
      if (typeof value === "string") record("fillStyle", value);
    },
    get font() { return font; },
    set font(value: string) { font = value; record("font", value); },
    get globalAlpha() { return globalAlpha; },
    set globalAlpha(value: number) { globalAlpha = value; record("globalAlpha", value); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value: number) { lineWidth = value; record("lineWidth", value); },
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

function textFixture({
  align = "left",
  selected = false,
  underline = true,
}: Readonly<{
  align?: "left" | "center" | "right";
  selected?: boolean;
  underline?: boolean;
}> = {}): {
  readonly entity: DrawingDisplayEntity;
  readonly list: DrawingScreenDisplayList;
} {
  // Prefix data proves boxPointOffset remains entity-local.
  const points = new Float64Array([999, 999, 10, 20, 130, 72]);
  const entity = {
    id: "text",
    kind: "text",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "text", text: "中文\nwrapped", fontSize: 14 },
    renderSpec: {
      op: "text",
      strokeColor: "#e2e8f0",
      lineWidthCssPx: 2,
      selected,
      boxPointOffset: 0,
      lines: [
        { text: "中文", widthCssPx: 28 },
        { text: "wrapped", widthCssPx: 56 },
      ],
      textColor: "#e2e8f0",
      fontSizeCssPx: 14,
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
      bold: true,
      italic: true,
      underline,
      align,
      backgroundColor: "rgba(15,23,42,0.8)",
      borderColor: "#94a3b8",
      borderWidthCssPx: 2,
      paddingCssPx: 6,
      lineHeightCssPx: 18.2,
      selectionColor: "#3b82f6",
    },
    pointOffset: 1,
    pointCount: 2,
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

function valuesEqual(
  actual: readonly (number | string)[],
  expected: readonly (number | string)[],
): boolean {
  return actual.length === expected.length && expected.every((value, index) => {
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
  return calls.find((call) => call.name === name && valuesEqual(call.values, values));
}

for (const ratio of [1, 1.5, 2]) {
  test(`text scene painter preserves CSS-pixel CJK and wrapped lines at DPR ${ratio}`, () => {
    const { entity, list } = textFixture();
    const { calls, context } = recordingContext();
    drawTextSceneEntity(context, entity, list, ratio, ratio);

    assert.ok(findCall(calls, "scale", [ratio, ratio]));
    assert.ok(findCall(calls, "font", ["italic bold 14px 'Inter', 'Segoe UI', sans-serif"]));
    assert.ok(findCall(calls, "textAlign", ["left"]));
    assert.ok(findCall(calls, "textBaseline", ["top"]));
    assert.ok(findCall(calls, "fillStyle", ["rgba(15,23,42,0.8)"]));
    assert.ok(findCall(calls, "strokeStyle", ["#94a3b8"]));
    assert.ok(findCall(calls, "lineWidth", [2]));
    assert.ok(findCall(calls, "fillText", ["中文", 16, 26]));
    assert.ok(findCall(calls, "fillText", ["wrapped", 16, 44.2]));
    assert.equal(calls.filter((call) => call.name === "quadraticCurveTo").length, 8);
    assert.deepEqual(calls.at(0), { name: "save", values: [] });
    assert.deepEqual(calls.at(-1), { name: "restore", values: [] });
  });
}

test("text scene painter applies center/right alignment and underline widths", () => {
  for (const [align, expectedX] of [
    ["center", [56, 42]],
    ["right", [96, 68]],
  ] as const) {
    const { entity, list } = textFixture({ align, underline: true });
    const { calls, context } = recordingContext();
    drawTextSceneEntity(context, entity, list, 1, 1);

    assert.ok(findCall(calls, "fillText", ["中文", expectedX[0], 26]));
    assert.ok(findCall(calls, "fillText", ["wrapped", expectedX[1], 44.2]));
    assert.ok(findCall(calls, "moveTo", [expectedX[0], 41]));
    assert.ok(findCall(calls, "lineTo", [expectedX[0] + 28, 41]));
    assert.ok(findCall(calls, "moveTo", [expectedX[1], 59.2]));
    assert.ok(findCall(calls, "lineTo", [expectedX[1] + 56, 59.2]));
    assert.ok(findCall(calls, "lineWidth", [1]));
  }
});

test("text scene painter draws the selected legacy bbox and eight square handles", () => {
  const { entity, list } = textFixture({ selected: true, underline: false });
  const { calls, context } = recordingContext();
  drawTextSceneEntity(context, entity, list, 1, 1);

  assert.ok(findCall(calls, "setLineDash", [4, 3]));
  assert.ok(findCall(calls, "setLineDash", []));
  assert.ok(findCall(calls, "strokeRect", [9.5, 19.5, 121, 53]));
  assert.ok(findCall(calls, "fillStyle", ["#ffffff"]));
  assert.ok(findCall(calls, "strokeStyle", ["#3b82f6"]));
  assert.ok(findCall(calls, "lineWidth", [1.25]));
  assert.deepEqual(
    calls.filter((call) => call.name === "rect").map((call) => call.values),
    [
      [6.5, 16.5, 7, 7],
      [66.5, 16.5, 7, 7],
      [126.5, 16.5, 7, 7],
      [126.5, 42.5, 7, 7],
      [126.5, 68.5, 7, 7],
      [66.5, 68.5, 7, 7],
      [6.5, 68.5, 7, 7],
      [6.5, 42.5, 7, 7],
    ],
  );
});

test("text scene painter fails closed before painting incomplete box geometry", () => {
  const { entity, list } = textFixture();
  const invalid = { ...entity, pointCount: 1 } as DrawingDisplayEntity;
  const { calls, context } = recordingContext();
  drawTextSceneEntity(context, invalid, list, 1, 1);
  assert.deepEqual(calls, []);
});
