import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSurfaceViewportSnapshot,
  planSurfaceViewportRestore,
  rememberSurfaceViewport,
  selectSurfaceViewportSnapshot,
} from "../surfaceViewportState.js";
import type {
  OrdinalAxisTime,
  SurfaceViewportSnapshot,
} from "../chartRepresentationTypes.js";
import { mustBeDefined, partialMock } from "../../../test/testHelpers.js";

function ordinal(order: number, sourceTime: number, sourceOrdinal = 0): OrdinalAxisTime {
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

  const restorePlan = mustBeDefined(plan);
  assert.deepEqual(restorePlan.logicalRange, { from: -113, to: 7 });
  assert.equal(
    mustBeDefined(restorePlan.logicalRange).to - mustBeDefined(restorePlan.logicalRange).from,
    120,
  );
  assert.equal(restorePlan.barSpacing, null);
  assert.equal(restorePlan.sameSurface, false);
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

  assert.equal(mustBeDefined(snapshot).screenOffset, -26);
  assert.deepEqual(mustBeDefined(plan).logicalRange, { from: -87, to: 33 });
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

  const restorePlan = mustBeDefined(plan);
  assert.deepEqual(restorePlan.logicalRange, { from: -2, to: 0 });
  assert.equal(restorePlan.barSpacing, 9);
  assert.equal(restorePlan.sameSurface, true);
});

test("surface cache prefers the target's remembered viewport and isolates datasets", () => {
  const cache = new Map<string, SurfaceViewportSnapshot>();
  const timeSnapshot = partialMock<SurfaceViewportSnapshot>({
    axisMode: "time",
    datasetKey: "btc-1h",
    surfaceConfigKey: "time",
  });
  const renkoSnapshot = partialMock<SurfaceViewportSnapshot>({
    axisMode: "derived-ordinal",
    datasetKey: "btc-1h",
    surfaceConfigKey: "derived-ordinal:renko",
  });
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
  const cache = new Map<string, SurfaceViewportSnapshot>();
  for (let index = 0; index < 3; index += 1) {
    rememberSurfaceViewport(cache, partialMock<SurfaceViewportSnapshot>({
      datasetKey: `dataset-${index}`,
      surfaceConfigKey: "time",
    }), { limit: 2 });
  }

  assert.equal(cache.size, 2);
  assert.equal([...cache.keys()].some((key) => key.includes("dataset-0")), false);
});
