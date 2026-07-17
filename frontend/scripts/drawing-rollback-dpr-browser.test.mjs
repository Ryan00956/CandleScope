import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUOUS_DPR_RESIZE_MATRIX,
  continuousDprInjectionReceipt,
  continuousDprOverlaySynchronized,
  continuousDprWorkerResultCurrent,
} from "./drawing-rollback-dpr-browser.mjs";

function stamp(overrides = {}) {
  return {
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 7,
    surfaceGeneration: 3,
    dataRevision: 5,
    projectionRevision: 11,
    lineageIndexRevision: 0,
    viewportRevision: 19,
    themeRevision: 2,
    widthCssPx: 912,
    heightCssPx: 438,
    dpr: 1.5,
    ...overrides,
  };
}

function identity(currentStamp, overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 23,
    generation: 29,
    stamp: currentStamp,
    ...overrides,
  };
}

function overlaySurface({ dpr = 1.5, bitmapWidth = 1368 } = {}) {
  const hostRect = { x: 100, y: 50, width: 1000, height: 600 };
  const adapterPlotRect = { x: 48, y: 0, width: 912, height: 438, dpr };
  const canvas = {
    present: true,
    pointerEventsNone: true,
    cssRect: {
      x: 148,
      y: 50,
      width: 912,
      height: 438,
      right: 1060,
      bottom: 488,
    },
    bitmap: { width: bitmapWidth, height: Math.round(438 * dpr) },
    style: { left: 48, top: 0, width: 912, height: 438 },
  };
  return {
    overlayCount: 2,
    hostPresent: true,
    hostPointerEventsNone: true,
    hostRect,
    devicePixelRatio: dpr,
    adapterPlotRect,
    dynamic: structuredClone(canvas),
    liveInk: structuredClone(canvas),
  };
}

test("continuous DPR matrix isolates DPR and resize transitions and restores the baseline", () => {
  assert.equal(CONTINUOUS_DPR_RESIZE_MATRIX.length, 6);
  assert.deepEqual(
    [...new Set(CONTINUOUS_DPR_RESIZE_MATRIX.map((entry) => entry.dpr))].sort(),
    [1, 1.5, 2],
  );
  assert.equal(new Set(CONTINUOUS_DPR_RESIZE_MATRIX.map(
    (entry) => `${entry.viewport.width}x${entry.viewport.height}`,
  )).size, 3);

  const baseline = { dpr: 1, viewport: { width: 1440, height: 900 } };
  const sequence = [baseline, ...CONTINUOUS_DPR_RESIZE_MATRIX];
  for (let index = 1; index < sequence.length; index += 1) {
    const previous = sequence[index - 1];
    const current = sequence[index];
    const dprChanged = current.dpr !== previous.dpr;
    const sizeChanged = current.viewport.width !== previous.viewport.width
      || current.viewport.height !== previous.viewport.height;
    assert.notEqual(dprChanged, sizeChanged, `transition ${index} must change exactly one dimension class`);
  }
  assert.deepEqual(CONTINUOUS_DPR_RESIZE_MATRIX.at(-1), baseline);
});

test("injection receipt binds all six observed requests to navigation and build authority", () => {
  const authorityTokenSha256 = "a".repeat(64);
  const navigation = {
    kind: "controlled-rollback-drill-navigation",
    runId: "run-1",
    authorityTokenSha256,
    drillId: "continuous-dpr-resize",
    variant: null,
    faultId: "fault-1",
    sequence: 7,
    bootstrap: {
      armed: true,
      authorityAccepted: true,
      tokenRemoved: true,
      runId: "run-1",
      authorityTokenSha256,
      drillId: "continuous-dpr-resize",
      variant: null,
      faultId: "fault-1",
      sequence: 7,
      documentInstanceId: "document-1",
    },
  };
  const transitions = CONTINUOUS_DPR_RESIZE_MATRIX.map((request, index) => ({
    sequence: index + 1,
    requestedDeviceMetrics: request,
    observedWindow: {
      headed: true,
      windowState: "normal",
      visibilityState: "visible",
      hidden: false,
      innerWidth: request.viewport.width,
      innerHeight: request.viewport.height,
      devicePixelRatio: request.dpr,
    },
    overlayDprSynchronized: true,
    workerResultCurrent: true,
    queueDepthCurrent: 0,
  }));

  const receipt = continuousDprInjectionReceipt(navigation, transitions, true);
  assert.equal(receipt.armed, true);
  assert.equal(receipt.observed, true);
  assert.equal(receipt.buildAuthorityCurrent, true);
  assert.equal(receipt.requestCount, 6);
  assert.equal(receipt.authorityTokenSha256, `sha256:${authorityTokenSha256}`);
  assert.equal(receipt.navigation.documentInstanceId, "document-1");

  const staleNavigation = structuredClone(navigation);
  staleNavigation.bootstrap.sequence += 1;
  assert.equal(
    continuousDprInjectionReceipt(staleNavigation, transitions, true).armed,
    false,
  );
  assert.equal(
    continuousDprInjectionReceipt(navigation, transitions, false).observed,
    false,
  );
});

test("worker convergence requires the submitted, accepted, and published identity for the current stamp", () => {
  const currentStamp = stamp();
  const currentIdentity = identity(currentStamp);
  const runtime = {
    backend: "worker",
    workerAvailability: "available",
    lastRequestedStamp: currentStamp,
    latestSubmittedWorkerIdentity: currentIdentity,
    acceptedWorkerIdentity: structuredClone(currentIdentity),
    publishedWorkerIdentity: structuredClone(currentIdentity),
  };
  assert.equal(continuousDprWorkerResultCurrent(runtime), true);

  runtime.publishedWorkerIdentity.stamp.viewportRevision += 1;
  assert.equal(continuousDprWorkerResultCurrent(runtime), false);
  runtime.publishedWorkerIdentity = structuredClone(currentIdentity);
  runtime.acceptedWorkerIdentity.jobId += 1;
  assert.equal(continuousDprWorkerResultCurrent(runtime), false);
});

test("overlay convergence derives from raw adapter, CSS, bitmap, and DPR evidence", () => {
  const passing = overlaySurface();
  assert.equal(continuousDprOverlaySynchronized(passing, 1.5), true);

  const browserRounded = overlaySurface();
  for (const canvas of [browserRounded.dynamic, browserRounded.liveInk]) {
    canvas.cssRect.height = 439;
    canvas.style.height = 439;
    canvas.bitmap.height = Math.round(438.9999 * 1.5);
  }
  assert.equal(continuousDprOverlaySynchronized(browserRounded, 1.5), true);

  const staleBitmap = overlaySurface({ bitmapWidth: 1366 });
  assert.equal(continuousDprOverlaySynchronized(staleBitmap, 1.5), false);

  const staleCss = overlaySurface();
  staleCss.liveInk.style.left = 47;
  assert.equal(continuousDprOverlaySynchronized(staleCss, 1.5), false);

  const staleAdapterDpr = overlaySurface();
  staleAdapterDpr.adapterPlotRect.dpr = 2;
  assert.equal(continuousDprOverlaySynchronized(staleAdapterDpr, 1.5), false);
});
