import assert from "node:assert/strict";
import test from "node:test";

import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "../drawingDisplayList.js";
import { drawPositionSceneEntity } from "../drawingScenePositionPainter.js";

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
    closePath: () => record("closePath"),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
    stroke: () => record("stroke"),
    fill: () => record("fill"),
    arc: (x: number, y: number, radius: number) => record("arc", x, y, radius),
    fillRect: (x: number, y: number, width: number, height: number) => (
      record("fillRect", x, y, width, height)
    ),
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => (
      record("roundRect", x, y, width, height, radius)
    ),
    setLineDash: (values: number[]) => record("setLineDash", ...values),
    fillText: (text: string, x: number, y: number) => record("fillText", text, x, y),
    measureText: (text: string) => {
      record("measureText", text);
      return { width: text.length * 5 } as TextMetrics;
    },
    get fillStyle() { return fillStyle; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
      if (typeof value === "string") record("fillStyle", value);
    },
    get font() { return font; },
    set font(value: string) { font = value; record("font", value); },
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

interface PositionFixtureOptions {
  readonly direction?: "long" | "short";
  readonly includeSl?: boolean;
  readonly includeTp?: boolean;
  readonly selected?: boolean;
}

function positionFixture({
  direction = "long",
  includeSl = true,
  includeTp = true,
  selected = true,
}: PositionFixtureOptions = {}): {
  readonly entity: DrawingDisplayEntity;
  readonly list: DrawingScreenDisplayList;
} {
  // Prefix coordinates prove every spec offset is entity-local.
  const points = new Float64Array([
    999, 999,
    10, 100, 120, 100,
    10, 40, 120, 40,
    10, 40, 120, 100,
    10, 160, 120, 160,
    10, 100, 120, 160,
    20, 4, 112, 67,
  ]);
  const longTp = {
    linePointOffset: 2,
    bodyPointOffset: 4,
    priceText: "120.0000",
    percentText: "+20.00%",
    pnlText: "+200.00",
    color: "#00aa11",
  };
  const longSl = {
    linePointOffset: 6,
    bodyPointOffset: 8,
    priceText: "90.0000",
    percentText: "-10.00%",
    pnlText: "-100.00",
    color: "#dd0022",
  };
  const shortTp = {
    ...longSl,
    priceText: "90.0000",
    percentText: "+10.00%",
    pnlText: "+100.00",
  };
  const shortSl = {
    ...longTp,
    priceText: "110.0000",
    percentText: "-10.00%",
    pnlText: "-100.00",
  };
  const tpLevel = direction === "long" ? longTp : shortTp;
  const slLevel = direction === "long" ? longSl : shortSl;
  const handles: number[] = [999, 999, 65, 100];
  const handleNames = ["entry"];
  if (includeTp) {
    handles.push(65, direction === "long" ? 40 : 160);
    handleNames.push("tp");
  }
  if (includeSl) {
    handles.push(65, direction === "long" ? 160 : 40);
    handleNames.push("sl");
  }
  handles.push(10, 100, 120, 100);
  handleNames.push("left", "right");

  const entity = {
    id: "position",
    kind: "position",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "position", positionSize: 1_000 },
    renderSpec: {
      op: "position",
      strokeColor: "#2196f3",
      lineWidthCssPx: 2.5,
      selected,
      entryLinePointOffset: 0,
      entryColor: "#2196f3",
      upColor: "#00aa11",
      downColor: "#dd0022",
      direction,
      tpLevel: includeTp ? tpLevel : null,
      slLevel: includeSl ? slLevel : null,
      panelBoxPointOffset: 10,
      panelLines: [
        { label: "入场", value: "100.0000", extra: null, color: "#2196f3" },
        {
          label: "止盈",
          value: tpLevel.priceText,
          extra: tpLevel.pnlText,
          color: tpLevel.color,
        },
        {
          label: "止损",
          value: slLevel.priceText,
          extra: slLevel.pnlText,
          color: slLevel.color,
        },
      ],
      badgeText: direction === "long" ? "LONG" : "SHORT",
      badgeColor: direction === "long" ? "#00aa11" : "#dd0022",
    },
    pointOffset: 1,
    pointCount: 12,
    handleOffset: 1,
    handleCount: handleNames.length,
    handleNames,
    handleResults: handleNames.map(() => null),
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
    list: {
      points,
      handles: new Float64Array(handles),
    } as unknown as DrawingScreenDisplayList,
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
  test(`position scene painter scales selected long geometry at DPR ${ratio}`, () => {
    const { entity, list } = positionFixture({ direction: "long", selected: true });
    const { calls, context } = recordingContext();
    drawPositionSceneEntity(context, entity, list, ratio, ratio);

    assert.deepEqual(
      calls.filter((call) => call.name === "fillRect").map((call) => call.values),
      [
        [10 * ratio, 40 * ratio, 110 * ratio, 60 * ratio],
        [10 * ratio, 100 * ratio, 110 * ratio, 60 * ratio],
      ],
    );
    assert.ok(findCall(calls, "fillStyle", ["rgba(0,170,17,0.15)"]));
    assert.ok(findCall(calls, "fillStyle", ["rgba(221,0,34,0.15)"]));
    assert.ok(findCall(calls, "setLineDash", [6 * ratio, 3 * ratio]));
    assert.ok(findCall(calls, "moveTo", [10 * ratio, 100 * ratio]));
    assert.ok(findCall(calls, "lineTo", [120 * ratio, 100 * ratio]));
    assert.ok(findCall(calls, "fillText", [
      "120.0000  +20.00%  +200.00",
      130 * ratio,
      40 * ratio,
    ]));
    assert.ok(findCall(calls, "fillText", [
      "90.0000  -10.00%  -100.00",
      130 * ratio,
      160 * ratio,
    ]));
    assert.ok(findCall(calls, "roundRect", [
      20 * ratio,
      4 * ratio,
      92 * ratio,
      63 * ratio,
      6 * ratio,
    ]), "projected info panel box");
    assert.ok(findCall(calls, "fillText", ["入场: ", 28 * ratio, 18.5 * ratio]));
    assert.ok(findCall(calls, "setLineDash", [4 * ratio, 3 * ratio]), "selected panel border");
    assert.ok(findCall(calls, "roundRect", [
      14 * ratio,
      76 * ratio,
      48 * ratio,
      20 * ratio,
      4 * ratio,
    ]), "direction badge");
    assert.ok(findCall(calls, "fillText", ["LONG", 38 * ratio, 86 * ratio]));
    assert.ok(findCall(calls, "arc", [65 * ratio, 100 * ratio, 5 * ratio]));
    assert.ok(findCall(calls, "roundRect", [
      43 * ratio,
      37 * ratio,
      44 * ratio,
      6 * ratio,
      3 * ratio,
    ]), "TP drag bar");
    assert.ok(findCall(calls, "roundRect", [
      8 * ratio,
      88 * ratio,
      4 * ratio,
      24 * ratio,
      2 * ratio,
    ]), "left edge affordance");
    assert.ok(findCall(calls, "moveTo", [65 * ratio, 36 * ratio]), "long TP arrow points up");
    assert.ok(findCall(calls, "moveTo", [65 * ratio, 164 * ratio]), "long SL arrow points down");
  });
}

test("position scene painter uses short direction and supplied theme palette", () => {
  const { entity, list } = positionFixture({ direction: "short", selected: true });
  const { calls, context } = recordingContext();
  drawPositionSceneEntity(context, entity, list, 1, 1);

  assert.ok(findCall(calls, "fillStyle", ["#dd0022"]), "short badge uses down palette");
  assert.ok(findCall(calls, "fillText", ["SHORT", 38, 86]));
  assert.ok(findCall(calls, "fillText", ["90.0000  +10.00%  +100.00", 130, 160]));
  assert.ok(findCall(calls, "fillText", ["110.0000  -10.00%  -100.00", 130, 40]));
  assert.ok(findCall(calls, "moveTo", [65, 164]), "short TP arrow points down");
  assert.ok(findCall(calls, "moveTo", [65, 36]), "short SL arrow points up");
  assert.ok(findCall(calls, "fillStyle", ["rgba(221,0,34,0.15)"]));
  assert.ok(findCall(calls, "fillStyle", ["rgba(0,170,17,0.15)"]));
});

test("position scene painter omits TP and SL zones when both levels are absent", () => {
  const { entity, list } = positionFixture({
    includeSl: false,
    includeTp: false,
    selected: false,
  });
  const { calls, context } = recordingContext();
  drawPositionSceneEntity(context, entity, list, 1, 1);

  assert.deepEqual(calls.filter((call) => call.name === "fillRect"), []);
  assert.equal(findCall(calls, "setLineDash", [6, 3]), undefined);
  assert.ok(findCall(calls, "moveTo", [10, 100]));
  assert.ok(findCall(calls, "fillText", ["LONG", 38, 86]));
  assert.equal(findCall(calls, "arc", [65, 100, 5]), undefined);
});

test("position scene painter fails closed for malformed offsets or selected handles", () => {
  const { entity, list } = positionFixture({ selected: true });
  const malformedEntities = [
    { ...entity, pointCount: 11 } as DrawingDisplayEntity,
    {
      ...entity,
      handleNames: entity.handleNames.filter((name) => name !== "right"),
      handleCount: entity.handleCount - 1,
    } as DrawingDisplayEntity,
  ];
  for (const malformed of malformedEntities) {
    const { calls, context } = recordingContext();
    drawPositionSceneEntity(context, malformed, list, 1, 1);
    assert.deepEqual(calls, []);
  }
});
