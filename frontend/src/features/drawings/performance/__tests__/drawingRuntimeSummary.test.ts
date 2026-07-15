import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../../core/drawingCodec.js";
import {
  summarizeDrawingRuntimeDocument,
  summarizeDrawingRuntimePrimitives,
} from "../../useDrawingPersistenceLifecycle.js";

test("runtime drawing summary reports restored entity, type, and canonical point counts", () => {
  const summary = summarizeDrawingRuntimePrimitives([
    {
      _type: "freehand",
      _stroke: { points: Array.from({ length: 4_096 }, () => ({})) },
    },
    { _lineType: "line-segment", _dataPoints: [{}, {}] },
    { _shapeType: "rectangle", _dataPoints: [{}, {}] },
  ]);

  assert.deepEqual(summary, {
    entityCount: 3,
    pointCount: 4_100,
    typeCounts: { freehand: 1, line: 1, shape: 1 },
  });
});

test("runtime drawing summary stays defensive for unknown primitive shapes", () => {
  const summary = summarizeDrawingRuntimePrimitives([null, { constructor: { name: "Custom" } }]);
  assert.equal(summary.entityCount, 1);
  assert.equal(summary.pointCount, 0);
  assert.deepEqual(summary.typeCounts, { Custom: 1 });
});

test("document-only runtime summary reads canonical entities without primitive materialization", () => {
  const first = { time: 100, price: 10 };
  const second = { time: 200, price: 20 };
  const document = importSavedDrawings("perf-document", [
    { type: "line", id: "line", lineType: "line-segment", dataPoints: [first, second] },
    { type: "axis-line", id: "axis", axisLineType: "cross", dataPoint: first },
    { type: "angle-measure", id: "angle", dataPoints: [first, second] },
    { type: "text", id: "text", dataPoint: first, text: "summary" },
    { type: "fibonacci", id: "fib", dataPoints: [first, second] },
    {
      type: "position",
      id: "position",
      direction: "long",
      entryPrice: 10,
      tpPrice: 20,
      slPrice: 5,
      timeRange: { start: 100, end: 200 },
    },
    { type: "shape", id: "shape", shapeType: "rectangle", dataPoints: [first, second] },
    {
      type: "freehand",
      id: "freehand-stroke",
      stroke: {
        version: 3,
        sourceProjection: "time-axis",
        sourceProjectionConfig: "runtime-summary",
        spans: [],
        points: [first, second, { time: 300, price: 30 }],
      },
    },
    { type: "highlighter", id: "highlighter-points", dataPoints: [first, second] },
  ]);
  assert.ok(document);

  const summary = summarizeDrawingRuntimeDocument(document, 1);
  assert.deepEqual(summary, {
    entityCount: 9,
    pointCount: 15,
    typeCounts: {
      line: 1,
      "axis-line": 1,
      "angle-measure": 1,
      text: 1,
      fibonacci: 1,
      position: 1,
      shape: 1,
      freehand: 1,
      highlighter: 1,
    },
    attachedPrimitiveCount: 1,
  });
});
