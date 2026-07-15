import assert from "node:assert/strict";
import test from "node:test";

import type { PrimitiveCanvasTarget } from "../../drawingTypes.js";
import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  createDrawingScreenDisplayList,
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

function recordingTarget(
  horizontalPixelRatio = 1.5,
  verticalPixelRatio = 2,
): { calls: CanvasCall[]; target: PrimitiveCanvasTarget } {
  const calls: CanvasCall[] = [];
  const record = (name: string, ...values: number[]) => { calls.push({ name, values }); };
  const context = {
    save: () => record("save"),
    restore: () => record("restore"),
    beginPath: () => record("beginPath"),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
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
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
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
  return { calls, target };
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
