import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDrawingEntityDrag,
  drawingEntityGeometryCommandForDrag,
  type DrawingEntityDragOptions,
} from "../drawingEntityDrag.js";
import type { DrawingDragDescriptor } from "../../drawingDragResizeController.js";
import type {
  DrawingCoordinateOptions,
  DrawingDataPoint,
  SavedDrawing,
  SavedTextDrawing,
  ScreenPoint,
} from "../../drawingTypes.js";

function sourcePoint(time: number, price: number): DrawingDataPoint {
  return { time, price };
}

function derivedPoint(time: number, sourceOrdinal: number, price: number): DrawingDataPoint {
  return {
    time,
    sourceOrdinal,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:{}",
    price,
  };
}

function partialDescriptor(value: object): DrawingDragDescriptor {
  return value as DrawingDragDescriptor;
}

function apply(
  descriptor: DrawingDragDescriptor,
  drawing: SavedDrawing,
  overrides: Partial<Omit<DrawingEntityDragOptions, "descriptor" | "drawing">> = {},
): SavedDrawing | null {
  return applyDrawingEntityDrag({
    descriptor,
    drawing,
    pos: { x: 10, y: 20 },
    screenToData: (x, y) => ({ time: x, price: y }),
    screenToDrawingData: (x, y) => ({ time: x, price: y }),
    dataToScreen: (point) => ({ x: Number(point.time), y: point.price }),
    snap: true,
    ...overrides,
  });
}

function drawingOfType<TType extends SavedDrawing["type"]>(
  drawing: SavedDrawing | null,
  type: TType,
): Extract<SavedDrawing, { type: TType }> {
  assert.ok(drawing);
  assert.equal(drawing.type, type);
  return drawing as Extract<SavedDrawing, { type: TType }>;
}

function textDrawing(drawing: SavedDrawing | null): SavedTextDrawing {
  assert.ok(drawing);
  assert.equal(drawing.type, "text");
  return drawing as SavedTextDrawing;
}

test("entity drag command preserves move versus resize intent for every descriptor family", () => {
  const cases: Array<readonly [DrawingDragDescriptor, "move" | "resize"]> = [
    [partialDescriptor({ type: "text" }), "move"],
    [partialDescriptor({ type: "text-handle" }), "resize"],
    [partialDescriptor({ type: "position-move" }), "move"],
    [partialDescriptor({ type: "position-panel" }), "move"],
    [partialDescriptor({ type: "position-tp" }), "resize"],
    [partialDescriptor({ type: "position-sl" }), "resize"],
    [partialDescriptor({ type: "position-left" }), "resize"],
    [partialDescriptor({ type: "position-right" }), "resize"],
    [partialDescriptor({ type: "position-top-left" }), "resize"],
    [partialDescriptor({ type: "position-bottom-right" }), "resize"],
    [partialDescriptor({ type: "axis-line" }), "move"],
    [partialDescriptor({ type: "shape", zone: "body" }), "move"],
    [partialDescriptor({ type: "shape", zone: "center" }), "move"],
    [partialDescriptor({ type: "shape", zone: "br" }), "resize"],
    [partialDescriptor({ type: "line", pointIndex: -1 }), "move"],
    [partialDescriptor({ type: "line", pointIndex: 0 }), "resize"],
    [partialDescriptor({ type: "angle", pointIndex: -1 }), "move"],
    [partialDescriptor({ type: "fibonacci", pointIndex: 1 }), "resize"],
  ];
  for (const [descriptor, expected] of cases) {
    assert.equal(drawingEntityGeometryCommandForDrag(descriptor), expected);
  }
});

test("text body drag replaces the canonical anchor without mutating its source", () => {
  const originalPoint = derivedPoint(100, 3, 20);
  const drawing: SavedDrawing = {
    id: "text",
    type: "text",
    dataPoint: originalPoint,
    text: "中文",
    fontSize: 16,
  };
  const before = structuredClone(drawing);
  let target: ScreenPoint | null = null;
  let coordinateOptions: DrawingCoordinateOptions | undefined;
  const next = textDrawing(apply({
    id: "text",
    type: "text",
    startMouse: { x: 0, y: 0 },
    origDataPoint: originalPoint,
  }, drawing, {
    pos: { x: 5, y: 10 },
    dataToScreen: () => ({ x: 10, y: 20 }),
    screenToDrawingData: (x, y, options) => {
      target = { x, y };
      coordinateOptions = options;
      return { time: 300.5, price: 25 };
    },
  }));

  assert.deepEqual(target, { x: 15, y: 30 });
  assert.deepEqual(coordinateOptions, { snap: true });
  assert.deepEqual(next.dataPoint, { time: 300.5, price: 25 });
  assert.deepEqual(drawing, before);
  assert.notStrictEqual(next, drawing);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.dataPoint), true);
});

test("text drag supports all eight handles and preserves fixed derived anchors", () => {
  const handles = ["tl", "t", "tr", "r", "br", "b", "bl", "l"] as const;
  const originalPoint = derivedPoint(100, 2, 20);
  const drawing: SavedDrawing = {
    id: "text-handles",
    type: "text",
    dataPoint: originalPoint,
    text: "wrapped\ntext",
    fontSize: 20,
    widthPx: 100,
  };
  const before = structuredClone(drawing);

  for (const handle of handles) {
    const next = textDrawing(apply({
      id: "text-handles",
      type: "text-handle",
      handle,
      startMouse: { x: 0, y: 0 },
      origBox: { x: 10, y: 20, width: 100, height: 50 },
      origFontSize: 20,
      origWidthPx: 100,
      origDataPoint: originalPoint,
    }, drawing, {
      pos: { x: 10, y: 10 },
      screenToData: (x, y) => ({ time: 1000 + x, price: y }),
    }));

    assert.equal(Object.isFrozen(next), true, handle);
    assert.ok(typeof next.widthPx === "number" && next.widthPx >= 20, handle);
    if (handle === "l" || handle === "r") assert.equal(next.fontSize, 20, handle);
    else assert.ok(typeof next.fontSize === "number" && next.fontSize >= 8, handle);

    if (handle === "t") {
      assert.deepEqual(next.dataPoint, {
        time: 100,
        sourceOrdinal: 2,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:{}",
        price: next.dataPoint?.price,
      }, handle);
    }
    if (handle === "l" || handle === "tl" || handle === "tr" || handle === "bl") {
      assert.notEqual(next.dataPoint?.time, originalPoint.time, handle);
    }
    if (handle === "r" || handle === "b" || handle === "br") {
      assert.deepEqual(next.dataPoint, originalPoint, handle);
    }
  }
  assert.deepEqual(drawing, before);
});

function positionDrawing(): SavedDrawing {
  return {
    id: "position",
    type: "position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 110,
    slPrice: 95,
    timeRange: { start: { time: 100 }, end: { time: 200 } },
    infoPanelOffset: { x: 5, y: 0 },
  };
}

test("position TP, SL, and panel drags stay immutable and retain command semantics", () => {
  const original = positionDrawing();
  const before = structuredClone(original);
  const coordinateCalls: DrawingCoordinateOptions[] = [];
  const priceConverter = (_x: number, y: number, options?: DrawingCoordinateOptions) => {
    if (options) coordinateCalls.push(options);
    return { time: 150, price: y };
  };
  const tp = drawingOfType(apply({
    id: "position",
    type: "position-tp",
    startMouse: { x: 0, y: 0 },
    origTpPrice: 110,
  }, original, {
    pos: { x: 10, y: 90 },
    screenToDrawingData: priceConverter,
  }), "position");
  const sl = drawingOfType(apply({
    id: "position",
    type: "position-sl",
    startMouse: { x: 0, y: 0 },
    origSlPrice: 95,
  }, original, {
    pos: { x: 10, y: 110 },
    screenToDrawingData: priceConverter,
  }), "position");
  const panel = drawingOfType(apply({
    id: "position",
    type: "position-panel",
    startMouse: { x: 10, y: 10 },
    origInfoPanelOffset: { x: 5, y: 0 },
  }, original, {
    pos: { x: 20, y: 5 },
  }), "position");

  assert.equal(tp.tpPrice, 100);
  assert.equal(sl.slPrice, 100);
  assert.deepEqual(panel.infoPanelOffset, { x: 15, y: -5 });
  assert.deepEqual(coordinateCalls, [
    { snap: true, time: false, price: true },
    { snap: true, time: false, price: true },
  ]);
  assert.deepEqual(original, before);
  assert.equal(Object.isFrozen(panel.infoPanelOffset), true);
});

test("position panel drag switches to a stable left-edge anchor without a jump", () => {
  const original = positionDrawing();
  const panel = drawingOfType(apply({
    id: "position",
    type: "position-panel",
    startMouse: { x: 0, y: 0 },
    origInfoPanelOffset: { x: 0, y: 0 },
  }, original, {
    pos: { x: -100, y: 5 },
  }), "position");

  assert.deepEqual(panel.infoPanelOffset, { anchor: "left", x: 0, y: 5 });

  const afterZoom = drawingOfType(apply({
    id: "position",
    type: "position-panel",
    startMouse: { x: 0, y: 0 },
    origInfoPanelOffset: panel.infoPanelOffset ?? { x: 0, y: 0 },
  }, panel, {
    pos: { x: 0, y: 0 },
    dataToScreen: (point) => ({
      x: 100 + (Number(point.time) - 100) * 2,
      y: point.price,
    }),
  }), "position");

  assert.deepEqual(afterZoom.infoPanelOffset, { anchor: "left", x: 0, y: 5 });
});

test("position whole drag atomically moves derived and absolute-future anchors", () => {
  const original: SavedDrawing = {
    id: "position",
    type: "position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 110,
    slPrice: 95,
    timeRange: {
      start: derivedPoint(100, 0, 100),
      end: { time: 300.5 },
    },
  };
  const before = structuredClone(original);
  const optionsSeen: Array<DrawingCoordinateOptions | undefined> = [];
  let conversion = 0;
  const next = drawingOfType(apply({
    id: "position",
    type: "position-move",
    startMouse: { x: 0, y: 0 },
    origEntry: 100,
    origTp: 110,
    origSl: 95,
    origTimeRange: original.timeRange ?? { start: null, end: null },
  }, original, {
    pos: { x: 10, y: 10 },
    dataToScreen: (point) => {
      if (point.time === 100) return { x: 10, y: 100 };
      if (point.time === 300.5) return { x: 30, y: 100 };
      return { x: 22, y: 105 };
    },
    screenToDrawingData: (_x, _y, options) => {
      optionsSeen.push(options);
      conversion += 1;
      return conversion === 1
        ? derivedPoint(200, 1, 105)
        : { time: 400.5, price: 105 };
    },
  }), "position");

  assert.equal(next.entryPrice, 105);
  assert.equal(next.tpPrice, 115);
  assert.equal(next.slPrice, 100);
  assert.deepEqual(next.timeRange, {
    start: {
      time: 200,
      sourceOrdinal: 1,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:{}",
    },
    end: { time: 400.5 },
  });
  assert.deepEqual(optionsSeen, [{ snap: true }, { snap: false }]);
  assert.equal(Object.isFrozen(next.timeRange), true);
  assert.deepEqual(original, before);
});

test("position left and right drags replace only the visual endpoint", () => {
  const original = positionDrawing();
  const dataToScreen = (point: DrawingDataPoint): ScreenPoint | null => {
    if (point.time === 100) return { x: 10, y: 100 };
    if (point.time === 200) return { x: 30, y: 100 };
    if (point.time === 50) return { x: 5, y: 100 };
    if (point.time === 400) return { x: 40, y: 100 };
    return null;
  };
  const range = drawingOfType(original, "position").timeRange ?? { start: null, end: null };
  const left = drawingOfType(apply({
    id: "position",
    type: "position-left",
    startMouse: { x: 0, y: 0 },
    origTimeRange: range,
  }, original, {
    pos: { x: 5, y: 100 },
    dataToScreen,
    screenToDrawingData: () => ({ time: 50, price: 100 }),
  }), "position");
  const right = drawingOfType(apply({
    id: "position",
    type: "position-right",
    startMouse: { x: 0, y: 0 },
    origTimeRange: range,
  }, original, {
    pos: { x: 40, y: 100 },
    dataToScreen,
    screenToDrawingData: () => derivedPoint(400, 4, 100),
  }), "position");

  assert.deepEqual(left.timeRange, { start: { time: 50 }, end: { time: 200 } });
  assert.deepEqual(right.timeRange, {
    start: { time: 100 },
    end: {
      time: 400,
      sourceOrdinal: 4,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset-a:renko:{}",
    },
  });
});

test("position corner drags resize the matching horizontal and risk-reward sides together", () => {
  const dataToScreen = (point: DrawingDataPoint): ScreenPoint | null => (
    typeof point.time === "number"
      ? { x: point.time / 10, y: 300 - point.price }
      : null
  );
  const coordinateCalls: DrawingCoordinateOptions[] = [];
  const screenToDrawingData = (x: number, y: number, options?: DrawingCoordinateOptions) => {
    if (options) coordinateCalls.push(options);
    return { time: x * 10, price: 300 - y };
  };
  const long = drawingOfType(positionDrawing(), "position");
  const short: Extract<SavedDrawing, { type: "position" }> = {
    ...long,
    id: "short-position",
    direction: "short",
    tpPrice: 90,
    slPrice: 110,
  };
  const longRange = long.timeRange ?? { start: null, end: null };
  const shortRange = short.timeRange ?? { start: null, end: null };

  const topLeft = drawingOfType(apply({
    id: "position",
    type: "position-top-left",
    startMouse: { x: 10, y: 190 },
    origTimeRange: longRange,
  }, long, {
    pos: { x: 5, y: 180 },
    dataToScreen,
    screenToDrawingData,
  }), "position");
  const bottomRight = drawingOfType(apply({
    id: "position",
    type: "position-bottom-right",
    startMouse: { x: 20, y: 205 },
    origTimeRange: longRange,
  }, long, {
    pos: { x: 40, y: 220 },
    dataToScreen,
    screenToDrawingData,
  }), "position");
  const topRight = drawingOfType(apply({
    id: "short-position",
    type: "position-top-right",
    startMouse: { x: 20, y: 190 },
    origTimeRange: shortRange,
  }, short, {
    pos: { x: 40, y: 180 },
    dataToScreen,
    screenToDrawingData,
  }), "position");
  const bottomLeft = drawingOfType(apply({
    id: "short-position",
    type: "position-bottom-left",
    startMouse: { x: 10, y: 210 },
    origTimeRange: shortRange,
  }, short, {
    pos: { x: 5, y: 220 },
    dataToScreen,
    screenToDrawingData,
  }), "position");
  const invertedTopLeft = drawingOfType(apply({
    id: "position",
    type: "position-top-left",
    startMouse: { x: 10, y: 95 },
    origTimeRange: longRange,
  }, long, {
    pos: { x: 5, y: 80 },
    dataToScreen: (point) => (
      typeof point.time === "number" ? { x: point.time / 10, y: point.price } : null
    ),
    screenToDrawingData: (x, y, options) => {
      if (options) coordinateCalls.push(options);
      return { time: x * 10, price: y };
    },
  }), "position");

  assert.deepEqual(topLeft.timeRange, { start: { time: 50 }, end: { time: 200 } });
  assert.equal(topLeft.tpPrice, 120, "long visual top controls TP");
  assert.deepEqual(bottomRight.timeRange, { start: { time: 100 }, end: { time: 400 } });
  assert.equal(bottomRight.slPrice, 80, "long visual bottom controls SL");
  assert.deepEqual(topRight.timeRange, { start: { time: 100 }, end: { time: 400 } });
  assert.equal(topRight.slPrice, 120, "short visual top controls SL");
  assert.deepEqual(bottomLeft.timeRange, { start: { time: 50 }, end: { time: 200 } });
  assert.equal(bottomLeft.tpPrice, 80, "short visual bottom controls TP");
  assert.deepEqual(invertedTopLeft.timeRange, { start: { time: 50 }, end: { time: 200 } });
  assert.equal(invertedTopLeft.slPrice, 80, "visual top remains the top boundary on an inverted scale");
  assert.deepEqual(coordinateCalls, [
    { snap: true, time: true, price: true },
    { snap: true, time: true, price: true },
    { snap: true, time: true, price: true },
    { snap: true, time: true, price: true },
    { snap: true, time: true, price: true },
  ]);
});

test("axis-line drags preserve or replace canonical anchor dimensions by subtype", () => {
  const originalPoint = derivedPoint(100, 2, 10);
  const nextPoint = { time: 300.5, price: 99 };
  const expected = {
    horizontal: { ...originalPoint, price: 99 },
    vertical: { time: 300.5, price: 10 },
    cross: nextPoint,
  } as const;
  const optionsSeen: DrawingCoordinateOptions[] = [];
  for (const axisLineType of ["horizontal", "vertical", "cross"] as const) {
    const drawing: SavedDrawing = {
      id: `axis-${axisLineType}`,
      type: "axis-line",
      axisLineType,
      dataPoint: originalPoint,
    };
    const next = drawingOfType(apply({
      id: `axis-${axisLineType}`,
      type: "axis-line",
      zone: "center",
      startMouse: { x: 0, y: 0 },
      origDataPoint: originalPoint,
    }, drawing, {
      screenToDrawingData: (_x, _y, options) => {
        if (options) optionsSeen.push(options);
        return nextPoint;
      },
    }), "axis-line");
    assert.deepEqual(next.dataPoint, expected[axisLineType]);
  }
  assert.deepEqual(optionsSeen, [
    { snap: true, time: false, price: true },
    { snap: true, time: true, price: false },
    { snap: true, time: true, price: true },
  ]);
});

test("shape body and handle drags create detached canonical corner arrays", () => {
  const points = [derivedPoint(100, 0, 10), sourcePoint(200.5, 30)];
  const drawing: SavedDrawing = {
    id: "shape",
    type: "shape",
    shapeType: "rectangle",
    dataPoints: points,
  };
  const before = structuredClone(drawing);
  const body = drawingOfType(apply({
    id: "shape",
    type: "shape",
    zone: "body",
    startMouse: { x: 0, y: 0 },
    origPoints: points,
    origBox: { x: 10, y: 10, width: 20, height: 20 },
  }, drawing, {
    pos: { x: 5, y: 5 },
    dataToScreen: (point) => point.time === 100
      ? { x: 10, y: 10 }
      : { x: 30, y: 30 },
    screenToData: (x, y) => ({ time: 1000 + x, price: y }),
  }), "shape");
  const handle = drawingOfType(apply({
    id: "shape",
    type: "shape",
    zone: "br",
    startMouse: { x: 30, y: 30 },
    origPoints: points,
    origBox: { x: 10, y: 10, width: 20, height: 20 },
  }, drawing, {
    pos: { x: 40, y: 50 },
    screenToData: (x, y) => ({ time: 2000 + x, price: y }),
  }), "shape");

  assert.deepEqual(body.dataPoints, [
    { time: 1015, price: 15 },
    { time: 1035, price: 35 },
  ]);
  assert.deepEqual(handle.dataPoints, [
    { time: 2010, price: 10 },
    { time: 2040, price: 50 },
  ]);
  assert.equal(Object.isFrozen(body.dataPoints), true);
  assert.deepEqual(drawing, before);
});

test("line, angle, and fibonacci support endpoint resize and whole-body move", () => {
  const kinds = [
    { descriptorType: "line", drawingType: "line" },
    { descriptorType: "angle", drawingType: "angle-measure" },
    { descriptorType: "fibonacci", drawingType: "fibonacci" },
  ] as const;
  for (const { descriptorType, drawingType } of kinds) {
    const points = [derivedPoint(100, 0, 10), sourcePoint(300.5, 30)];
    const drawing = {
      id: descriptorType,
      type: drawingType,
      dataPoints: points,
    } as SavedDrawing;
    const before = structuredClone(drawing);
    const endpoint = drawingOfType(apply({
      id: descriptorType,
      type: descriptorType,
      pointIndex: 1,
      startMouse: { x: 0, y: 0 },
      origPoints: points,
    }, drawing, {
      pos: { x: 80, y: 90 },
      snap: false,
      screenToDrawingData: () => derivedPoint(400, 4, 40),
    }), drawingType);
    const body = drawingOfType(apply({
      id: descriptorType,
      type: descriptorType,
      pointIndex: -1,
      startMouse: { x: 0, y: 0 },
      origPoints: points,
    }, drawing, {
      pos: { x: 5, y: 10 },
      dataToScreen: (point) => point.time === 100
        ? { x: 10, y: 10 }
        : { x: 30, y: 30 },
      screenToData: (x, y) => ({ time: 500 + x, price: y }),
    }), drawingType);

    assert.deepEqual(endpoint.dataPoints?.[0], points[0], descriptorType);
    assert.deepEqual(endpoint.dataPoints?.[1], derivedPoint(400, 4, 40), descriptorType);
    assert.deepEqual(body.dataPoints, [
      { time: 515, price: 20 },
      { time: 535, price: 40 },
    ], descriptorType);
    assert.equal(Object.isFrozen(endpoint.dataPoints), true, descriptorType);
    assert.deepEqual(drawing, before, descriptorType);
  }
});

test("conversion failures, converter throws, unsupported kinds, and id mismatch fail closed", () => {
  const drawing: SavedDrawing = {
    id: "line",
    type: "line",
    dataPoints: [sourcePoint(1, 1), sourcePoint(2, 2)],
  };
  const before = structuredClone(drawing);
  const descriptor: DrawingDragDescriptor = {
    id: "line",
    type: "line",
    pointIndex: 0,
    startMouse: { x: 0, y: 0 },
    origPoints: drawing.dataPoints ?? [],
  };

  assert.equal(apply(descriptor, drawing, { screenToDrawingData: () => null }), null);
  assert.equal(apply(descriptor, drawing, {
    screenToDrawingData: () => { throw new Error("projection unavailable"); },
  }), null);
  assert.equal(apply({ ...descriptor, id: "other" }, drawing), null);
  assert.equal(apply(descriptor, {
    id: "line",
    type: "freehand",
    dataPoints: [sourcePoint(1, 1)],
  }), null);
  assert.deepEqual(drawing, before);
});
