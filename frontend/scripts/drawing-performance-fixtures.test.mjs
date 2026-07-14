import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
  normalizeSavedDrawingItem,
} from "../src/features/drawings/drawingPersistence.ts";
import {
  MAX_FREEHAND_STROKE_POINTS,
  MAX_FREEHAND_STROKE_SPANS,
  normalizeFreehandStrokeV3,
} from "../src/features/drawings/freehandStrokeModel.ts";
import {
  DEFAULT_MOCK_VISIBLE_PRICE_RANGE,
  DEFAULT_FIXTURE_OPTIONS,
  FIXTURE_LIMITS,
  FIXTURE_NAMES,
  buildDrawingFixture,
} from "./drawing-performance-fixtures.mjs";

const EXPECTED_COUNTS = Object.freeze({
  empty: { drawings: 0, freehands: 0, points: 0, totalPoints: 0 },
  singleFreehand4096: { drawings: 1, freehands: 1, points: 4_096, totalPoints: 4_096 },
  freehand64x512: { drawings: 64, freehands: 64, points: 32_768, totalPoints: 32_768 },
  entities200: { drawings: 200, freehands: 0, points: 0, totalPoints: 400 },
  entities512: { drawings: 512, freehands: 0, points: 0, totalPoints: 1_024 },
});

function parsedFixture(name, options) {
  const fixture = buildDrawingFixture(name, options);
  return { fixture, drawings: JSON.parse(fixture.raw) };
}

function freehandCounts(drawings) {
  let drawingsCount = 0;
  let points = 0;
  let spans = 0;
  let maxPoints = 0;
  let maxSpans = 0;
  for (const drawing of drawings) {
    if (drawing.type !== "freehand" && drawing.type !== "highlighter") continue;
    const drawingPoints = drawing.stroke?.points?.length ?? drawing.dataPoints?.length ?? 0;
    const drawingSpans = drawing.stroke?.spans?.length ?? 0;
    drawingsCount += 1;
    points += drawingPoints;
    spans += drawingSpans;
    maxPoints = Math.max(maxPoints, drawingPoints);
    maxSpans = Math.max(maxSpans, drawingSpans);
  }
  return { drawingsCount, points, spans, maxPoints, maxSpans };
}

function drawingPrices(drawings) {
  const prices = [];
  for (const drawing of drawings) {
    if (drawing.type === "freehand" || drawing.type === "highlighter") {
      for (const point of drawing.stroke?.points ?? drawing.dataPoints ?? []) {
        prices.push(point.price);
      }
      continue;
    }
    for (const point of drawing.dataPoints ?? []) prices.push(point.price);
    if (drawing.dataPoint?.price != null) prices.push(drawing.dataPoint.price);
  }
  return prices;
}

test("fixture limits mirror the current drawing persistence codec", () => {
  assert.deepEqual(FIXTURE_LIMITS, {
    maxStorageChars: MAX_DRAWING_STORAGE_CHARS,
    maxDrawings: MAX_SAVED_DRAWINGS,
    maxFreehandPoints: MAX_SAVED_FREEHAND_POINTS,
    maxFreehandSpans: MAX_SAVED_FREEHAND_SPANS,
    maxFreehandPointsPerDrawing: MAX_FREEHAND_STROKE_POINTS,
    maxFreehandSpansPerDrawing: MAX_FREEHAND_STROKE_SPANS,
  });
});

test("all named fixtures use the current SavedDrawing and freehand v3 schemas", () => {
  assert.deepEqual(FIXTURE_NAMES, Object.keys(EXPECTED_COUNTS));

  for (const name of FIXTURE_NAMES) {
    const { fixture, drawings } = parsedFixture(name);
    assert.equal(fixture.storageKey, `candlescope-drawings-${DEFAULT_FIXTURE_OPTIONS.scopeKey}`);
    assert.ok(Array.isArray(drawings));

    for (const drawing of drawings) {
      assert.deepEqual(normalizeSavedDrawingItem(drawing), drawing, `${name}: invalid SavedDrawing`);
      if (drawing.type !== "freehand" && drawing.type !== "highlighter") continue;
      assert.equal(drawing.stroke.version, 3);
      assert.deepEqual(normalizeFreehandStrokeV3(drawing.stroke), drawing.stroke);
      assert.equal(Object.hasOwn(drawing, "dataPoints"), false);
      for (const point of drawing.stroke.points) {
        assert.deepEqual(Object.keys(point).sort(), ["price", "time"]);
        assert.ok(Number.isFinite(point.time));
        assert.ok(Number.isFinite(point.price));
      }
    }
  }
});

test("fixtures have the promised entity and freehand point counts", () => {
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    const { fixture, drawings } = parsedFixture(name);
    const counts = freehandCounts(drawings);
    assert.equal(drawings.length, expected.drawings, `${name}: drawing count`);
    assert.equal(counts.drawingsCount, expected.freehands, `${name}: freehand count`);
    assert.equal(counts.points, expected.points, `${name}: freehand points`);
    assert.equal(fixture.metadata.drawingCount, expected.drawings);
    assert.equal(fixture.metadata.freehandDrawingCount, expected.freehands);
    assert.equal(fixture.metadata.freehandPointCount, expected.points);
    assert.equal(fixture.metadata.pointCount, expected.totalPoints);
    assert.equal(fixture.metadata.freehandSpanCount, counts.spans);
  }
});

test("entity fixtures stay low-point and contain only legal line or shape drawings", () => {
  for (const name of ["entities200", "entities512"]) {
    const { drawings } = parsedFixture(name);
    for (const drawing of drawings) {
      assert.ok(drawing.type === "line" || drawing.type === "shape");
      assert.equal(drawing.dataPoints.length, 2);
      assert.equal(Object.hasOwn(drawing, "stroke"), false);
    }
  }
});

test("non-empty fixture prices stay inside the default mock BTCUSDT visible range", () => {
  for (const name of FIXTURE_NAMES.filter((fixtureName) => fixtureName !== "empty")) {
    const { fixture, drawings } = parsedFixture(name);
    const prices = drawingPrices(drawings);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    assert.ok(prices.length > 0, `${name}: expected prices`);
    assert.ok(min >= DEFAULT_MOCK_VISIBLE_PRICE_RANGE.min, `${name}: minimum price ${min}`);
    assert.ok(max <= DEFAULT_MOCK_VISIBLE_PRICE_RANGE.max, `${name}: maximum price ${max}`);
    assert.deepEqual(fixture.metadata.priceRange, { min, max });
  }
});

test("every fixture stays within current count, point, span, and character budgets", () => {
  for (const name of FIXTURE_NAMES) {
    const { fixture, drawings } = parsedFixture(name);
    const counts = freehandCounts(drawings);
    assert.ok(drawings.length <= MAX_SAVED_DRAWINGS, `${name}: drawing budget`);
    assert.ok(counts.points <= MAX_SAVED_FREEHAND_POINTS, `${name}: total point budget`);
    assert.ok(counts.spans <= MAX_SAVED_FREEHAND_SPANS, `${name}: total span budget`);
    assert.ok(counts.maxPoints <= MAX_FREEHAND_STROKE_POINTS, `${name}: per-stroke point budget`);
    assert.ok(counts.maxSpans <= MAX_FREEHAND_STROKE_SPANS, `${name}: per-stroke span budget`);
    assert.ok(fixture.raw.length <= MAX_DRAWING_STORAGE_CHARS, `${name}: storage budget`);
    assert.equal(fixture.metadata.storageChars, fixture.raw.length);
    assert.equal(fixture.metadata.withinBudgets, true);
  }
});

test("fixture output is byte-for-byte deterministic for the same seed", () => {
  for (const name of FIXTURE_NAMES) {
    const first = buildDrawingFixture(name);
    const second = buildDrawingFixture(name);
    assert.deepEqual(second, first, name);
  }

  assert.notEqual(
    buildDrawingFixture("singleFreehand4096", { seed: 1 }).raw,
    buildDrawingFixture("singleFreehand4096", { seed: 2 }).raw,
  );
});

test("custom scope and absolute-time range are reflected in output metadata", () => {
  const startTime = 1_800_000_000;
  const intervalSeconds = 15;
  const { fixture, drawings } = parsedFixture("singleFreehand4096", {
    scopeKey: "fixture:scope__main",
    startTime,
    intervalSeconds,
    seed: 7,
  });

  assert.equal(fixture.storageKey, "candlescope-drawings-fixture:scope__main");
  assert.equal(fixture.metadata.scopeKey, "fixture:scope__main");
  assert.equal(fixture.metadata.seed, 7);
  assert.equal(fixture.metadata.timeRange.start, startTime);
  assert.equal(
    fixture.metadata.timeRange.end,
    startTime + (4_096 - 1) * intervalSeconds,
  );
  assert.equal(drawings[0].stroke.points[0].time, startTime);
  assert.equal(drawings[0].stroke.points.at(-1).time, fixture.metadata.timeRange.end);
});

test("unknown fixtures and unsafe options fail closed", () => {
  assert.throws(() => buildDrawingFixture("missing"), /Unknown drawing performance fixture/);
  assert.throws(() => buildDrawingFixture("empty", { scopeKey: "" }), /scopeKey/);
  assert.throws(() => buildDrawingFixture("empty", { intervalSeconds: 0 }), /intervalSeconds/);
  assert.throws(() => buildDrawingFixture("empty", { seed: -1 }), /seed/);
  assert.throws(
    () => buildDrawingFixture("singleFreehand4096", {
      startTime: Number.MAX_SAFE_INTEGER,
      intervalSeconds: 60,
    }),
    /time range/,
  );
});
