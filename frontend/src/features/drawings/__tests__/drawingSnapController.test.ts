import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalDrawingAnchorFromCoordinate,
  canonicalDrawingAnchorFromAxisTime,
  snapDataPointAtPointer,
} from "../drawingSnapController.js";
import type { DrawingDataPoint } from "../drawingTypes.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../../test/testHelpers.js";

type DrawingChartAdapter = NonNullable<Parameters<typeof canonicalDrawingAnchorFromAxisTime>[0]>;
interface OrdinalAxisTime {
  order: number;
  sourceOrdinal: number;
  sourceTime: number;
}

interface OrdinalAdapterOptions {
  projection?: string;
  projectionConfig?: string;
}

function ordinalAdapter({
  projection = "renko",
  projectionConfig = `derived-ordinal:${projection}:{}`,
}: OrdinalAdapterOptions = {}) {
  const axisTime: OrdinalAxisTime = {
    order: 7,
    sourceTime: 1_700_000_000,
    sourceOrdinal: 2,
  };
  return {
    axisTime,
    adapter: structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      usesOrdinalTime: () => true,
      axisTimeToDrawingAnchor: (value: OrdinalAxisTime) => ({
        time: value.sourceTime,
        sourceOrdinal: value.sourceOrdinal,
        sourceProjection: projection,
        sourceProjectionConfig: projectionConfig,
        order: value.order,
      }),
      getSeriesData: () => [{
        time: axisTime,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
      }],
      coordinateToLogical: () => 0,
      timeToCoordinate: () => 10,
      priceToCoordinate: () => 20,
      getBarSpacing: () => 8,
    }),
  };
}

test("canonicalDrawingAnchorFromAxisTime drops projection-local ordinal order", () => {
  const { adapter, axisTime } = ordinalAdapter({ projection: "point-and-figure" });

  assert.deepEqual(canonicalDrawingAnchorFromAxisTime(adapter, axisTime), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{}",
  });
});

test("coordinate capture keeps materialized lineage but stores future space as absolute time", () => {
  const { adapter } = ordinalAdapter({ projection: "kagi" });
  adapter.coordinateToDrawingAnchor = (x) => (x < 20 ? {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    order: 7,
    logical: 9,
  } : {
    time: 1_700_000_180.5,
    order: 99,
    logical: 12.25,
  });

  assert.deepEqual(canonicalDrawingAnchorFromCoordinate(adapter, 10), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
  });
  assert.deepEqual(canonicalDrawingAnchorFromCoordinate(adapter, 30), {
    time: 1_700_000_180.5,
  });
});

test("coordinate capture rejects malformed mixed future lineage metadata", () => {
  const { adapter } = ordinalAdapter();
  for (const anchor of [
    { time: 200, sourceOrdinal: 0 },
    { time: 200, sourceProjection: "renko" },
    { time: 200, sourceProjectionConfig: "derived-ordinal:renko:{}" },
    { time: 200, sourceOrdinal: -1, logical: 12 },
  ]) {
    adapter.coordinateToDrawingAnchor = () => anchor;
    assert.equal(canonicalDrawingAnchorFromCoordinate(adapter, 30), null);
  }
});

test("coordinate capture falls back to the existing axis-time adapter contract", () => {
  const { adapter, axisTime } = ordinalAdapter();
  adapter.coordinateToTime = () => axisTime;

  assert.deepEqual(canonicalDrawingAnchorFromCoordinate(adapter, 10), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{}",
  });
});

test("derived snapping replaces stale horizontal metadata with a canonical anchor", () => {
  const { adapter } = ordinalAdapter();
  const snapped = snapDataPointAtPointer(malformedFixture<DrawingDataPoint>({
    time: 1,
    logical: 99,
    order: 99,
    sourceOrdinal: 9,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    price: 1,
  }), 10, 20, { snap: true }, adapter);

  assert.deepEqual(snapped, {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{}",
    price: 100,
  });
});

test("derived snapping preserves an absolute future time while still snapping price", () => {
  const { adapter } = ordinalAdapter();
  const snapped = snapDataPointAtPointer({
    time: 1_700_000_180.5,
    price: 1,
  }, 10, 20, { snap: true }, adapter);

  assert.deepEqual(snapped, {
    time: 1_700_000_180.5,
    price: 100,
  });
});

test("time-axis snapping clears stale derived metadata without changing numeric time semantics", () => {
  const adapter = structuralMock<DrawingChartAdapter>({
    isReady: () => true,
    usesOrdinalTime: () => false,
    getSeriesData: () => [{ time: 200, value: 10 }],
    coordinateToLogical: () => 0,
    timeToCoordinate: () => 10,
    priceToCoordinate: () => 20,
  });
  const snapped = snapDataPointAtPointer({
    time: 100,
    sourceOrdinal: 4,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{}",
    price: 1,
  }, 10, 20, { snap: true }, adapter);

  assert.deepEqual(snapped, { time: 200, price: 10 });
});

test("invalid ordinal anchors are never copied into drawing time", () => {
  const { adapter } = ordinalAdapter();
  adapter.axisTimeToDrawingAnchor = () => malformedFixture<
    ReturnType<DrawingChartAdapter["axisTimeToDrawingAnchor"]>
  >({
    time: 1_700_000_000,
    sourceOrdinal: -1,
    sourceProjection: "renko",
  });
  const original = {
    time: 123,
    sourceOrdinal: 0,
    sourceProjection: "kagi",
    sourceProjectionConfig: "derived-ordinal:kagi:{}",
    price: 1,
  };

  const snapped = snapDataPointAtPointer(original, 10, 20, { snap: true }, adapter);
  const resolved = mustBeDefined(snapped);
  assert.equal(typeof resolved.time, "number");
  assert.notEqual(typeof resolved.time, "object");
  assert.equal(resolved.price, 100);
});
