import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrillWorkerLifecycle,
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
