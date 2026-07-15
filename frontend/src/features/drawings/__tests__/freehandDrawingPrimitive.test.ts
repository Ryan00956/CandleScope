import assert from "node:assert/strict";
import test from "node:test";

import {
  isOrdinalAxisTime,
  registerDrawingSeriesContext,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
} from "../../../chart-adapter/coordinateBridge.js";
import { createDrawingFrameSnapshotFactory } from "../../../chart-adapter/drawingFrameSnapshot.js";
import { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import { freehandStrokeToCoordinates } from "../primitives/coordinateUtils.js";
import {
  drawingPerfCounters,
  resetDrawingPerfCounters,
} from "../performance/drawingPerfCounters.js";
import type {
  DrawingAttachedParameter,
  FreehandStrokeV2,
  FreehandStrokeV3,
  PrimitiveCanvasTarget,
  ScreenPoint,
} from "../drawingTypes.js";
import type {
  DisplayRow,
  OrdinalAxisTime,
  ProjectionMetadata,
} from "../../chart-representation/chartRepresentationTypes.js";
import {
  malformedFixture,
  mustBeDefined,
  partialMock,
  structuralMock,
} from "../../../test/testHelpers.js";

type TestDisplayRow = DisplayRow & {
  time: OrdinalAxisTime;
  customValues: { chartProjection: Readonly<ProjectionMetadata> };
};

type BitmapScope = Parameters<
  Parameters<PrimitiveCanvasTarget["useBitmapCoordinateSpace"]>[0]
>[0];

function row(
  order: number,
  sourceTime: number,
  from: number,
  to: number,
  sourceOrdinal = 0,
): TestDisplayRow {
  return {
    time: { order, sourceTime, sourceOrdinal },
    customValues: {
      chartProjection: {
        projectorId: "renko",
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
        synthetic: true,
      },
    },
  };
}

function strokeWithUnresolvedMiddle(): FreehandStrokeV2 {
  return {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:old",
    spans: [{
      exact: {
        left: { time: 100, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }, {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 300,
        toTime: 400,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 0 },
      { span: 0, ratio: 0.2, price: 0 },
      { span: 1, ratio: 0.5, price: 0 },
      { span: 0, ratio: 0.8, price: 0 },
      { span: 0, ratio: 1, price: 0 },
    ],
  };
}

function strokeV3WithAbsoluteMiddle(): FreehandStrokeV3 {
  const v2 = strokeWithUnresolvedMiddle();
  return {
    ...v2,
    version: 3,
    spans: [mustBeDefined(v2.spans[0])],
    points: [
      { span: 0, ratio: 0, price: 0 },
      { span: 0, ratio: 0.2, price: 0 },
      { time: 500, price: 0 },
      { span: 0, ratio: 0.8, price: 0 },
      { span: 0, ratio: 1, price: 0 },
    ],
  };
}

function attachPrimitive(
  primitive: FreehandDrawingPrimitive,
  chart: CoordinateChartBridge,
  series: CoordinateSeriesBridge,
): void {
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: structuralMock<DrawingAttachedParameter["chart"]>(chart),
    series: structuralMock<DrawingAttachedParameter["series"]>(series),
    requestUpdate: () => {},
  }));
}

function attachedPrimitive(): FreehandDrawingPrimitive {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-gap",
    stroke: strokeWithUnresolvedMiddle(),
    lineWidth: 2,
  });
  attachPrimitive(primitive, chart, series);
  return primitive;
}

function renderedPathMoves(primitive: FreehandDrawingPrimitive): Array<[number, number]> {
  primitive.updateAllViews();
  const moves: Array<[number, number]> = [];
  const context = partialMock<CanvasRenderingContext2D>({
    beginPath() {},
    lineTo() {},
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke() {},
  });
  mustBeDefined(mustBeDefined(primitive.paneViews()[0]).renderer()).draw(partialMock<PrimitiveCanvasTarget>({
    useBitmapCoordinateSpace: (draw) => draw(structuralMock<BitmapScope>({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    })),
  }));
  return moves;
}

test("freehand v2 renderer and hit testing never bridge an unresolved span", () => {
  const primitive = attachedPrimitive();

  assert.equal(primitive.hitTestGeometry(1, 0, 0.1), true);
  assert.equal(primitive.hitTestGeometry(5, 0, 0.1), false);
  assert.equal(primitive.hitTestGeometry(9, 0, 0.1), true);

  primitive.updateAllViews();
  const moves: Array<[number, number]> = [];
  const lines: Array<[number, number]> = [];
  let strokes = 0;
  const context = partialMock<CanvasRenderingContext2D>({
    beginPath() {},
    lineTo: (x, y) => lines.push([x, y]),
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke: () => { strokes += 1; },
  });
  mustBeDefined(mustBeDefined(primitive.paneViews()[0]).renderer()).draw(partialMock<PrimitiveCanvasTarget>({
    useBitmapCoordinateSpace: (draw) => draw(structuralMock<BitmapScope>({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    })),
  }));

  assert.deepEqual(moves, [[0, 0], [8, 0]]);
  assert.deepEqual(lines, [[2, 0], [10, 0]]);
  assert.equal(strokes, 1);
});

test("freehand v2 hit testing skips unresolved singleton paths omitted by the renderer", () => {
  const value = strokeWithUnresolvedMiddle();
  const singletonStroke: FreehandStrokeV2 = { ...value, points: [
    { span: 0, ratio: 0.5, price: 0 },
    { span: 1, ratio: 0.5, price: 0 },
    { span: 0, ratio: 0.5, price: 0 },
  ] };
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({ id: "v2-singleton", stroke: singletonStroke });
  attachPrimitive(primitive, chart, series);

  assert.equal(primitive.hitTestGeometry(5, 0, 0.1), false);
});

test("freehand v3 renderer and hit testing split at unresolved absolute-time points", () => {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "v3-gap",
    stroke: strokeV3WithAbsoluteMiddle(),
    lineWidth: 2,
  });
  attachPrimitive(primitive, chart, series);

  assert.equal(primitive.hitTestGeometry(1, 0, 0.1), true);
  assert.equal(primitive.hitTestGeometry(5, 0, 0.1), false);
  assert.equal(primitive.hitTestGeometry(9, 0, 0.1), true);
  assert.deepEqual(renderedPathMoves(primitive), [[0, 0], [8, 0]]);
});

test("freehand v3 resolves lineage and future time points from one coordinate snapshot", () => {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  let snapshots = 0;
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => {
      throw new Error("the atomic drawing snapshot owns series data");
    },
    priceToCoordinate: (price) => price,
  };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => {
      snapshots += 1;
      return {
        seriesData: rows,
        sourceTimeHorizon: 200,
        sourceInterval: "100s",
        sourceIntervalSeconds: 100,
      };
    },
  });
  const stroke = strokeV3WithAbsoluteMiddle();
  const futureStroke: FreehandStrokeV3 = { ...stroke, points: [
    { span: 0, ratio: 0, price: 0 },
    { span: 0, ratio: 0.2, price: 0 },
    { time: 500, price: 0 },
    { time: 600, price: 0 },
  ] };
  const primitive = new FreehandDrawingPrimitive({ id: "v3-future", stroke: futureStroke, lineWidth: 2 });
  attachPrimitive(primitive, chart, series);

  primitive.updateAllViews();
  assert.equal(snapshots, 1);
  assert.equal(primitive.hitTestGeometry(45, 0, 0.1), true);
  assert.equal(snapshots, 2);
});

test("freehand v3 exact anchors do not drift to a later same-time synthetic ordinal", () => {
  const rows = [
    row(0, 100, 100, 100, 0),
    row(1, 100, 100, 100, 1),
  ];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge = { data: () => rows };
  const context: DrawingCoordinateContext = {
    drawingProjectionConfig: "dataset-a:renko:old",
    seriesData: rows,
    sourceTimeHorizon: 100,
  };
  const exactStroke: FreehandStrokeV3 = {
    version: 3,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:old",
    spans: [],
    points: [
      { anchor: { time: 100, sourceOrdinal: 0 }, price: 0 },
      { anchor: { time: 100, sourceOrdinal: 0 }, price: 1 },
    ],
  };
  const bareTimeStroke: FreehandStrokeV3 = {
    ...exactStroke,
    points: [
      { time: 100, price: 0 },
      { time: 100, price: 1 },
    ],
  };

  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, exactStroke, context)
      .map((point) => mustBeDefined(point).x),
    [0, 0],
  );
  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, bareTimeStroke, context)
      .map((point) => mustBeDefined(point).x),
    [10, 10],
  );
});

test("freehand primitive accepts known stroke versions and rejects unknown or mixed v3", () => {
  const v2 = strokeWithUnresolvedMiddle();
  const v3 = strokeV3WithAbsoluteMiddle();
  const primitive = new FreehandDrawingPrimitive({ id: "known-v3", stroke: v3 });
  assert.equal(mustBeDefined(primitive.stroke).version, 3);

  const preview = new FreehandDrawingPrimitive({
    id: "known-v2",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(preview.commitStroke(v2), true);
  assert.equal(mustBeDefined(preview.stroke).version, 2);

  const rejected = new FreehandDrawingPrimitive({
    id: "unknown",
    stroke: malformedFixture<FreehandStrokeV3>({ ...v3, version: 4 }),
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(rejected.stroke, null);
  assert.equal(rejected.commitStroke({
    ...v3,
    points: [
      { span: 0, ratio: 0, time: 100, price: 0 },
      { time: 500, price: 0 },
    ],
  }), false);
  assert.equal(rejected.isPreview, true);
});

test("legacy freehand and highlighter split unresolved points on ordinal axes", () => {
  const rows = [
    row(0, 100, 100, 100),
    row(1, 200, 101, 200),
    row(2, 300, 201, 300),
    row(3, 400, 301, 400),
  ];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (isOrdinalAxisTime(time) ? time.order * 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };

  for (const type of ["freehand", "highlighter"] as const) {
    const primitive = new FreehandDrawingPrimitive({
      id: `legacy-ordinal-${type}`,
      type,
      dataPoints: [
        { time: 100, price: 0 },
        { time: 200, price: 0 },
        { time: 500, price: 0 },
        { time: 300, price: 0 },
        { time: 400, price: 0 },
      ],
      lineWidth: 2,
    });
    attachPrimitive(primitive, chart, series);

    assert.equal(primitive.hitTestGeometry(5, 0, 0.1), true, type);
    assert.equal(primitive.hitTestGeometry(15, 0, 0.1), false, type);
    assert.equal(primitive.hitTestGeometry(25, 0, 0.1), true, type);
    assert.deepEqual(renderedPathMoves(primitive), [[0, 0], [20, 0]], type);
  }
});

test("legacy freehand keeps filtering invalid points into one path on time axes", () => {
  const coordinates = new Map([
    [100, 0],
    [200, 10],
    [250, 15],
    [300, 20],
    [400, 30],
  ]);
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (
        typeof time === "number" ? coordinates.get(time) ?? null : null
      ),
    }),
  };
  const series: CoordinateSeriesBridge & {
    priceToCoordinate(price: number): number | null;
  } = {
    data: () => [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }],
    priceToCoordinate: (price) => (price === 999 ? null : price),
  };
  const primitive = new FreehandDrawingPrimitive({
    id: "legacy-time-axis",
    dataPoints: [
      { time: 100, price: 0 },
      { time: 200, price: 0 },
      { time: 250, price: 999 },
      { time: 300, price: 0 },
      { time: 400, price: 0 },
    ],
    lineWidth: 2,
  });
  attachPrimitive(primitive, chart, series);

  assert.equal(primitive.hitTestGeometry(15, 0, 0.1), true);
  assert.deepEqual(renderedPathMoves(primitive), [[0, 0]]);
});

test("freehand preview renders screen-space paths and commit clears transient state", () => {
  let updates = 0;
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-preview",
    isPreview: true,
    previewPoints: [],
    lineWidth: 2,
  });
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: partialMock<DrawingAttachedParameter["chart"]>({}),
    series: partialMock<DrawingAttachedParameter["series"]>({}),
    requestUpdate: () => { updates += 1; },
  }));
  assert.equal(primitive.setPreviewPoints([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    null,
    { x: 8, y: 0 },
    { x: 10, y: 0 },
  ]), true);
  primitive.updateAllViews();
  const moves: Array<[number, number]> = [];
  const lines: Array<[number, number]> = [];
  const context = partialMock<CanvasRenderingContext2D>({
    beginPath() {},
    lineTo: (x, y) => lines.push([x, y]),
    moveTo: (x, y) => moves.push([x, y]),
    quadraticCurveTo() {},
    restore() {},
    save() {},
    stroke() {},
  });
  mustBeDefined(mustBeDefined(primitive.paneViews()[0]).renderer()).draw(partialMock<PrimitiveCanvasTarget>({
    useBitmapCoordinateSpace: (draw) => draw(structuralMock<BitmapScope>({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    })),
  }));
  assert.deepEqual(moves, [[0, 0], [8, 0]]);
  assert.deepEqual(lines, [[2, 0], [10, 0]]);
  assert.equal(primitive.hitTestGeometry(1, 0), false);

  assert.equal(primitive.commitStroke(strokeWithUnresolvedMiddle()), true);
  assert.equal(primitive.isPreview, false);
  assert.deepEqual(primitive.previewPoints, []);
  assert.equal(Object.isFrozen(primitive.stroke), true);
  assert.equal(updates, 2);
});

test("freehand preview appends frame deltas without replacing prior geometry", () => {
  let updates = 0;
  const delta: Array<ScreenPoint | null> = [{ x: 2, y: 0 }, null, { x: 8, y: 0 }];
  const primitive = new FreehandDrawingPrimitive({
    id: "incremental-preview",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }],
  });
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: partialMock<DrawingAttachedParameter["chart"]>({}),
    series: partialMock<DrawingAttachedParameter["series"]>({}),
    requestUpdate: () => { updates += 1; },
  }));

  assert.equal(primitive.appendPreviewPoints(delta), true);
  assert.deepEqual(primitive.previewPoints, [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    null,
    { x: 8, y: 0 },
  ]);
  mustBeDefined(delta[0]).x = 99;
  assert.equal(mustBeDefined(primitive.previewPoints[1]).x, 2);
  assert.equal(primitive.appendPreviewPoints([]), true);
  assert.equal(updates, 1);
});

test("viewport-only freehand projection reuses pure anchor resolutions", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const factory = createDrawingFrameSnapshotFactory();
  const surfaceToken = {};
  const baseInput = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:1m:line:0",
    seriesData: rows,
    surfaceToken,
    viewportKey: "spacing-10",
  };
  let snapshot = factory.capture(baseInput);
  let spacing = 10;
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      timeToCoordinate: (time) => (
        typeof time === "number" ? ((time - 100) / 100) * spacing : null
      ),
    }),
  };
  const series: CoordinateSeriesBridge = { data: () => rows };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => snapshot,
  });
  const stroke: FreehandStrokeV3 = {
    version: 3,
    sourceProjection: "time",
    sourceProjectionConfig: "BTCUSDT:1m:line",
    spans: [],
    points: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
  };
  const cacheToken = {};

  resetDrawingPerfCounters();
  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, stroke, {}, {
      cacheToken,
      geometryRevision: 1,
    }).map((point) => mustBeDefined(point).x),
    [0, 10],
  );
  assert.equal(snapshot.coordinateIndex.stats.numericBatchMergeWalkCount, 1);
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 2);

  spacing = 20;
  snapshot = factory.capture({ ...baseInput, viewportKey: "spacing-20" });
  resetDrawingPerfCounters();
  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, stroke, {}, {
      cacheToken,
      geometryRevision: 1,
    }).map((point) => mustBeDefined(point).x),
    [0, 20],
  );
  assert.equal(snapshot.coordinateIndex.stats.numericBatchMergeWalkCount, 1);
  assert.equal(drawingPerfCounters.snapshot().counters.anchorResolveCount, 0);
});

test("viewport-only freehand projection reuses pure lineage-span resolutions", () => {
  const rows: DisplayRow[] = [{ time: 100 }, { time: 200 }];
  const factory = createDrawingFrameSnapshotFactory();
  const surfaceToken = {};
  const baseInput = {
    axisKind: "time" as const,
    coordinateKey: "BTCUSDT:1m:line:0",
    seriesData: rows,
    surfaceToken,
    viewportKey: "spacing-10",
  };
  let snapshot = factory.capture(baseInput);
  let spacing = 10;
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: spacing }),
      timeToCoordinate: (time) => (
        typeof time === "number" ? ((time - 100) / 100) * spacing : null
      ),
    }),
  };
  const series: CoordinateSeriesBridge = { data: () => rows };
  registerDrawingSeriesContext(series, {
    coordinateSnapshotProvider: () => snapshot,
  });
  const stroke: FreehandStrokeV2 = {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "BTCUSDT:renko:old",
    spans: [{
      exact: {
        left: { time: 100, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 1 },
      { span: 0, ratio: 1, price: 2 },
    ],
  };
  const cacheToken = {};

  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, stroke, {}, {
      cacheToken,
      geometryRevision: 1,
    }).map((point) => mustBeDefined(point).x),
    [0, 10],
  );
  assert.equal(snapshot.coordinateIndex.stats.numericBinarySearchCount, 2);

  spacing = 20;
  snapshot = factory.capture({ ...baseInput, viewportKey: "spacing-20" });
  assert.deepEqual(
    freehandStrokeToCoordinates(chart, series, stroke, {}, {
      cacheToken,
      geometryRevision: 1,
    }).map((point) => mustBeDefined(point).x),
    [0, 20],
  );
  assert.equal(snapshot.coordinateIndex.stats.numericBinarySearchCount, 2);
});

test("active freehand preview reports transient screen points as raw geometry", () => {
  resetDrawingPerfCounters();
  const primitive = new FreehandDrawingPrimitive({
    id: "instrumented-preview",
    isPreview: true,
    previewPoints: [
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      null,
      { x: 4, y: 2 },
    ],
  });
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: partialMock<DrawingAttachedParameter["chart"]>({}),
    series: partialMock<DrawingAttachedParameter["series"]>({}),
    requestUpdate: () => {},
  }));

  primitive.updateAllViews();
  const frame = drawingPerfCounters.flushFrameWork();

  assert.equal(frame?.rawPoints, 4);
  assert.equal(frame?.renderedPoints, 3);
  assert.equal(frame?.visibleEntities, 1);
  assert.equal(frame?.culledEntities, 0);
});

test("hidden freehand reports its source geometry as culled", () => {
  resetDrawingPerfCounters();
  const primitive = new FreehandDrawingPrimitive({
    id: "instrumented-hidden-preview",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 2, y: 1 }],
    hidden: true,
  });
  primitive.attached(partialMock<DrawingAttachedParameter>({
    chart: partialMock<DrawingAttachedParameter["chart"]>({}),
    series: partialMock<DrawingAttachedParameter["series"]>({}),
    requestUpdate: () => {},
  }));

  primitive.updateAllViews();
  const frame = drawingPerfCounters.flushFrameWork();

  assert.equal(frame?.rawPoints, 2);
  assert.equal(frame?.renderedPoints, 0);
  assert.equal(frame?.visibleEntities, 0);
  assert.equal(frame?.culledEntities, 1);
  assert.equal(drawingPerfCounters.snapshot().counters.sceneRebuildCount, 1);
});

test("committed legacy freehand views batch one viewport projection pass per surface frame", () => {
  const rows = [row(0, 100, 100, 100), row(1, 200, 101, 200)];
  const chart: CoordinateChartBridge = {
    timeScale: () => ({
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time) => (typeof time === "number" ? (time - 100) / 10 : null),
    }),
  };
  const series: CoordinateSeriesBridge & { priceToCoordinate(price: number): number } = {
    data: () => rows,
    priceToCoordinate: (price) => price,
  };
  const first = new FreehandDrawingPrimitive({
    id: "batch-first",
    dataPoints: [{ time: 100, price: 1 }, { time: 200, price: 2 }],
  });
  const second = new FreehandDrawingPrimitive({
    id: "batch-second",
    dataPoints: [{ time: 100, price: 3 }, { time: 200, price: 4 }],
  });
  attachPrimitive(first, chart, series);
  attachPrimitive(second, chart, series);
  first.setViewUpdateBatching(true);
  second.setViewUpdateBatching(true);
  resetDrawingPerfCounters();

  first.updateAllViews();
  second.updateAllViews();

  assert.equal(drawingPerfCounters.snapshot().counters.sceneRebuildCount, 1);
  assert.ok(first.getParityScreenSnapshot());
  assert.ok(second.getParityScreenSnapshot());
  first.detached();
  second.detached();
});

test("freehand preview cancel is terminal and remains persistence-filtered", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "v2-cancel",
    isPreview: true,
    previewPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  });
  assert.equal(primitive.cancelPreview(), true);
  assert.equal(primitive.isPreview, true);
  assert.deepEqual(primitive.previewPoints, []);
  assert.equal(primitive.commitStroke(strokeWithUnresolvedMiddle()), false);
  assert.equal(primitive.cancelPreview(), false);
});

test("legacy freehand preview commits canonical data points on pointerup", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "legacy-preview",
    isPreview: true,
    dataPoints: [
      { time: 100, logical: 1.5, order: 7, price: 10 },
      { time: 200, logical: 2.5, order: 8, price: 11 },
    ],
  });

  assert.equal(primitive.commitDataPoints(), true);
  assert.equal(primitive.isPreview, false);
  assert.deepEqual(primitive.dataPoints, [
    { time: 100, logical: 1.5, price: 10 },
    { time: 200, logical: 2.5, price: 11 },
  ]);
});

test("freehand geometry revision advances only for canonical geometry mutations", () => {
  const primitive = new FreehandDrawingPrimitive({
    id: "geometry-revision",
    dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 11 }],
  });
  const initial = primitive.geometryRevision;

  primitive.setColor("#ffffff");
  primitive.setLineWidth(4);
  assert.equal(primitive.geometryRevision, initial);

  primitive.addPoint({ time: 300, price: 12 });
  assert.equal(primitive.geometryRevision, initial + 1);
  primitive.setDataPoints([{ time: 100, price: 10 }, { time: 250, price: 12 }]);
  assert.equal(primitive.geometryRevision, initial + 2);
  assert.equal(primitive.commitDataPoints(), true);
  assert.equal(primitive.geometryRevision, initial + 3);
});
