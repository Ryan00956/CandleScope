import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBgcolorSignature,
  flattenBgcolorRegions,
} from "../bgcolorPrimitiveRenderer.js";
import { flattenIndicatorMarkers } from "../markerRenderer.js";

function ordinal(order, sourceTime = 100, sourceOrdinal = 0) {
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

  assert.deepEqual(regions.map((region) => region.time.order), [2, 7]);
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
