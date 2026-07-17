import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrillWorkerLifecycle,
  offscreenTypedFallbackCurrent,
  captureDrillBuildAuthority,
} from "./drawing-rollback-worker-browser.mjs";

const ASSET_DIGEST = `sha256:${"a".repeat(64)}`;

function workerTarget({
  targetId,
  attachedObservationSequence,
  detachedObservationSequence = null,
  active = detachedObservationSequence === null,
  ...overrides
}) {
  return {
    targetId,
    path: "assets/drawing.worker-a1b2c3d4.js",
    active,
    attachedObservationSequence,
    detachedObservationSequence,
    manifestBacked: true,
    constructorProvenanceAccepted: true,
    networkProvenanceAccepted: true,
    assetAccepted: true,
    assetDigest: ASSET_DIGEST,
    expectedAssetDigest: ASSET_DIGEST,
    ...overrides,
  };
}

function assess(workerTargets, overrides = {}) {
  return assessDrillWorkerLifecycle({
    drillId: "active-gesture-chart-boundary",
    evidenceAuthoritative: true,
    constructionFaultCount: 0,
    workerTargets,
    ...overrides,
  });
}

function fallbackStamp(themeRevision = 2) {
  return {
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 1,
    surfaceGeneration: 1,
    dataRevision: 1,
    projectionRevision: 1,
    lineageIndexRevision: 0,
    viewportRevision: 2,
    themeRevision,
    widthCssPx: 996,
    heightCssPx: 765,
    dpr: 1,
  };
}

function fallbackIdentity(jobId, themeRevision = 2) {
  return { schemaVersion: 1, jobId, generation: jobId, stamp: fallbackStamp(themeRevision) };
}

function offscreenFallbackFixture({ superseded = false } = {}) {
  const latest = fallbackIdentity(superseded ? 2 : 1, 2);
  const requests = superseded
    ? [{ header: fallbackIdentity(1, 1) }, { header: structuredClone(latest) }]
    : [{ header: structuredClone(latest) }];
  return {
    bundle: {
      summary: { entityCount: 1 },
      runtime: {
        backend: "main-thread",
        workerAvailability: "disposed",
        workerJobDelta: requests.length,
        workerResultDelta: 1,
        pendingDropDelta: 0,
        staleResultDropDelta: 0,
        queueDepthMax: requests.length,
        inFlightMax: 1,
        queueDepthCurrent: 0,
        inFlightCurrent: 0,
        lastRequestedStamp: structuredClone(latest.stamp),
        lastPublishedStamp: structuredClone(latest.stamp),
        lastPaintedStamp: structuredClone(latest.stamp),
        paintReceipt: {
          kind: "drawing-scene-bridge-paint-ack",
          stamp: structuredClone(latest.stamp),
          paintSequence: 2,
        },
        latestSubmittedWorkerIdentity: structuredClone(latest),
      },
    },
    state: {
      workerCreations: 1,
      renderRequestCount: requests.length,
      renderResultCount: 1,
      typedResultCount: 1,
      bitmapResultCount: 0,
      renderRequests: requests,
      renderResults: [{ header: structuredClone(latest), resultKind: "typed-draw-result" }],
    },
  };
}

test("Offscreen typed fallback accepts a latest-wins request superseded before its only worker result", () => {
  const direct = offscreenFallbackFixture();
  assert.equal(offscreenTypedFallbackCurrent(direct.bundle, direct.state, 1), true);

  const superseded = offscreenFallbackFixture({ superseded: true });
  assert.equal(offscreenTypedFallbackCurrent(superseded.bundle, superseded.state, 1), true);

  superseded.state.renderResults[0].header = fallbackIdentity(1, 1);
  assert.equal(offscreenTypedFallbackCurrent(superseded.bundle, superseded.state, 1), false);
  superseded.state.renderResults[0].header = fallbackIdentity(2, 2);
  superseded.state.bitmapResultCount = 1;
  assert.equal(offscreenTypedFallbackCurrent(superseded.bundle, superseded.state, 1), false);

  const stampDrift = offscreenFallbackFixture({ superseded: true });
  stampDrift.state.renderRequests[0].header.stamp.viewportRevision -= 1;
  assert.equal(offscreenTypedFallbackCurrent(stampDrift.bundle, stampDrift.state, 1), false);

  const dropped = offscreenFallbackFixture({ superseded: true });
  dropped.bundle.runtime.pendingDropDelta = 1;
  assert.equal(offscreenTypedFallbackCurrent(dropped.bundle, dropped.state, 1), false);
});

test("worker lifecycle accepts one active worker after exact serial detached handoffs", () => {
  const result = assess([
    workerTarget({
      targetId: "worker-1",
      attachedObservationSequence: 10,
      detachedObservationSequence: 20,
    }),
    workerTarget({
      targetId: "worker-2",
      attachedObservationSequence: 30,
      detachedObservationSequence: 40,
    }),
    workerTarget({ targetId: "worker-3", attachedObservationSequence: 50 }),
  ]);

  assert.equal(result.kind, "active-worker");
  assert.equal(result.accepted, true);
  assert.equal(result.assetAuthorityAccepted, true);
  assert.equal(result.serialHandoffAccepted, true);
  assert.equal(result.drawingWorkerTargetCount, 3);
  assert.equal(result.activeDrawingWorkerTargetCount, 1);
  assert.equal(result.detachedDrawingWorkerTargetCount, 2);
});

test("build authority retains and accepts the complete serial worker lifecycle", async () => {
  const workerTargets = [
    workerTarget({
      targetId: "worker-1",
      attachedObservationSequence: 10,
      detachedObservationSequence: 20,
    }),
    workerTarget({ targetId: "worker-2", attachedObservationSequence: 30 }),
  ].map((target) => ({
    ...target,
    type: "worker",
    assetSha256: "a".repeat(64),
    expectedAssetSha256: "a".repeat(64),
  }));
  const session = {
    buildReceipt: null,
    async readBrowserBuildEvidence() {
      return {
        authoritative: true,
        assetAuthoritative: true,
        networkAssetsPassed: true,
        networkAssets: {
          expectedDrawingWorkerPaths: ["assets/drawing.worker-a1b2c3d4.js"],
          workerConstructionFaults: [],
          workerTargets,
        },
      };
    },
  };

  const receipt = await captureDrillBuildAuthority(
    session,
    "active-gesture-chart-boundary",
  );
  assert.equal(receipt.authoritative, true);
  assert.equal(receipt.fullBuildAuthoritative, true);
  assert.equal(receipt.assetBuildAuthoritative, true);
  assert.equal(receipt.workerLifecycle.accepted, true);
  assert.equal(receipt.workerLifecycle.serialHandoffAccepted, true);
  assert.equal(receipt.workerLifecycle.activeDrawingWorkerTargetCount, 1);
  assert.equal(receipt.workerLifecycle.detachedDrawingWorkerTargetCount, 1);
  assert.equal(receipt.workerLifecycle.targets.length, 2);
});

test("per-drill lifecycle rejects initial zero-worker readiness and mismatched faults", async () => {
  const noWorker = assess([]);
  assert.equal(noWorker.assetAuthorityAccepted, true);
  assert.equal(noWorker.serialHandoffAccepted, false);
  assert.equal(noWorker.accepted, false);

  const mismatchedFault = assess([], { constructionFaultCount: 1 });
  assert.equal(mismatchedFault.accepted, false);

  const session = {
    buildReceipt: null,
    async readBrowserBuildEvidence() {
      return {
        authoritative: true,
        assetAuthoritative: true,
        networkAssets: {
          expectedDrawingWorkerPaths: ["assets/drawing.worker-a1b2c3d4.js"],
          workerConstructionFaults: [],
          workerTargets: [],
        },
      };
    },
  };
  await assert.rejects(
    captureDrillBuildAuthority(session, "active-gesture-chart-boundary"),
    /active-gesture-chart-boundary build authority failed/,
  );
});

test("legacy build authority accepts an authoritative asset graph without a drawing worker target", async () => {
  const session = {
    profileId: "controlled-profile:test",
    configuration: { documentAuthority: "legacy" },
    buildReceipt: { inputFingerprint: { sha256: "b".repeat(64) } },
    currentConfiguration() {
      return {
        documentAuthority: "legacy",
        engineMode: "legacy",
        interactionSurfaceMode: "legacy",
        rasterBackend: "main-thread",
      };
    },
    currentBuildReceipt() {
      return this.buildReceipt;
    },
    lifecycle() {
      return {
        browser: { pid: 101 },
        servers: { api: { pid: 201 }, preview: { pid: 202 } },
      };
    },
    async readBrowserBuildEvidence({ requireActiveWorkers }) {
      assert.equal(requireActiveWorkers, false);
      return {
        authoritative: true,
        assetAuthoritative: true,
        networkAssetAuthorityPassed: true,
        networkAssetsPassed: false,
        networkAssets: {
          expectedDrawingWorkerPaths: ["assets/drawing.worker-a1b2c3d4.js"],
          workerConstructionFaults: [],
          workerTargets: [],
        },
      };
    },
  };

  const receipt = await captureDrillBuildAuthority(
    session,
    "canary-to-legacy-snapshot",
    { requireActiveWorkers: false },
  );
  assert.equal(receipt.authoritative, true);
  assert.equal(receipt.fullBuildAuthoritative, false);
  assert.equal(receipt.assetBuildAuthoritative, true);
  assert.equal(receipt.workerLifecycle.kind, "legacy-no-drawing-worker-target");
  assert.equal(receipt.workerLifecycle.targets.length, 0);
  assert.equal(receipt.documentAuthority, "legacy");
  assert.equal(receipt.browserInstanceId, "headed-chrome:101");
  assert.equal(receipt.serverInstanceId, "managed-servers:201:202");
});

test("worker lifecycle rejects concurrent, overlapping, or unauthorized worker targets", async (t) => {
  await t.test("multiple active targets", () => {
    const result = assess([
      workerTarget({ targetId: "worker-1", attachedObservationSequence: 10 }),
      workerTarget({ targetId: "worker-2", attachedObservationSequence: 20 }),
    ]);
    assert.equal(result.accepted, false);
    assert.equal(result.serialHandoffAccepted, false);
  });

  await t.test("overlapping replacement window", () => {
    const result = assess([
      workerTarget({
        targetId: "worker-1",
        attachedObservationSequence: 10,
        detachedObservationSequence: 40,
      }),
      workerTarget({ targetId: "worker-2", attachedObservationSequence: 30 }),
    ]);
    assert.equal(result.assetAuthorityAccepted, true);
    assert.equal(result.accepted, false);
    assert.equal(result.serialHandoffAccepted, false);
  });

  await t.test("detached target without network handoff authority", () => {
    const result = assess([
      workerTarget({
        targetId: "worker-1",
        attachedObservationSequence: 10,
        detachedObservationSequence: 20,
        networkProvenanceAccepted: false,
      }),
      workerTarget({ targetId: "worker-2", attachedObservationSequence: 30 }),
    ]);
    assert.equal(result.assetAuthorityAccepted, false);
    assert.equal(result.accepted, false);
  });

  await t.test("matching malformed or missing asset digests", () => {
    for (const digest of [undefined, "sha256:not-a-digest"]) {
      const result = assess([
        workerTarget({
          targetId: "worker-1",
          attachedObservationSequence: 10,
          assetDigest: digest,
          expectedAssetDigest: digest,
        }),
      ]);
      assert.equal(result.assetAuthorityAccepted, false);
      assert.equal(result.accepted, false);
    }
  });
});

test("worker lifecycle preserves construction-fault and typed-fallback contracts", () => {
  const constructionFault = assessDrillWorkerLifecycle({
    drillId: "worker-init-failure",
    evidenceAuthoritative: true,
    constructionFaultCount: 1,
    workerTargets: [],
  });
  assert.equal(constructionFault.kind, "construction-failed-before-target");
  assert.equal(constructionFault.accepted, true);

  const detachedFallback = assessDrillWorkerLifecycle({
    drillId: "offscreen-canvas-unsupported",
    evidenceAuthoritative: false,
    constructionFaultCount: 0,
    workerTargets: [workerTarget({
      targetId: "worker-1",
      attachedObservationSequence: 10,
      detachedObservationSequence: 20,
    })],
  });
  assert.equal(detachedFallback.kind, "detached-after-typed-fallback");
  assert.equal(detachedFallback.accepted, true);
});
