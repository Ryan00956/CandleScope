import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSurfaceViewportSnapshot,
  planSurfaceViewportRestore,
  rememberSurfaceViewport,
  selectSurfaceViewportSnapshot,
} from "../surfaceViewportState.js";

function ordinal(order, sourceTime, sourceOrdinal = 0) {
  return { order, sourceTime, sourceOrdinal };
}

test("cross-surface restore preserves logical density instead of sparse brick count", () => {
  const sourceRows = Array.from({ length: 121 }, (_, index) => ({ time: index }));
  const snapshot = buildSurfaceViewportSnapshot({
    axisMode: "time",
    barSpacing: 5,
    datasetKey: "btc-1h",
    displayRows: sourceRows,
    logicalRange: { from: 0, to: 120 },
    surfaceConfigKey: "time",
  });
  const renkoRows = [0, 20, 40, 60, 80, 100, 110, 120].map((sourceTime, index) => ({
    time: ordinal(index, sourceTime, 0),
  }));

  const plan = planSurfaceViewportRestore(renkoRows, snapshot, {
    axisMode: "derived-ordinal",
    datasetKey: "btc-1h",
    surfaceConfigKey: "derived-ordinal:renko",
  });

  assert.deepEqual(plan.logicalRange, { from: -113, to: 7 });
  assert.equal(plan.logicalRange.to - plan.logicalRange.from, 120);
  assert.equal(plan.barSpacing, null);
  assert.equal(plan.sameSurface, false);
});

test("surface snapshots preserve future right whitespace through anchor offsets", () => {
  const sourceRows = Array.from({ length: 100 }, (_, index) => ({ time: index }));
  const snapshot = buildSurfaceViewportSnapshot({
    axisMode: "time",
    datasetKey: "btc-1h",
    displayRows: sourceRows,
    logicalRange: { from: 5, to: 125 },
    surfaceConfigKey: "time",
  });
  const targetRows = [0, 15, 30, 45, 60, 75, 90, 99].map((sourceTime, index) => ({
    time: ordinal(index, sourceTime, 0),
  }));
  const plan = planSurfaceViewportRestore(targetRows, snapshot, {
    axisMode: "derived-ordinal",
    datasetKey: "btc-1h",
    surfaceConfigKey: "derived-ordinal:renko",
  });

  assert.equal(snapshot.screenOffset, -26);
  assert.deepEqual(plan.logicalRange, { from: -87, to: 33 });
});

test("same ordinal surface restores the exact repeated-source brick", () => {
  const rows = [
    { time: ordinal(0, 100, 0) },
    { time: ordinal(1, 100, 1) },
    { time: ordinal(2, 200, 0) },
  ];
  const snapshot = buildSurfaceViewportSnapshot({
    axisMode: "derived-ordinal",
    barSpacing: 9,
    datasetKey: "btc-1h",
    displayRows: rows,
    logicalRange: { from: -2, to: 0 },
    surfaceConfigKey: "derived-ordinal:renko",
  });
  const plan = planSurfaceViewportRestore(rows, snapshot, {
    axisMode: "derived-ordinal",
    datasetKey: "btc-1h",
    surfaceConfigKey: "derived-ordinal:renko",
  });

  assert.deepEqual(plan.logicalRange, { from: -2, to: 0 });
  assert.equal(plan.barSpacing, 9);
  assert.equal(plan.sameSurface, true);
});

test("surface cache prefers the target's remembered viewport and isolates datasets", () => {
  const cache = new Map();
  const timeSnapshot = {
    axisMode: "time",
    datasetKey: "btc-1h",
    surfaceConfigKey: "time",
  };
  const renkoSnapshot = {
    axisMode: "derived-ordinal",
    datasetKey: "btc-1h",
    surfaceConfigKey: "derived-ordinal:renko",
  };
  assert.equal(rememberSurfaceViewport(cache, timeSnapshot), true);
  assert.equal(rememberSurfaceViewport(cache, renkoSnapshot), true);

  assert.deepEqual(selectSurfaceViewportSnapshot(cache, {
    datasetKey: "btc-1h",
    outgoingSnapshot: renkoSnapshot,
    surfaceConfigKey: "time",
  }), { snapshot: timeSnapshot, source: "remembered" });
  assert.deepEqual(selectSurfaceViewportSnapshot(cache, {
    datasetKey: "eth-1h",
    outgoingSnapshot: renkoSnapshot,
    surfaceConfigKey: "time",
  }), { snapshot: null, source: "none" });
});

test("surface cache evicts the oldest entry at its bound", () => {
  const cache = new Map();
  for (let index = 0; index < 3; index += 1) {
    rememberSurfaceViewport(cache, {
      datasetKey: `dataset-${index}`,
      surfaceConfigKey: "time",
    }, { limit: 2 });
  }

  assert.equal(cache.size, 2);
  assert.equal([...cache.keys()].some((key) => key.includes("dataset-0")), false);
});
