import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDrawingSourceAnchors,
  setDrawingCoordinateProjectorModeForTests,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateSeriesBridge,
  DrawingCoordinateProjectorMode,
} from "../../../chart-adapter/coordinateBridge.js";
import type { DisplayRow } from "../../chart-representation/chartRepresentationTypes.js";
import { LineDrawingPrimitive } from "../primitives/LineDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import { drawingDataPointsToCoordinates } from "../primitives/coordinateUtils.js";
import type {
  DrawingAttachedParameter,
  DrawingDataPoint,
  FreehandStrokeV3,
  PrimitiveCanvasTarget,
  ScreenPoint,
} from "../drawingTypes.js";
import {
  mustBeDefined,
  partialMock,
  structuralMock,
} from "../../../test/testHelpers.js";

type BitmapScope = Parameters<
  Parameters<PrimitiveCanvasTarget["useBitmapCoordinateSpace"]>[0]
>[0];

type PriceModeName = "indexed" | "inverted" | "log" | "normal" | "percentage";

interface PriceModeFixture {
  invertScale: boolean;
  mode: PriceModeName;
}

interface LineScreenPlan {
  endpoints: readonly [ScreenPoint, ScreenPoint];
  handles: readonly [ScreenPoint, ScreenPoint];
}

interface PathCommand {
  operation: "lineTo" | "moveTo" | "quadraticCurveTo";
  points: readonly ScreenPoint[];
}

const PRICE_MODE_FIXTURES: readonly PriceModeFixture[] = [
  { mode: "normal", invertScale: false },
  { mode: "log", invertScale: false },
  { mode: "percentage", invertScale: false },
  { mode: "indexed", invertScale: false },
  { mode: "inverted", invertScale: true },
];

const SERIES_ROWS: DisplayRow[] = [
  { time: 100, close: 96 },
  { time: 200, close: 112 },
  { time: 300, close: 136 },
  { time: 400, close: 158 },
];

const TIME_COORDINATES = new Map<number, number>([
  [100, 31.125],
  [200, 184.75],
  [300, 410.5],
  [400, 722.25],
]);

const LINE_POINTS: DrawingDataPoint[] = [
  { time: 100, price: 92 },
  { time: 350, price: 164 },
];

const POINT_GEOMETRY: DrawingDataPoint[] = [
  { time: 100, price: 92 },
  { time: 225, price: 121 },
  { time: 400, price: 164 },
];

const FREEHAND_STROKE: FreehandStrokeV3 = {
  version: 3,
  sourceProjection: "time",
  sourceProjectionConfig: "dataset-a:time:1m",
  spans: [],
  points: [
    { time: 100, price: 92 },
    { time: 175, price: 108 },
    { time: 250, price: 137 },
    { time: 400, price: 164 },
  ],
};

function withProjectorMode<T>(
  mode: DrawingCoordinateProjectorMode,
  operation: () => T,
): T {
  const restore = setDrawingCoordinateProjectorModeForTests(mode);
  try {
    return operation();
  } finally {
    restore();
  }
}

function chartFixture(): CoordinateChartBridge {
  return {
    timeScale: () => ({
      timeToCoordinate: (time) => (
        typeof time === "number" ? TIME_COORDINATES.get(time) ?? null : null
      ),
    }),
  };
}

/**
 * Deterministic equivalent of LWC's public price-scale semantics. It applies
 * the mode transform before the visible-range mapping and mirrors the scale
 * direction when invertScale is enabled.
 */
function priceToCoordinateFor({ mode, invertScale }: PriceModeFixture): (price: number) => number {
  const baseValue = 96;
  const minPrice = 80;
  const maxPrice = 180;
  const height = 487;
  const topMarginRatio = 0.12;
  const bottomMarginRatio = 0.08;
  const logicalOffset = 4;
  const coordinateOffset = 0.0001;
  const transform = (price: number): number => {
    if (mode === "log") {
      return Math.log10(Math.abs(price) + coordinateOffset) + logicalOffset;
    }
    if (mode === "percentage") {
      return 100 * (price - baseValue) / baseValue;
    }
    if (mode === "indexed") {
      return 100 * (price - baseValue) / baseValue + 100;
    }
    return price;
  };
  const min = transform(minPrice);
  const max = transform(maxPrice);
  const topMargin = (invertScale ? bottomMarginRatio : topMarginRatio) * height;
  const bottomMargin = (invertScale ? topMarginRatio : bottomMarginRatio) * height;
  const internalHeight = height - topMargin - bottomMargin;

  return (price) => {
    const inverseCoordinate = bottomMargin
      + (internalHeight - 1) * (transform(price) - min) / (max - min);
    return invertScale ? inverseCoordinate : height - 1 - inverseCoordinate;
  };
}

function seriesFixture(priceMode: PriceModeFixture): CoordinateSeriesBridge & {
  data(): DisplayRow[];
  priceToCoordinate(price: number): number;
} {
  return {
    data: () => SERIES_ROWS,
    priceToCoordinate: priceToCoordinateFor(priceMode),
  };
}

function attachPrimitive(
  primitive: LineDrawingPrimitive | FreehandDrawingPrimitive,
  chart: CoordinateChartBridge,
  series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number },
): void {
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: structuralMock<DrawingAttachedParameter["chart"]>(chart),
    series: structuralMock<DrawingAttachedParameter["series"]>(series),
    requestUpdate: () => {},
  }));
}

function toCssPoint(x: number, y: number, horizontalRatio: number, verticalRatio: number): ScreenPoint {
  return { x: x / horizontalRatio, y: y / verticalRatio };
}

function captureLineScreenPlan(
  projectorMode: DrawingCoordinateProjectorMode,
  priceMode: PriceModeFixture,
): LineScreenPlan {
  return withProjectorMode(projectorMode, () => {
    const chart = chartFixture();
    const series = seriesFixture(priceMode);
    const primitive = new LineDrawingPrimitive({
      id: `${projectorMode}-${priceMode.mode}-line`,
      lineType: "line-segment",
      dataPoints: LINE_POINTS.map((point) => ({ ...point })),
      selected: true,
    });
    attachPrimitive(primitive, chart, series);
    primitive.updateAllViews();

    const horizontalRatio = 1.75;
    const verticalRatio = 1.25;
    const pathPoints: ScreenPoint[] = [];
    const handlePoints: ScreenPoint[] = [];
    const context = partialMock<CanvasRenderingContext2D>({
      arc: (x, y) => {
        handlePoints.push(toCssPoint(x, y, horizontalRatio, verticalRatio));
      },
      beginPath() {},
      fill() {},
      lineTo: (x, y) => {
        pathPoints.push(toCssPoint(x, y, horizontalRatio, verticalRatio));
      },
      moveTo: (x, y) => {
        pathPoints.push(toCssPoint(x, y, horizontalRatio, verticalRatio));
      },
      restore() {},
      save() {},
      stroke() {},
    });
    mustBeDefined(mustBeDefined(primitive.paneViews()[0]).renderer()).draw(
      partialMock<PrimitiveCanvasTarget>({
        useBitmapCoordinateSpace: (draw) => draw(structuralMock<BitmapScope>({
          bitmapSize: { width: 1_400, height: 700 },
          context,
          horizontalPixelRatio: horizontalRatio,
          verticalPixelRatio: verticalRatio,
        })),
      }),
    );

    assert.ok(pathPoints.length >= 2, "selected line must emit its endpoint path");
    assert.equal(handlePoints.length, 2, "selected line must emit two endpoint handles");
    return {
      endpoints: [mustBeDefined(pathPoints[0]), mustBeDefined(pathPoints[1])],
      handles: [mustBeDefined(handlePoints[0]), mustBeDefined(handlePoints[1])],
    };
  });
}

function capturePointScreenPlan(
  projectorMode: DrawingCoordinateProjectorMode,
  priceMode: PriceModeFixture,
): readonly ScreenPoint[] {
  const chart = chartFixture();
  const series = seriesFixture(priceMode);
  const horizontal = drawingDataPointsToCoordinates(chart, series, POINT_GEOMETRY, {
    drawingCoordinateProjectorMode: projectorMode,
    seriesData: SERIES_ROWS,
  });
  return POINT_GEOMETRY.map((point, index) => ({
    x: mustBeDefined(horizontal[index]),
    y: series.priceToCoordinate(point.price),
  }));
}

function captureFreehandRenderPlan(
  projectorMode: DrawingCoordinateProjectorMode,
  priceMode: PriceModeFixture,
): readonly PathCommand[] {
  return withProjectorMode(projectorMode, () => {
    const chart = chartFixture();
    const series = seriesFixture(priceMode);
    const primitive = new FreehandDrawingPrimitive({
      id: `${projectorMode}-${priceMode.mode}-freehand`,
      stroke: FREEHAND_STROKE,
      lineWidth: 3,
    });
    attachPrimitive(primitive, chart, series);
    primitive.updateAllViews();

    const horizontalRatio = 1.75;
    const verticalRatio = 1.25;
    const commands: PathCommand[] = [];
    const context = partialMock<CanvasRenderingContext2D>({
      beginPath() {},
      lineTo: (x, y) => {
        commands.push({
          operation: "lineTo",
          points: [toCssPoint(x, y, horizontalRatio, verticalRatio)],
        });
      },
      moveTo: (x, y) => {
        commands.push({
          operation: "moveTo",
          points: [toCssPoint(x, y, horizontalRatio, verticalRatio)],
        });
      },
      quadraticCurveTo: (controlX, controlY, x, y) => {
        commands.push({
          operation: "quadraticCurveTo",
          points: [
            toCssPoint(controlX, controlY, horizontalRatio, verticalRatio),
            toCssPoint(x, y, horizontalRatio, verticalRatio),
          ],
        });
      },
      restore() {},
      save() {},
      stroke() {},
    });
    mustBeDefined(mustBeDefined(primitive.paneViews()[0]).renderer()).draw(
      partialMock<PrimitiveCanvasTarget>({
        useBitmapCoordinateSpace: (draw) => draw(structuralMock<BitmapScope>({
          context,
          horizontalPixelRatio: horizontalRatio,
          verticalPixelRatio: verticalRatio,
        })),
      }),
    );
    assert.ok(commands.length >= 3, "freehand render plan must contain a curve");
    return commands;
  });
}

function assertPointWithin(
  actual: ScreenPoint,
  expected: ScreenPoint,
  tolerance: number,
  label: string,
): void {
  const distance = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  assert.ok(
    distance <= tolerance,
    `${label} drifted ${distance} CSS px (limit ${tolerance})`,
  );
}

function assertLinePlanWithin(
  actual: LineScreenPlan,
  expected: LineScreenPlan,
  tolerance: number,
  label: string,
): void {
  for (let index = 0; index < expected.endpoints.length; index += 1) {
    assertPointWithin(
      mustBeDefined(actual.endpoints[index]),
      mustBeDefined(expected.endpoints[index]),
      tolerance,
      `${label} endpoint ${index}`,
    );
  }
  for (let index = 0; index < expected.handles.length; index += 1) {
    assertPointWithin(
      mustBeDefined(actual.handles[index]),
      mustBeDefined(expected.handles[index]),
      tolerance,
      `${label} handle ${index}`,
    );
  }
}

function assertFreehandPlanWithin(
  actual: readonly PathCommand[],
  expected: readonly PathCommand[],
  tolerance: number,
  label: string,
): void {
  assert.equal(actual.length, expected.length, `${label} command count`);
  for (let commandIndex = 0; commandIndex < expected.length; commandIndex += 1) {
    const actualCommand = mustBeDefined(actual[commandIndex]);
    const expectedCommand = mustBeDefined(expected[commandIndex]);
    assert.equal(actualCommand.operation, expectedCommand.operation, `${label} command ${commandIndex}`);
    assert.equal(actualCommand.points.length, expectedCommand.points.length);
    for (let pointIndex = 0; pointIndex < expectedCommand.points.length; pointIndex += 1) {
      assertPointWithin(
        mustBeDefined(actualCommand.points[pointIndex]),
        mustBeDefined(expectedCommand.points[pointIndex]),
        tolerance,
        `${label} command ${commandIndex} point ${pointIndex}`,
      );
    }
  }
}

test("scalar and batch retain exact canonical anchors across every price-scale parity case", () => {
  const canonicalAnchors = [
    { time: 100 },
    { time: 175 },
    { time: 250 },
    { time: 400 },
  ];
  const originalAnchors = canonicalAnchors.map((anchor) => ({ ...anchor }));
  const scalar = resolveDrawingSourceAnchors(SERIES_ROWS, canonicalAnchors, {
    drawingCoordinateProjectorMode: "scalar",
    seriesData: SERIES_ROWS,
  });
  const batch = resolveDrawingSourceAnchors(SERIES_ROWS, canonicalAnchors, {
    drawingCoordinateProjectorMode: "batch",
    seriesData: SERIES_ROWS,
  });

  assert.deepEqual(batch, scalar, "canonical source resolutions must match exactly");
  assert.deepEqual(canonicalAnchors, originalAnchors, "projectors must not rewrite canonical anchors");
});

for (const priceMode of PRICE_MODE_FIXTURES) {
  test(`${priceMode.mode} price mode keeps scalar/batch final screen parity`, () => {
    const scalarPoints = capturePointScreenPlan("scalar", priceMode);
    const batchPoints = capturePointScreenPlan("batch", priceMode);
    for (let index = 0; index < scalarPoints.length; index += 1) {
      assertPointWithin(
        mustBeDefined(batchPoints[index]),
        mustBeDefined(scalarPoints[index]),
        0.25,
        `${priceMode.mode} point ${index}`,
      );
    }

    const scalarLine = captureLineScreenPlan("scalar", priceMode);
    const batchLine = captureLineScreenPlan("batch", priceMode);
    assertLinePlanWithin(batchLine, scalarLine, 0.25, priceMode.mode);

    const scalarFreehand = captureFreehandRenderPlan("scalar", priceMode);
    const batchFreehand = captureFreehandRenderPlan("batch", priceMode);
    assertFreehandPlanWithin(batchFreehand, scalarFreehand, 0.5, priceMode.mode);
  });
}
