import assert from "node:assert/strict";
import test from "node:test";

import { partialMock } from "../../../test/testHelpers.js";
import {
  drawingPerfCounters,
  resetDrawingPerfCounters,
} from "../performance/drawingPerfCounters.js";
import { LineDrawingPrimitive } from "../primitives/LineDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "../primitives/ShapeDrawingPrimitive.js";
import type { DrawingAttachedParameter } from "../drawingTypes.js";

test("line and shape requestUpdate callbacks delegate and increment instrumentation", () => {
  resetDrawingPerfCounters();
  let delegatedUpdates = 0;
  const attached = partialMock<DrawingAttachedParameter>({
    chart: partialMock<DrawingAttachedParameter["chart"]>({}),
    series: partialMock<DrawingAttachedParameter["series"]>({}),
    requestUpdate: () => { delegatedUpdates += 1; },
  });
  const line = new LineDrawingPrimitive({
    id: "instrumented-line",
    lineType: "line-segment",
    dataPoints: [],
  });
  const shape = new ShapeDrawingPrimitive({
    id: "instrumented-shape",
    shapeType: "rectangle",
    dataPoints: [],
  });
  line.attached(attached);
  shape.attached(attached);

  line.setHovered(true);
  shape.setHovered(true);

  assert.equal(delegatedUpdates, 2);
  assert.equal(drawingPerfCounters.snapshot().counters.requestUpdateCount, 2);
});
