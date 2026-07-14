import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDrawingRuntimePrimitives } from "../../useDrawingPersistenceLifecycle.js";

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
