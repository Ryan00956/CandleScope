import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBgcolorSignature,
  flattenBgcolorRegions,
  sliceBgcolorRegionsForVisibleRange,
} from "../bgcolorPrimitiveRenderer.js";
import { flattenIndicatorMarkers } from "../markerRenderer.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";

function ordinal(order: number, sourceTime = 100, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

test("marker and bgcolor numeric times keep ascending numeric order", () => {
  const markers = flattenIndicatorMarkers([{
    data: [{ time: 30, text: "third" }, { time: 10, text: "first" }],
  }]);
  const regions = flattenBgcolorRegions([{
    regions: [{ time: 30 }, { time: 10 }],
  }]);

  assert.deepEqual(markers.map((marker) => marker.time), [10, 30]);
  assert.deepEqual(regions.map((region) => region.time), [10, 30]);
});

test("indicator markers sort ordinal coordinates by order", () => {
  const atThree = ordinal(3, 100, 2);
  const atOne = ordinal(1, 100, 0);
  const markers = flattenIndicatorMarkers([{
    data: [
      { time: atThree, text: "third" },
      { time: atOne, text: "first" },
    ],
  }]);

  assert.deepEqual(markers.map((marker) => marker.time), [atOne, atThree]);
  assert.deepEqual(markers.map((marker) => marker.text), ["first", "third"]);
});

test("bgcolor regions sort by ordinal order and signature includes each coordinate", () => {
  const regions = flattenBgcolorRegions([
    { color: "red", regions: [{ time: ordinal(7, 100, 1) }] },
    { color: "blue", regions: [{ time: ordinal(2, 100, 0) }] },
  ]);

  assert.deepEqual(regions.map((region) => (
    typeof region.time === "object" && "order" in region.time
      ? region.time.order
      : null
  )), [2, 7]);
  assert.match(buildBgcolorSignature(regions), /order:2/);
  assert.match(buildBgcolorSignature(regions), /order:7/);
});

test("bgcolor signature changes for a different ordinal or color", () => {
  const baseline = buildBgcolorSignature([{ time: ordinal(1), color: "red" }]);

  assert.notEqual(
    buildBgcolorSignature([{ time: ordinal(2), color: "red" }]),
    baseline,
  );
  assert.notEqual(
    buildBgcolorSignature([{ time: ordinal(1), color: "blue" }]),
    baseline,
  );
  assert.notEqual(
    buildBgcolorSignature([{ time: ordinal(1, 200, 0), color: "red" }]),
    baseline,
  );
});

test("bgcolor paint slices sorted history to the visible window plus edge neighbors", () => {
  const regions = Array.from({ length: 1_000 }, (_, time) => ({
    time,
    color: time % 2 ? "red" : "blue",
  }));
  const visible = sliceBgcolorRegionsForVisibleRange(regions, { from: 500, to: 509 });

  assert.deepEqual(visible.map((region) => region.time), [
    499, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510,
  ]);
  assert.ok(visible.length < regions.length / 50);
});

test("bgcolor visible slicing preserves ordinal ordering", () => {
  const regions = [1, 2, 3, 4, 5].map((order) => ({
    time: ordinal(order),
    color: "red",
  }));
  const visible = sliceBgcolorRegionsForVisibleRange(regions, {
    from: ordinal(3),
    to: ordinal(4),
  });
  assert.deepEqual(visible.map((region) => (
    typeof region.time === "object" && "order" in region.time ? region.time.order : null
  )), [2, 3, 4, 5]);
});
