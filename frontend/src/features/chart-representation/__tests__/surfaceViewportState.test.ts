import assert from "node:assert/strict";
import test from "node:test";

import {
  bindSurfaceViewportSourceAnchor,
  buildSurfaceViewportSnapshot,
  planSurfaceViewportRestore,
  preserveBoundSurfaceViewportSourceAnchor,
  rememberSurfaceViewport,
  selectSurfaceViewportSnapshot,
  surfaceViewportHasAnchorCoverage,
  transferSurfaceViewportSnapshot,
} from "../surfaceViewportState.js";
import type {
  OrdinalAxisTime,
  SurfaceViewportSnapshot,
} from "../chartRepresentationTypes.js";
import { IdentityProjector } from "../projectors/identityProjector.js";
import { aggregateReplayBaseBars } from "../../replay/replayViewerProjection.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
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

test("an explicit dataset transition rebinds only the owned outgoing viewport", () => {
  const snapshot = partialMock<SurfaceViewportSnapshot>({
    anchorSourceTime: 1_700_000_000,
    datasetKey: "replay-base|viewer:1m",
    logicalSpan: 120,
    screenOffset: -4,
    surfaceConfigKey: "time",
  });

  assert.deepEqual(transferSurfaceViewportSnapshot(snapshot, {
    fromDatasetKey: "replay-base|viewer:1m",
    toDatasetKey: "replay-base|viewer:5m",
  }), {
    ...snapshot,
    anchorTime: snapshot.anchorSourceTime,
    datasetKey: "replay-base|viewer:5m",
  });
  assert.equal(transferSurfaceViewportSnapshot(snapshot, {
    fromDatasetKey: "another-dataset",
    toDatasetKey: "replay-base|viewer:5m",
  }), null);
  assert.equal(transferSurfaceViewportSnapshot(snapshot, {
    fromDatasetKey: "replay-base|viewer:1m",
    toDatasetKey: "replay-base|viewer:1m",
  }), null);
});

test("dataset viewport transfer waits until target rows cover its source anchor", () => {
  const snapshot = partialMock<SurfaceViewportSnapshot>({
    anchorSourceTime: 20,
    datasetKey: "replay-base|viewer:1m",
  });

  assert.equal(surfaceViewportHasAnchorCoverage([
    { time: 30 },
    { time: 40 },
  ], snapshot), false);
  assert.equal(surfaceViewportHasAnchorCoverage([
    { time: 5 },
    { time: 20 },
    { time: 30 },
  ], snapshot), true);
  assert.equal(surfaceViewportHasAnchorCoverage([], snapshot), false);
});

test("a forming coarse replay bucket preserves an in-bucket anchor round trip", () => {
  const start = Date.UTC(2026, 6, 1, 12, 0) / 1_000;
  const baseRows: KlineBar[] = Array.from({ length: 8 }, (_, index) => ({
    time: (start + index * 60) as KlineBar["time"],
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1,
    sourceFromTime: start + index * 60,
    sourceToTime: start + index * 60,
    replayClosed: true,
  }));
  const identity = new IdentityProjector();
  const fineRows = identity.project(baseRows);
  const initial = mustBeDefined(buildSurfaceViewportSnapshot({
    axisMode: "time",
    datasetKey: "viewer:1m",
    displayRows: fineRows,
    logicalRange: { from: -43, to: 57 },
    surfaceConfigKey: "time",
  }));
  assert.equal(initial.anchorSourceTime, start + 7 * 60);

  const coarseRows = identity.project(
    aggregateReplayBaseBars(baseRows, "1m", "15m"),
  );
  const coarseTransfer = mustBeDefined(transferSurfaceViewportSnapshot(initial, {
    fromDatasetKey: "viewer:1m",
    toDatasetKey: "viewer:15m",
  }));
  assert.equal(surfaceViewportHasAnchorCoverage(coarseRows, coarseTransfer), true);
  const coarsePlan = mustBeDefined(planSurfaceViewportRestore(coarseRows, coarseTransfer, {
    axisMode: "time",
    datasetKey: "viewer:15m",
    surfaceConfigKey: "time",
  }));
  assert.deepEqual(coarsePlan.logicalRange, { from: -50, to: 50 });

  const coarseSnapshot = mustBeDefined(buildSurfaceViewportSnapshot({
    axisMode: "time",
    datasetKey: "viewer:15m",
    displayRows: coarseRows,
    logicalRange: coarsePlan.logicalRange,
    surfaceConfigKey: "time",
  }));
  assert.equal(coarseSnapshot.anchorSourceTime, start + 7 * 60);
  const fineTransfer = mustBeDefined(transferSurfaceViewportSnapshot(coarseSnapshot, {
    fromDatasetKey: "viewer:15m",
    toDatasetKey: "viewer:1m",
  }));
  const finePlan = mustBeDefined(planSurfaceViewportRestore(fineRows, fineTransfer, {
    axisMode: "time",
    datasetKey: "viewer:1m",
    surfaceConfigKey: "time",
  }));
  assert.deepEqual(finePlan.logicalRange, { from: -43, to: 57 });
});

test("a complete coarse bucket keeps the original in-bucket anchor across recapture", () => {
  const start = Date.UTC(2026, 6, 1, 12, 0) / 1_000;
  const baseRows: KlineBar[] = Array.from({ length: 15 }, (_, index) => ({
    time: (start + index * 60) as KlineBar["time"],
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1,
    sourceFromTime: start + index * 60,
    sourceToTime: start + index * 60,
    replayClosed: true,
  }));
  const fineRows = new IdentityProjector().project(baseRows);
  const initial = mustBeDefined(buildSurfaceViewportSnapshot({
    axisMode: "time",
    datasetKey: "viewer:1m",
    displayRows: fineRows,
    logicalRange: { from: -93, to: 7 },
    surfaceConfigKey: "time",
  }));
  assert.equal(initial.anchorSourceTime, start + 7 * 60);

  const coarseRows = new IdentityProjector().project(
    aggregateReplayBaseBars(baseRows, "1m", "15m"),
  );
  const transfer = mustBeDefined(transferSurfaceViewportSnapshot(initial, {
    fromDatasetKey: "viewer:1m",
    toDatasetKey: "viewer:15m",
  }));
  const plan = mustBeDefined(planSurfaceViewportRestore(coarseRows, transfer, {
    axisMode: "time",
    datasetKey: "viewer:15m",
    surfaceConfigKey: "time",
  }));
  const rawCoarseCapture = mustBeDefined(buildSurfaceViewportSnapshot({
    axisMode: "time",
    datasetKey: "viewer:15m",
    displayRows: coarseRows,
    logicalRange: plan.logicalRange,
    surfaceConfigKey: "time",
  }));
  assert.equal(rawCoarseCapture.anchorSourceTime, start + 14 * 60);

  const boundCapture = mustBeDefined(bindSurfaceViewportSourceAnchor(
    rawCoarseCapture,
    transfer,
  ));
  assert.equal(boundCapture.anchorSourceTime, start + 7 * 60);
  const nextCapture = mustBeDefined(preserveBoundSurfaceViewportSourceAnchor(
    rawCoarseCapture,
    boundCapture,
  ));
  assert.equal(nextCapture.anchorSourceTime, start + 7 * 60);

  const fineTransfer = mustBeDefined(transferSurfaceViewportSnapshot(nextCapture, {
    fromDatasetKey: "viewer:15m",
    toDatasetKey: "viewer:1m",
  }));
  const finePlan = mustBeDefined(planSurfaceViewportRestore(fineRows, fineTransfer, {
    axisMode: "time",
    datasetKey: "viewer:1m",
    surfaceConfigKey: "time",
  }));
  assert.deepEqual(finePlan.logicalRange, { from: -93, to: 7 });
});

test("viewport coverage rejects an anchor inside an internal source gap", () => {
  const snapshot = partialMock<SurfaceViewportSnapshot>({
    anchorSourceTime: 15,
    datasetKey: "viewer:1m",
  });
  assert.equal(surfaceViewportHasAnchorCoverage([
    { time: 0, sourceFromTime: 0, sourceToTime: 10 },
    { time: 20, sourceFromTime: 20, sourceToTime: 30 },
  ], snapshot), false);
});
