import assert from "node:assert/strict";
import test from "node:test";

import { registerDrawingSeriesContext } from "../../../chart-adapter/coordinateBridge.js";
import { createDrawingFrameSnapshotFactory } from "../../../chart-adapter/drawingFrameSnapshot.js";
import type { DisplayRow } from "../../chart-representation/chartRepresentationTypes.js";
import { structuralMock } from "../../../test/testHelpers.js";
import type { DrawingAttachedParameter, DrawingDataPoint } from "../drawingTypes.js";
import {
  drawingPerfCounters,
  resetDrawingPerfCounters,
} from "../performance/drawingPerfCounters.js";
import { AngleMeasurementPrimitive } from "../primitives/AngleMeasurementPrimitive.js";
import { AxisLineDrawingPrimitive } from "../primitives/AxisLineDrawingPrimitive.js";
import { FibonacciDrawingPrimitive } from "../primitives/FibonacciDrawingPrimitive.js";
import { LineDrawingPrimitive } from "../primitives/LineDrawingPrimitive.js";
import { PositionDrawingPrimitive } from "../primitives/PositionDrawingPrimitive.js";
import { ShapeDrawingPrimitive } from "../primitives/ShapeDrawingPrimitive.js";
import { TextDrawingPrimitive } from "../primitives/TextDrawingPrimitive.js";

test("non-freehand primitives cache source anchors across viewport-only frames", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const frameFactory = createDrawingFrameSnapshotFactory();
  const surfaceToken = {};
  const frameInput = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:1m:line:0",
    seriesData: rows,
    surfaceToken,
    viewportKey: "spacing-10",
  };
  let snapshot = frameFactory.capture(frameInput);
  let spacing = 10;
  const chart = structuralMock<DrawingAttachedParameter["chart"]>({
    timeScale: () => ({
      options: () => ({ barSpacing: spacing }),
      timeToCoordinate: (time: unknown) => (
        typeof time === "number" ? ((time - 100) / 100) * spacing : null
      ),
    }),
  });
  const series = structuralMock<DrawingAttachedParameter["series"]>({
    data: () => rows,
    dataByIndex: () => null,
    priceToCoordinate: (price: number) => price,
  });
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => snapshot,
  });
  const pointA: DrawingDataPoint = { time: 100, price: 10 };
  const pointB: DrawingDataPoint = { time: 200, price: 20 };
  const twoPoints: DrawingDataPoint[] = [pointA, pointB];
  const angle = new AngleMeasurementPrimitive({ id: "angle", dataPoints: twoPoints });
  const axis = new AxisLineDrawingPrimitive({ id: "axis", dataPoint: pointA });
  const fibonacci = new FibonacciDrawingPrimitive({ id: "fib", dataPoints: twoPoints });
  const line = new LineDrawingPrimitive({ id: "line", dataPoints: twoPoints });
  const position = new PositionDrawingPrimitive({
    id: "position",
    entryPrice: 10,
    timeRange: { start: { time: 100 }, end: { time: 200 } },
  });
  const shape = new ShapeDrawingPrimitive({ id: "shape", dataPoints: twoPoints });
  const text = new TextDrawingPrimitive({ id: "text", dataPoint: pointA, text: "x" });
  const primitives = [angle, axis, fibonacci, line, position, shape, text];
  const attached = structuralMock<DrawingAttachedParameter>({
    chart,
    series,
    requestUpdate: () => {},
  });
  for (const primitive of primitives) primitive.attached(attached);

  resetDrawingPerfCounters();
  for (const primitive of primitives) primitive.updateAllViews();
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 12);

  spacing = 20;
  snapshot = frameFactory.capture({ ...frameInput, viewportKey: "spacing-20" });
  resetDrawingPerfCounters();
  for (const primitive of primitives) primitive.updateAllViews();
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 0);
  assert.deepEqual(line.hitTestGeometry(20, 20), { pointIndex: 1 });
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 0);

  const revisionsBeforeStyle = primitives.map((primitive) => primitive.geometryRevision);
  angle.setColor("#fff");
  axis.setColor("#fff");
  fibonacci.setColor("#fff");
  line.setColor("#fff");
  position.setSelected(true);
  shape.setColor("#fff");
  text.setColor("#fff");
  assert.deepEqual(
    primitives.map((primitive) => primitive.geometryRevision),
    revisionsBeforeStyle,
  );
  resetDrawingPerfCounters();
  for (const primitive of primitives) primitive.updateAllViews();
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 0);

  angle.setDataPoints([...twoPoints]);
  axis.setDataPoint({ ...pointA });
  fibonacci.setDataPoints([...twoPoints]);
  line.setDataPoints([...twoPoints]);
  assert.equal(position.setTimeRange({ start: { time: 100 }, end: { time: 200 } }), true);
  shape.setDataPoints([...twoPoints]);
  text.setDataPoint({ ...pointA });
  assert.deepEqual(
    primitives.map((primitive) => primitive.geometryRevision),
    revisionsBeforeStyle.map((revision) => revision + 1),
  );
  resetDrawingPerfCounters();
  for (const primitive of primitives) primitive.updateAllViews();
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 12);
});
