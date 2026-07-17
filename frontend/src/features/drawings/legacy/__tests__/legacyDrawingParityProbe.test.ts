import assert from "node:assert/strict";
import test from "node:test";

import { isOrdinalAxisTime } from "../../../../chart-adapter/coordinateBridge.js";
import { structuralMock } from "../../../../test/testHelpers.js";
import { createPrimitiveFromSavedDrawing } from "../../drawingPrimitiveFactory.js";
import { serializeDrawingPrimitive } from "../../drawingPersistence.js";
import type {
  DrawingAttachedParameter,
  DrawingPrimitive,
  FreehandStrokeV2,
  PrimitiveCanvasTarget,
} from "../../drawingTypes.js";
import { AngleMeasurementPrimitive } from "../../primitives/AngleMeasurementPrimitive.js";
import { AxisLineDrawingPrimitive } from "../../primitives/AxisLineDrawingPrimitive.js";
import { FibonacciDrawingPrimitive } from "../../primitives/FibonacciDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "../../primitives/FreehandDrawingPrimitive.js";
import { LineDrawingPrimitive } from "../../primitives/LineDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "../../primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "../../primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "../../primitives/TextDrawingPrimitive.js";
import { captureLegacyDrawingParityProbe } from "../legacyDrawingParityProbe.js";

type BitmapScope = Parameters<
  Parameters<PrimitiveCanvasTarget["useBitmapCoordinateSpace"]>[0]
>[0];

function fakeCanvasContext(): CanvasRenderingContext2D {
  const target: Record<PropertyKey, unknown> = {
    measureText: (value: string) => ({ width: value.length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getLineDash: () => [],
  };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      return () => {};
    },
    set(object, key, value) {
      object[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function installFakeDocument(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ getContext: () => fakeCanvasContext() }),
      querySelector: () => null,
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  };
}

const DEFAULT_TIME_ROWS = [5, 10, 20, 25, 30, 35, 40, 45, 50, 60, 65, 70, 75, 80, 90, 95]
  .map((time) => ({ time }));

function attachedParameter(
  timeToCoordinate: (time: unknown) => number | null = (time) => (
    typeof time === "number" ? time : null
  ),
  rows: readonly unknown[] = DEFAULT_TIME_ROWS,
): DrawingAttachedParameter {
  return structuralMock<DrawingAttachedParameter>({
    chart: structuralMock<DrawingAttachedParameter["chart"]>({
      chartElement: () => null,
      timeScale: () => ({
        options: () => ({ barSpacing: 24 }),
        timeToCoordinate,
      }),
    }),
    series: structuralMock<DrawingAttachedParameter["series"]>({
      data: () => rows,
      dataByIndex: () => null,
      priceToCoordinate: (price: number) => price,
    }),
    requestUpdate: () => {},
  });
}

function paint(
  primitives: readonly DrawingPrimitive[],
  width = 100,
  height = 100,
  pixelRatio = 1,
): void {
  const context = fakeCanvasContext();
  const scope = structuralMock<BitmapScope>({
    context,
    horizontalPixelRatio: pixelRatio,
    verticalPixelRatio: pixelRatio,
    bitmapSize: { width: width * pixelRatio, height: height * pixelRatio },
    mediaSize: { width, height },
  });
  const target = structuralMock<PrimitiveCanvasTarget>({
    useBitmapCoordinateSpace: (draw: (value: BitmapScope) => void): void => { draw(scope); },
  });
  for (const primitive of primitives) {
    primitive.updateAllViews();
    for (const view of primitive.paneViews()) {
      const renderer = view.renderer();
      if (!renderer) throw new Error("legacy renderer is unavailable");
      renderer.draw(target);
    }
  }
}

test("last-painted legacy snapshots cover all nine kinds and call real hit semantics", () => {
  const restoreDocument = installFakeDocument();
  try {
    const primitives: DrawingPrimitive[] = [
      new LineDrawingPrimitive({
        id: "line",
        dataPoints: [{ time: 5, price: 5 }, { time: 35, price: 5 }],
      }),
      new AxisLineDrawingPrimitive({
        id: "axis",
        axisLineType: "horizontal",
        dataPoint: { time: 40, price: 60 },
      }),
      new AngleMeasurementPrimitive({
        id: "angle",
        dataPoints: [{ time: 5, price: 25 }, { time: 35, price: 35 }],
      }),
      new TextDrawingPrimitive({ id: "text", dataPoint: { time: 40, price: 15 }, text: "Hi" }),
      new FibonacciDrawingPrimitive({
        id: "fib",
        dataPoints: [{ time: 60, price: 10 }, { time: 90, price: 30 }],
      }),
      new PositionDrawingPrimitive({
        id: "position",
        entryPrice: 45,
        tpPrice: 35,
        slPrice: 50,
        timeRange: { start: { time: 60 }, end: { time: 90 } },
        infoPanelOffset: { x: 200, y: 0 },
      }),
      new ShapeDrawingPrimitive({
        id: "shape",
        selected: true,
        dataPoints: [{ time: 5, price: 65 }, { time: 35, price: 95 }],
      }),
      new FreehandDrawingPrimitive({
        id: "freehand",
        dataPoints: [{ time: 45, price: 80 }, { time: 60, price: 90 }],
      }),
      new FreehandDrawingPrimitive({
        id: "highlighter",
        type: "highlighter",
        brushShape: "round",
        dataPoints: [{ time: 75, price: 80 }, { time: 95, price: 90 }],
      }),
    ];
    const attached = attachedParameter();
    for (const primitive of primitives) primitive.attached(attached);
    paint(primitives);

    const result = captureLegacyDrawingParityProbe(primitives, {
      widthCssPx: 100,
      heightCssPx: 100,
      maxHitProbes: 64,
    });
    assert.equal(result.errorCount, 0);
    assert.equal(result.skippedCount, 0, JSON.stringify(result.issues));
    assert.deepEqual(result.issues, []);
    assert.deepEqual(
      result.legacyLayouts.map((layout) => layout.kind),
      ["line", "axis-line", "angle-measure", "text", "fibonacci", "position", "shape", "freehand", "highlighter"],
    );
    assert.deepEqual(
      result.serializedDrawings.map((drawing) => [drawing.id, drawing.type]),
      [
        ["line", "line"], ["axis", "axis-line"], ["angle", "angle-measure"],
        ["text", "text"], ["fib", "fibonacci"], ["position", "position"],
        ["shape", "shape"], ["freehand", "freehand"], ["highlighter", "highlighter"],
      ],
    );
    const layouts = new Map(result.legacyLayouts.map((layout) => [layout.entityId, layout]));
    assert.deepEqual(layouts.get("line")?.bbox, [5, 5, 35, 5]);
    assert.deepEqual(layouts.get("axis")?.bbox, [0, 60, 100, 60]);
    assert.deepEqual(layouts.get("shape")?.handleNames, ["tl", "t", "tr", "r", "br", "b", "bl", "l"]);
    assert.deepEqual(layouts.get("freehand")?.unresolvedGapIndexes, []);
    assert.equal(result.hitProbes.length > 9, true);
    for (const primitive of primitives) {
      const expectedKind = serializeDrawingPrimitive(primitive)?.type;
      const isolated = captureLegacyDrawingParityProbe([primitive], {
        widthCssPx: 100,
        heightCssPx: 100,
        maxHitProbes: 8,
      });
      assert.equal(
        isolated.hitProbes.some((probe) => probe.legacy?.kind === expectedKind),
        true,
        `missing real legacy hit for ${expectedKind}`,
      );
    }

    const lineBody = result.hitProbes.find((probe) => probe.x === 20 && probe.y === 5);
    assert.deepEqual(lineBody?.legacy, {
      entityId: "line",
      kind: "line",
      hit: { pointIndex: -1 },
    });
    const shapeHandle = result.hitProbes.find((probe) => probe.x === 5 && probe.y === 65);
    assert.deepEqual(shapeHandle?.legacy, {
      entityId: "shape",
      kind: "shape",
      hit: { pointIndex: -1, zone: "tl", handle: "tl" },
    });
    assert.equal(result.hitProbes.some((probe) => probe.legacy?.kind === "freehand"), true);
    assert.equal(result.hitProbes.some((probe) => probe.legacy?.kind === "highlighter"), true);
  } finally {
    restoreDocument();
  }
});

test("offscreen horizontal and vertical axis lines are not reported visible", () => {
  const primitives: DrawingPrimitive[] = [
    new AxisLineDrawingPrimitive({
      id: "vertical-offscreen",
      axisLineType: "vertical",
      dataPoint: { time: -100, price: 50 },
    }),
    new AxisLineDrawingPrimitive({
      id: "horizontal-offscreen",
      axisLineType: "horizontal",
      dataPoint: { time: 50, price: -10 },
    }),
  ];
  const attached = attachedParameter();
  for (const primitive of primitives) primitive.attached(attached);
  paint(primitives);
  const result = captureLegacyDrawingParityProbe(primitives, {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.deepEqual(result.legacyLayouts.map((layout) => ({
    id: layout.entityId,
    visible: layout.visible,
    bbox: layout.bbox,
  })), [
    { id: "vertical-offscreen", visible: false, bbox: null },
    { id: "horizontal-offscreen", visible: false, bbox: null },
  ]);
  assert.deepEqual(result.hitProbes, []);
});

test("legacy hit sampling broad-phases distant primitives without changing z-order ownership", () => {
  const bottom = new LineDrawingPrimitive({
    id: "bottom-line",
    dataPoints: [{ time: 10, price: 10 }, { time: 40, price: 10 }],
  });
  const distantTop = new LineDrawingPrimitive({
    id: "distant-top-line",
    dataPoints: [{ time: 80, price: 90 }, { time: 90, price: 90 }],
  });
  const attached = attachedParameter();
  bottom.attached(attached);
  distantTop.attached(attached);
  paint([bottom, distantTop]);

  let distantHitCalls = 0;
  const originalHit = distantTop.hitTestGeometry.bind(distantTop);
  Object.defineProperty(distantTop, "hitTestGeometry", {
    configurable: true,
    value: (x: number, y: number) => {
      distantHitCalls += 1;
      return originalHit(x, y);
    },
  });

  const result = captureLegacyDrawingParityProbe([bottom, distantTop], {
    widthCssPx: 100,
    heightCssPx: 100,
    maxHitProbes: 1,
  });
  assert.equal(distantHitCalls, 0);
  assert.deepEqual(result.hitProbes[0]?.legacy, {
    entityId: "bottom-line",
    kind: "line",
    hit: { pointIndex: -1 },
  });
});

test("two-point probes preserve canonical source indexes when later extra points resolve", () => {
  const primitive = new LineDrawingPrimitive({
    id: "three-point-line",
    dataPoints: [
      { time: 10, price: 10 },
      { time: 20, price: 20 },
      { time: 30, price: 30 },
    ],
  });
  primitive.attached(attachedParameter((time) => (
    typeof time === "number" && time !== 10 ? time : null
  )));
  paint([primitive]);

  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.equal(result.errorCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.legacyLayouts[0], {
    entityId: "three-point-line",
    kind: "line",
    visible: false,
    bbox: null,
    handles: new Float64Array(),
    handleNames: [],
    unresolvedGapIndexes: [],
  });
});

test("freehand parity retains exact unresolved source indexes and never bridges hit probes", () => {
  const rows = [
    {
      time: { order: 0, sourceTime: 100, sourceOrdinal: 0 },
      customValues: { chartProjection: {
        projectorId: "renko", sourceFromTime: 100, sourceOrdinal: 0, sourceToTime: 100, synthetic: true,
      } },
    },
    {
      time: { order: 1, sourceTime: 200, sourceOrdinal: 0 },
      customValues: { chartProjection: {
        projectorId: "renko", sourceFromTime: 101, sourceOrdinal: 0, sourceToTime: 200, synthetic: true,
      } },
    },
  ];
  const stroke: FreehandStrokeV2 = {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "old-renko",
    spans: [{
      exact: {
        left: { time: 100, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 0 },
      },
      fallback: { fromTime: 100, toTime: 200, leftRatio: 0.25, rightRatio: 0.75 },
    }, {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: { fromTime: 300, toTime: 400, leftRatio: 0.25, rightRatio: 0.75 },
    }],
    points: [
      { span: 0, ratio: 0, price: 20 },
      { span: 0, ratio: 0.2, price: 20 },
      { span: 1, ratio: 0.5, price: 20 },
      { span: 0, ratio: 0.8, price: 20 },
      { span: 0, ratio: 1, price: 20 },
    ],
  };
  const primitive = new FreehandDrawingPrimitive({ id: "gap", stroke });
  primitive.attached(attachedParameter(
    (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    rows,
  ));
  paint([primitive]);
  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.deepEqual(result.legacyLayouts[0]?.unresolvedGapIndexes, [2]);
  assert.equal(result.hitProbes.length > 0, true);
  assert.equal(result.hitProbes.every((probe) => probe.legacy?.hit.body === true), true);
});

test("freehand parity clips disconnected paths before taking their visible union", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "disconnected-paths",
    dataPoints: [{ time: 10, price: 10 }, { time: 15, price: 15 }],
  });
  primitive.attached(attachedParameter());
  paint([primitive]);
  Object.defineProperty(primitive, "getParityScreenSnapshot", {
    configurable: true,
    value: () => ({
      hidden: false,
      paths: [
        [{ x: 10, y: 10 }, { x: 15, y: 15 }],
        [{ x: 30, y: -50 }, { x: 40, y: -40 }],
      ],
      unresolvedGapIndexes: [2],
    }),
  });

  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.deepEqual(result.legacyLayouts[0]?.bbox, [10, 10, 15, 15]);
  assert.deepEqual(result.legacyLayouts[0]?.unresolvedGapIndexes, [2]);
});

test("freehand hit probes skip offscreen leading segments and sample visible clipped geometry", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "long-offscreen-prefix",
    dataPoints: [
      ...Array.from({ length: 4_092 }, (_, index) => ({ time: index - 4_092, price: 1_000 })),
      { time: -10, price: 50 },
      { time: 10, price: 50 },
      { time: 20, price: 60 },
      { time: 30, price: 60 },
    ],
  });
  primitive.attached(attachedParameter());
  paint([primitive]);

  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.equal(result.errorCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.legacyLayouts[0]?.bbox, [0, 50, 30, 60]);
  assert.equal(result.hitProbes.length, 2);
  assert.equal(result.hitProbes.every((probe) => (
    probe.x >= 0 && probe.x <= 100 && probe.y >= 0 && probe.y <= 100
  )), true);
  assert.equal(result.hitProbes.every((probe) => (
    probe.legacy?.entityId === primitive.id && probe.legacy.hit.body === true
  )), true);
});

test("freehand parity hits reuse the coherent painted snapshot without reprojecting geometry", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "painted-hit-snapshot",
    dataPoints: [{ time: 10, price: 20 }, { time: 40, price: 20 }],
  });
  primitive.attached(attachedParameter());
  paint([primitive]);
  Object.defineProperty(primitive, "hitTestGeometry", {
    configurable: true,
    value: () => { throw new Error("parity must not reproject freehand geometry"); },
  });

  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.equal(result.errorCount, 0);
  assert.equal(result.hitProbes.length > 0, true);
  assert.equal(result.hitProbes.every((probe) => probe.legacy?.hit.body === true), true);
});

test("unpainted label geometry fails strict instead of mixing frame states", () => {
  const primitive = new AngleMeasurementPrimitive({
    id: "unpainted",
    dataPoints: [{ time: 10, price: 10 }, { time: 40, price: 20 }],
  });
  primitive.attached(attachedParameter());
  primitive.updateAllViews();
  const result = captureLegacyDrawingParityProbe([primitive], {
    widthCssPx: 100,
    heightCssPx: 100,
  });
  assert.deepEqual(result.legacyLayouts, []);
  assert.equal(result.skippedCount, 2);
  assert.deepEqual(result.issues.map((issue) => issue.stage), ["layout", "hit"]);
});

test("angle label geometry remains in CSS coordinates across DPR values", () => {
  const primitive = new AngleMeasurementPrimitive({
    id: "dpr-angle",
    dataPoints: [{ time: 10, price: 10 }, { time: 14, price: 14 }],
  });
  primitive.attached(attachedParameter());
  paint([primitive], 100, 100, 1);
  const first = primitive.getParityLabelBox();
  paint([primitive], 100, 100, 2);
  const second = primitive.getParityLabelBox();
  assert.ok(first && second);
  assert.ok(Math.abs((first.x + first.width / 2) - (second.x + second.width / 2)) < 1e-9);
  assert.ok(Math.abs((first.y + first.height / 2) - (second.y + second.height / 2)) < 1e-9);

  const tiny = new AngleMeasurementPrimitive({
    id: "tiny-dpr-angle",
    dataPoints: [{ time: 10, price: 10 }, { time: 10.3, price: 10.3 }],
  });
  tiny.attached(attachedParameter());
  paint([tiny], 100, 100, 2);
  assert.equal(tiny.getParityLabelBox(), null);
});

test("explicit round highlighter survives actual legacy primitive construction and serialization", () => {
  const primitive = createPrimitiveFromSavedDrawing({
    type: "highlighter",
    id: "round-highlighter",
    dataPoints: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
    brushShape: "round",
  });
  assert.equal(primitive instanceof FreehandDrawingPrimitive, true);
  if (!(primitive instanceof FreehandDrawingPrimitive)) return;
  assert.equal(primitive.brushShape, "round");
  const serialized = serializeDrawingPrimitive(primitive);
  assert.equal(serialized?.type, "highlighter");
  if (serialized?.type === "highlighter") assert.equal(serialized.brushShape, "round");
});
