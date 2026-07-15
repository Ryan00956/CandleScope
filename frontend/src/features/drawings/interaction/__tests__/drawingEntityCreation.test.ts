import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyDrawingCommands } from "../../core/drawingCommands.js";
import { exportDrawingDocument } from "../../core/drawingCodec.js";
import { createDrawingDocument } from "../../core/drawingDocument.js";
import { observeDrawingId } from "../../drawingModel.js";
import type {
  DrawingDataPoint,
  FreehandStrokeV3,
  SavedDrawing,
} from "../../drawingTypes.js";
import {
  createAxisLineSavedDrawing,
  createFinalizedFreehandSavedDrawing,
  createPositionSavedDrawing,
  createTextSavedDrawing,
  createTwoPointSavedDrawing,
  drawingCreateCommandsForSavedDrawing,
} from "../drawingEntityCreation.js";

const FUTURE_TIME = 4_102_444_800;
const SOURCE_ANCHOR = {
  time: 1_700_000_000,
  sourceOrdinal: 7,
  sourceProjection: "renko",
  sourceProjectionConfig: "dataset-a:renko:10",
} as const;

function sourcePoint(price = 200): DrawingDataPoint {
  return { ...SOURCE_ANCHOR, price };
}

function futurePoint(price = 210): DrawingDataPoint {
  return { time: FUTURE_TIME, price };
}

function finalizedStroke(): FreehandStrokeV3 {
  return {
    version: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [],
    points: [
      { anchor: { time: SOURCE_ANCHOR.time, sourceOrdinal: SOURCE_ANCHOR.sourceOrdinal }, price: 200 },
      { time: FUTURE_TIME, price: 204 },
    ],
  };
}

function mustCreate<T>(value: T | null): T {
  assert.ok(value);
  return value;
}

function assertSavedDrawingCommandDocumentRoundTrip(saved: SavedDrawing): void {
  const commands = drawingCreateCommandsForSavedDrawing(saved);
  assert.ok(commands);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.type, "create");

  const result = applyDrawingCommands(
    createDrawingDocument({ scopeKey: `creation:${saved.type}` }),
    commands,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.document.zOrder, [saved.id]);
  assert.deepEqual(exportDrawingDocument(result.document), [saved]);
}

test("two-point tools map to strict line, angle, fibonacci, and shape drawings", () => {
  const points = [sourcePoint(), futurePoint()];
  const levels = [
    { level: 0, color: "#111111", enabled: true },
    { level: 0.618, color: "#ffaa00", enabled: true },
  ];
  const line = mustCreate(createTwoPointSavedDrawing({
    tool: "line-ray",
    dataPoints: points,
    color: "#00aaff",
    lineWidth: 2,
  }));
  const angle = mustCreate(createTwoPointSavedDrawing({
    tool: "angle-measure",
    dataPoints: points,
    color: "#22cc88",
    lineWidth: 3,
  }));
  const fibonacci = mustCreate(createTwoPointSavedDrawing({
    tool: "fibonacci",
    dataPoints: points,
    color: "#eeaa00",
    lineWidth: 1.5,
    fibLevels: levels,
    fibInverted: true,
  }));
  const shape = mustCreate(createTwoPointSavedDrawing({
    tool: "shape-ellipse",
    dataPoints: points,
    color: "#cc44ff",
    lineWidth: 4,
    lineStyle: "dashed",
  }));

  assert.deepEqual(line, {
    type: "line",
    id: line.id,
    lineType: "line-ray",
    dataPoints: points,
    color: "#00aaff",
    lineWidth: 2,
  });
  assert.equal(angle.type, "angle-measure");
  assert.deepEqual(angle.dataPoints, points);
  assert.equal(fibonacci.type, "fibonacci");
  assert.deepEqual(fibonacci.levels, levels);
  assert.equal(fibonacci.inverted, true);
  assert.deepEqual(shape, {
    type: "shape",
    id: shape.id,
    shapeType: "ellipse",
    dataPoints: points,
    color: "#cc44ff",
    lineWidth: 4,
    fillColor: "#cc44ff",
    fillOpacity: 0.12,
    lineStyle: "dashed",
  });
  assert.deepEqual(line.dataPoints?.[0], sourcePoint());
  assert.equal(line.dataPoints?.[1]?.time, FUTURE_TIME);

  for (const drawing of [line, angle, fibonacci, shape]) {
    assertSavedDrawingCommandDocumentRoundTrip(drawing);
  }
});

test("axis, text, and position creation preserve canonical anchors and defaults", () => {
  const axis = mustCreate(createAxisLineSavedDrawing({
    tool: "line-cross",
    dataPoint: sourcePoint(),
    color: "#ffffff",
    lineWidth: 1,
  }));
  const text = mustCreate(createTextSavedDrawing({
    dataPoint: futurePoint(205),
    color: "#f5f5f5",
    fontFamily: "Inter",
    underline: true,
    align: "center",
    bgColor: null,
    widthPx: null,
  }));
  const position = mustCreate(createPositionSavedDrawing({
    tool: "position-long",
    dataPoint: sourcePoint(),
    timeRange: {
      start: { ...SOURCE_ANCHOR },
      end: { time: FUTURE_TIME },
    },
    visiblePriceRange: 100,
    positionSize: 0,
  }));
  const fallbackShort = mustCreate(createPositionSavedDrawing({
    tool: "position-short",
    dataPoint: sourcePoint(),
    timeRange: { start: SOURCE_ANCHOR.time, end: FUTURE_TIME },
  }));

  assert.deepEqual(axis, {
    type: "axis-line",
    id: axis.id,
    axisLineType: "cross",
    dataPoint: sourcePoint(),
    color: "#ffffff",
    lineWidth: 1,
  });
  assert.equal(text.type, "text");
  assert.equal(text.text, "");
  assert.equal(text.fontSize, 14);
  assert.equal(text.bold, false);
  assert.equal(text.italic, false);
  assert.equal(text.dataPoint?.time, FUTURE_TIME);
  assert.deepEqual(position, {
    type: "position",
    id: position.id,
    direction: "long",
    entryPrice: 200,
    tpPrice: 212,
    slPrice: 194,
    timeRange: {
      start: { ...SOURCE_ANCHOR },
      end: { time: FUTURE_TIME },
    },
    positionSize: 0,
  });
  assert.equal(fallbackShort.direction, "short");
  assert.equal(fallbackShort.tpPrice, 194);
  assert.equal(fallbackShort.slPrice, 203);
  assert.equal(fallbackShort.positionSize, 1_000);

  for (const drawing of [axis, text, position, fallbackShort]) {
    assertSavedDrawingCommandDocumentRoundTrip(drawing);
  }
});

test("finalized pen and highlighter strokes keep lineage, future points, and paint policy", () => {
  const pen = mustCreate(createFinalizedFreehandSavedDrawing({
    tool: "pen",
    stroke: finalizedStroke(),
    color: "#ffee00",
    lineWidth: 2,
  }));
  const highlighter = mustCreate(createFinalizedFreehandSavedDrawing({
    tool: "highlighter",
    stroke: finalizedStroke(),
    color: "#ffee00",
    lineWidth: 12,
  }));

  assert.equal(pen.type, "freehand");
  assert.equal(pen.stroke?.version, 3);
  assert.deepEqual(pen.stroke?.points, finalizedStroke().points);
  assert.equal(highlighter.type, "highlighter");
  assert.equal(highlighter.opacity, 0.35);
  assert.equal(highlighter.compositeOperation, "multiply");
  assert.equal(highlighter.brushShape, "square");
  const futureStrokePoint = highlighter.stroke?.points[1];
  assert.equal(futureStrokePoint && "time" in futureStrokePoint
    ? futureStrokePoint.time
    : null, FUTURE_TIME);

  assertSavedDrawingCommandDocumentRoundTrip(pen);
  assertSavedDrawingCommandDocumentRoundTrip(highlighter);
});

test("creation allocates one prefixed id per valid drawing and none for rejected input", () => {
  assert.equal(observeDrawingId("phase8_9100000"), true);
  assert.equal(createTwoPointSavedDrawing({
    tool: "line-segment",
    dataPoints: [sourcePoint()],
    color: "#fff",
    lineWidth: 1,
  }), null);
  const line = mustCreate(createTwoPointSavedDrawing({
    tool: "line-segment",
    dataPoints: [sourcePoint(), futurePoint()],
    color: "#fff",
    lineWidth: 1,
  }));
  const axis = mustCreate(createAxisLineSavedDrawing({
    tool: "line-horizontal",
    dataPoint: sourcePoint(),
    color: "#fff",
    lineWidth: 1,
  }));
  assert.equal(createFinalizedFreehandSavedDrawing({
    tool: "pen",
    stroke: { ...finalizedStroke(), points: [{ time: 1, price: 1 }] },
    color: "#fff",
    lineWidth: 1,
  }), null);
  const text = mustCreate(createTextSavedDrawing({
    dataPoint: sourcePoint(),
    color: "#fff",
  }));

  assert.equal(line.id, "ln_9100001");
  assert.equal(axis.id, "ax_9100002");
  assert.equal(text.id, "tx_9100003");
});

test("create-command conversion fails closed and the data module has no renderer dependency", () => {
  assert.equal(drawingCreateCommandsForSavedDrawing({
    type: "line",
    id: "invalid-line",
    lineType: "not-a-line-tool",
    dataPoints: [sourcePoint(), futurePoint()],
    color: "#fff",
    lineWidth: 1,
  } as unknown as SavedDrawing), null);
  assert.equal(drawingCreateCommandsForSavedDrawing({
    type: "line",
    dataPoints: [sourcePoint(), futurePoint()],
  }), null);
  const throwing = Object.defineProperty({ type: "line" }, "id", {
    enumerable: true,
    get() { throw new Error("getter must not escape"); },
  }) as unknown as SavedDrawing;
  assert.equal(drawingCreateCommandsForSavedDrawing(throwing), null);

  const source = readFileSync(
    new URL("../drawingEntityCreation.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /drawingPrimitiveFactory|\/primitives\/|new\s+\w*Primitive/);
  assert.doesNotMatch(source, /drawingCreationController|coordinateBridge|chart-adapter/);
});
