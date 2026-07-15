import assert from "node:assert/strict";
import test from "node:test";

import type { PrimitiveCanvasTarget } from "../../drawingTypes.js";
import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  createDrawingScreenDisplayList,
  withDrawingFreehandRaster,
} from "../drawingDisplayList.js";
import type { ProjectedDrawingEntity } from "../drawingDisplayList.js";
import { DrawingSceneRenderer } from "../drawingSceneRenderer.js";

const stamp: DrawingRenderRevisionStamp = Object.freeze({
  scopeKey: "paint",
  documentRevision: 1,
  surfaceGeneration: 1,
  dataRevision: 1,
  projectionRevision: 1,
  lineageIndexRevision: 1,
  viewportRevision: 1,
  themeRevision: 1,
  widthCssPx: 200,
  heightCssPx: 100,
  dpr: 1.5,
});

interface CanvasCall {
  readonly name: string;
  readonly values: readonly number[];
}

interface DrawImageState {
  readonly globalAlpha: number;
  readonly globalCompositeOperation: GlobalCompositeOperation;
}

function recordingTarget(
  horizontalPixelRatio = 1.5,
  verticalPixelRatio = 2,
): {
  calls: CanvasCall[];
  context: CanvasRenderingContext2D;
  drawImageStates: DrawImageState[];
  target: PrimitiveCanvasTarget;
} {
  const calls: CanvasCall[] = [];
  const drawImageStates: DrawImageState[] = [];
  const contextState: DrawImageState = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
  const record = (name: string, ...values: number[]) => { calls.push({ name, values }); };
  const context = {
    save: () => record("save"),
    restore: () => record("restore"),
    beginPath: () => record("beginPath"),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
    quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => (
      record("quadraticCurveTo", cpx, cpy, x, y)
    ),
    stroke: () => record("stroke"),
    fill: () => record("fill"),
    arc: (x: number, y: number, radius: number) => record("arc", x, y, radius),
    ellipse: (x: number, y: number, rx: number, ry: number) => (
      record("ellipse", x, y, rx, ry)
    ),
    rect: (x: number, y: number, width: number, height: number) => (
      record("rect", x, y, width, height)
    ),
    strokeRect: (x: number, y: number, width: number, height: number) => (
      record("strokeRect", x, y, width, height)
    ),
    setLineDash: (values: number[]) => calls.push({ name: "setLineDash", values: [...values] }),
    drawImage: (_bitmap: CanvasImageSource, ...values: number[]) => {
      record("drawImage", ...values);
      drawImageStates.push({
        globalAlpha: contextState.globalAlpha,
        globalCompositeOperation: contextState.globalCompositeOperation,
      });
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    get globalAlpha() { return contextState.globalAlpha; },
    set globalAlpha(value: number) {
      (contextState as { globalAlpha: number }).globalAlpha = value;
    },
    get globalCompositeOperation() { return contextState.globalCompositeOperation; },
    set globalCompositeOperation(value: GlobalCompositeOperation) {
      (contextState as { globalCompositeOperation: GlobalCompositeOperation })
        .globalCompositeOperation = value;
    },
    shadowColor: "",
    shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D;
  const target = {
    useBitmapCoordinateSpace(callback: (scope: unknown) => void) {
      callback({
        context,
        horizontalPixelRatio,
        verticalPixelRatio,
        bitmapSize: { width: 300, height: 200 },
      });
    },
  } as unknown as PrimitiveCanvasTarget;
  return { calls, context, drawImageStates, target };
}

function lineEntity(lineType: "line-segment" | "line-ray" | "line-infinite"): ProjectedDrawingEntity {
  return {
    id: `line-${lineType}`,
    kind: "line",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "line", color: "#f59e0b", lineWidth: 2 },
    points: new Float64Array([10, 20, 100, 20, 10, 20, 100, 20]),
    bbox: [10, 20, 100, 20],
    renderSpec: {
      op: "line",
      lineType,
      strokeColor: "#f59e0b",
      selectionHighlightColor: "rgba(245,158,11,0.15)",
      lineWidthCssPx: 2,
      selected: false,
      mainPointOffset: 0,
      anchorPointOffset: 2,
      drawEndpointDots: lineType === "line-segment",
    },
  };
}

function freehandEntity({
  brushShape,
  compositeOperation,
  id,
  kind,
  opacity,
  points,
  pathInterpolation,
  selected = false,
}: {
  brushShape: "round" | "square";
  compositeOperation: GlobalCompositeOperation;
  id: string;
  kind: "freehand" | "highlighter";
  opacity: number;
  points: Float64Array;
  pathInterpolation?: "linear" | "quadratic";
  selected?: boolean;
}): ProjectedDrawingEntity {
  return {
    id,
    kind,
    geometryRevision: 1,
    styleRevision: 1,
    style: kind === "highlighter"
      ? {
          kind: "highlighter",
          color: "#fde047",
          lineWidth: 8,
          opacity,
          compositeOperation,
          brushShape,
        }
      : { kind: "freehand", color: "#60a5fa", lineWidth: 2 },
    points,
    bbox: [0, 0, 100, 100],
    renderSpec: {
      op: "freehand",
      strokeColor: kind === "highlighter" ? "#fde047" : "#60a5fa",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: kind === "highlighter" ? 8 : 2,
      opacity,
      compositeOperation,
      brushShape,
      ...(pathInterpolation ? { pathInterpolation } : {}),
      selected,
    },
  };
}

test("renderer consumes explicit ops in document order and uses native ellipse paint", () => {
  const axis: ProjectedDrawingEntity = {
    id: "axis",
    kind: "axis-line",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "axis-line", color: "#fff", lineWidth: 1 },
    points: new Float64Array([0, 30, 200, 30]),
    bbox: [0, 30, 200, 30],
    renderSpec: {
      op: "axis-line",
      axisLineType: "horizontal",
      strokeColor: "#fff",
      selectionHighlightColor: "rgba(255,255,255,0.18)",
      lineWidthCssPx: 1,
      selected: false,
      segmentPointOffset: 0,
      segmentCount: 1,
      anchorPointOffset: null,
    },
  };
  const shape: ProjectedDrawingEntity = {
    id: "ellipse",
    kind: "shape",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "shape", color: "#0af", lineWidth: 2 },
    points: new Float64Array([20, 40, 80, 90]),
    bbox: [20, 40, 80, 90],
    renderSpec: {
      op: "shape",
      shapeType: "ellipse",
      strokeColor: "#0af",
      fillPaintColor: "rgba(0,170,255,0.12)",
      lineWidthCssPx: 2,
      lineStyle: "dashed",
      selected: false,
      boxPointOffset: 0,
    },
  };
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(createDrawingScreenDisplayList(stamp, [lineEntity("line-segment"), axis, shape]));
  const { calls, target } = recordingTarget();
  renderer.draw(target);

  assert.equal(calls.filter((call) => call.name === "save").length, 3);
  assert.equal(calls.filter((call) => call.name === "arc").length, 2);
  assert.equal(calls.filter((call) => call.name === "ellipse").length, 2);
  assert.ok(calls.some((call) => call.name === "setLineDash"
    && call.values[0] === 9 && call.values[1] === 6));
  assert.equal(calls.filter((call) => call.name === "fill").length, 3);
});

test("ray and infinite lines extend from immutable anchors beyond the bitmap edge", () => {
  for (const lineType of ["line-ray", "line-infinite"] as const) {
    const renderer = new DrawingSceneRenderer();
    renderer.setPlan(createDrawingScreenDisplayList(stamp, [lineEntity(lineType)]));
    const { calls, target } = recordingTarget(1, 1);
    renderer.draw(target);
    const move = calls.find((call) => call.name === "moveTo");
    const line = calls.find((call) => call.name === "lineTo");
    assert.ok(move && line);
    assert.ok((line.values[0] ?? 0) > 300, `${lineType} must cross the right bitmap edge`);
    if (lineType === "line-infinite") {
      assert.ok((move.values[0] ?? 0) < 0, "infinite line must cross the left bitmap edge");
    } else {
      assert.equal(move.values[0], 10);
    }
    assert.equal(calls.some((call) => call.name === "arc"), false);
  }
});

test("round freehand paths smooth each finite run without bridging unresolved gaps", () => {
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(createDrawingScreenDisplayList(stamp, [freehandEntity({
    id: "round-gap",
    kind: "freehand",
    points: new Float64Array([
      0, 0,
      10, 10,
      20, 0,
      Number.NaN, Number.NaN,
      30, 30,
      40, 40,
    ]),
    opacity: 1,
    compositeOperation: "source-over",
    brushShape: "round",
  })]));
  const { calls, context, target } = recordingTarget(1, 1);
  renderer.draw(target);

  assert.deepEqual(
    calls.filter((call) => call.name === "moveTo").map((call) => call.values),
    [[0, 0], [30, 30]],
  );
  assert.deepEqual(
    calls.filter((call) => call.name === "lineTo").map((call) => call.values),
    [[40, 40]],
  );
  assert.equal(calls.filter((call) => call.name === "quadraticCurveTo").length, 2);
  assert.equal(calls.filter((call) => call.name === "stroke").length, 1);
  assert.equal(context.lineCap, "round");
  assert.equal(context.lineJoin, "round");
  assert.equal(context.globalCompositeOperation, "source-over");
  assert.equal(context.globalAlpha, 1);
});

test("square highlighter paths retain multiply compositing and linear segments", () => {
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(createDrawingScreenDisplayList(stamp, [freehandEntity({
    id: "multiply-highlighter",
    kind: "highlighter",
    points: new Float64Array([5, 10, 15, 20, 25, 30]),
    opacity: 0.35,
    compositeOperation: "multiply",
    brushShape: "square",
  })]));
  const { calls, context, target } = recordingTarget(2, 1.5);
  renderer.draw(target);

  assert.deepEqual(
    calls.filter((call) => call.name === "lineTo").map((call) => call.values),
    [[30, 30], [50, 45]],
  );
  assert.equal(calls.some((call) => call.name === "quadraticCurveTo"), false);
  assert.equal(context.lineCap, "square");
  assert.equal(context.lineJoin, "bevel");
  assert.equal(context.lineWidth, 12);
  assert.equal(context.globalCompositeOperation, "multiply");
  assert.equal(context.globalAlpha, 0.35);
  assert.equal(context.strokeStyle, "#fde047");
});

test("round LOD freehand keeps round paint while tracing certified linear segments", () => {
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(createDrawingScreenDisplayList(stamp, [freehandEntity({
    id: "round-linear-lod",
    kind: "freehand",
    points: new Float64Array([0, 0, 10, 10, 20, 0]),
    opacity: 1,
    compositeOperation: "source-over",
    brushShape: "round",
    pathInterpolation: "linear",
  })]));
  const { calls, context, target } = recordingTarget(1, 1);
  renderer.draw(target);

  assert.deepEqual(
    calls.filter((call) => call.name === "lineTo").map((call) => call.values),
    [[10, 10], [20, 0]],
  );
  assert.equal(calls.some((call) => call.name === "quadraticCurveTo"), false);
  assert.equal(context.lineCap, "round");
  assert.equal(context.lineJoin, "round");
});

test("worker freehand raster is consumed once and released when its plan is replaced", () => {
  let closeCount = 0;
  const bitmap = {
    width: 300,
    height: 200,
    close() { closeCount += 1; },
  } as unknown as ImageBitmap;
  const base = createDrawingScreenDisplayList(stamp, [
    freehandEntity({
      id: "worker-ink",
      kind: "freehand",
      points: new Float64Array([0, 0, 20, 20]),
      opacity: 1,
      compositeOperation: "source-over",
      brushShape: "round",
    }),
    freehandEntity({
      id: "worker-ink-second",
      kind: "freehand",
      points: new Float64Array([20, 20, 30, 25]),
      opacity: 1,
      compositeOperation: "source-over",
      brushShape: "round",
    }),
    lineEntity("line-segment"),
    freehandEntity({
      id: "worker-highlighter",
      kind: "highlighter",
      points: new Float64Array([5, 5, 25, 25]),
      opacity: 0.35,
      compositeOperation: "multiply",
      brushShape: "square",
    }),
  ]);
  const rasterPlan = withDrawingFreehandRaster(base, {
    bitmap,
    widthCssPx: stamp.widthCssPx,
    heightCssPx: stamp.heightCssPx,
    dpr: stamp.dpr,
    atlasWidthPhysicalPx: 300,
    atlasHeightPhysicalPx: 200,
    layers: Object.freeze([Object.freeze({
      entityIndex: 0,
      lastEntityIndex: 1,
      sourceXPhysicalPx: 0,
      sourceYPhysicalPx: 0,
      sourceWidthPhysicalPx: 60,
      sourceHeightPhysicalPx: 60,
      destinationXCssPx: 0,
      destinationYCssPx: 0,
      destinationWidthCssPx: 40,
      destinationHeightCssPx: 30,
      opacity: 1,
      compositeOperation: "source-over" as const,
    }), Object.freeze({
      entityIndex: 3,
      lastEntityIndex: 3,
      sourceXPhysicalPx: 60,
      sourceYPhysicalPx: 0,
      sourceWidthPhysicalPx: 60,
      sourceHeightPhysicalPx: 60,
      destinationXCssPx: 0,
      destinationYCssPx: 0,
      destinationWidthCssPx: 40,
      destinationHeightCssPx: 30,
      opacity: 0.35,
      compositeOperation: "multiply" as const,
    })]),
  });
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(rasterPlan);
  const { calls, drawImageStates, target } = recordingTarget();
  renderer.draw(target);

  const drawImageIndexes = calls.flatMap((call, index) => call.name === "drawImage" ? [index] : []);
  const lineIndex = calls.findIndex((call) => call.name === "moveTo");
  assert.equal(drawImageIndexes.length, 2);
  assert.ok((drawImageIndexes[0] ?? Infinity) < lineIndex
    && lineIndex < (drawImageIndexes[1] ?? -1), "atlas layers must preserve canonical z-order");
  assert.equal(calls.filter((call) => call.name === "moveTo").length, 1,
    "only the non-freehand line should remain on the main-thread paint path");
  assert.deepEqual(drawImageStates, [
    { globalAlpha: 1, globalCompositeOperation: "source-over" },
    { globalAlpha: 0.35, globalCompositeOperation: "multiply" },
  ]);
  assert.equal(closeCount, 0);
  renderer.setPlan(createDrawingScreenDisplayList({ ...stamp, viewportRevision: 2 }, []));
  assert.equal(closeCount, 1);
  renderer.setPlan(null);
  assert.equal(closeCount, 1);
});

test("selected worker raster preserves the selected highlight compositing contract", () => {
  const bitmap = {
    width: 300,
    height: 200,
    close() {},
  } as unknown as ImageBitmap;
  const base = createDrawingScreenDisplayList(stamp, [freehandEntity({
    id: "selected-worker-ink",
    kind: "freehand",
    points: new Float64Array([0, 0, 20, 20]),
    opacity: 1,
    compositeOperation: "source-over",
    brushShape: "round",
    selected: true,
  })]);
  const rasterPlan = withDrawingFreehandRaster(base, {
    bitmap,
    widthCssPx: stamp.widthCssPx,
    heightCssPx: stamp.heightCssPx,
    dpr: stamp.dpr,
    atlasWidthPhysicalPx: 300,
    atlasHeightPhysicalPx: 200,
    layers: Object.freeze([Object.freeze({
      entityIndex: 0,
      lastEntityIndex: 0,
      sourceXPhysicalPx: 0,
      sourceYPhysicalPx: 0,
      sourceWidthPhysicalPx: 60,
      sourceHeightPhysicalPx: 60,
      destinationXCssPx: 0,
      destinationYCssPx: 0,
      destinationWidthCssPx: 40,
      destinationHeightCssPx: 40,
      opacity: 0.6,
      compositeOperation: "source-over" as const,
    })]),
  });
  const renderer = new DrawingSceneRenderer();
  renderer.setPlan(rasterPlan);
  const { drawImageStates, target } = recordingTarget();
  renderer.draw(target);
  assert.deepEqual(drawImageStates, [{
    globalAlpha: 0.6,
    globalCompositeOperation: "source-over",
  }]);
});

test("renderer acknowledges only non-null plans after their canvas draw completes", () => {
  const order: string[] = [];
  const acknowledged: unknown[] = [];
  const renderer = new DrawingSceneRenderer((plan) => {
    order.push("ack");
    acknowledged.push(plan);
  });
  const recorded = recordingTarget(1, 1);
  const target = {
    useBitmapCoordinateSpace(callback: Parameters<PrimitiveCanvasTarget["useBitmapCoordinateSpace"]>[0]) {
      order.push("canvas-start");
      recorded.target.useBitmapCoordinateSpace(callback);
      order.push("canvas-end");
    },
  } as PrimitiveCanvasTarget;

  renderer.draw(target);
  assert.deepEqual(order, []);

  const nonEmpty = createDrawingScreenDisplayList(stamp, [lineEntity("line-segment")]);
  renderer.setPlan(nonEmpty);
  renderer.draw(target);
  assert.deepEqual(order, ["canvas-start", "canvas-end", "ack"]);
  assert.strictEqual(acknowledged[0], nonEmpty);

  let emptyTargetUsed = false;
  const empty = createDrawingScreenDisplayList({ ...stamp, documentRevision: 2 }, []);
  renderer.setPlan(empty);
  renderer.draw({
    useBitmapCoordinateSpace() { emptyTargetUsed = true; },
  } as unknown as PrimitiveCanvasTarget);
  assert.equal(emptyTargetUsed, false);
  assert.strictEqual(acknowledged[1], empty);
});

test("renderer does not acknowledge when bitmap drawing throws", () => {
  let acknowledgements = 0;
  const renderer = new DrawingSceneRenderer(() => { acknowledgements += 1; });
  renderer.setPlan(createDrawingScreenDisplayList(stamp, [lineEntity("line-segment")]));
  assert.throws(() => renderer.draw({
    useBitmapCoordinateSpace() { throw new Error("bitmap unavailable"); },
  } as unknown as PrimitiveCanvasTarget), /bitmap unavailable/);
  assert.equal(acknowledgements, 0);
});
