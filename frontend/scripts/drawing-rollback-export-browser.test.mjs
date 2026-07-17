import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeriesRebuildExportCheckpointEvents,
  buildSeriesRebuildExportInjectionReceipt,
  SERIES_REBUILD_EXPORT_CHECKPOINT_TYPES,
  seriesRebuildProductLifecycleAccepted,
} from "./drawing-rollback-export-browser.mjs";

const EXPECTED_CHECKPOINT_TYPES = Object.freeze([
  "old-export-prepare",
  "series-rebuild-start",
  "series-rebuild-complete",
  "stale-export-pixels-fixed",
  "stale-lease-revalidate",
  "stale-lease-restored",
  "visible-export-prepare",
  "visible-export-pixels-fixed",
  "visible-lease-revalidate",
  "visible-lease-restored",
  "visible-export-encoded",
  "hidden-export-prepare",
  "hidden-export-pixels-fixed",
  "hidden-lease-revalidate",
  "hidden-lease-restored",
  "hidden-export-encoded",
  "pixel-oracle-complete",
]);

function event(type, eventSequence, fields = {}) {
  return {
    type,
    eventSequence,
    observedAt: `2026-07-17T00:00:${String(eventSequence).padStart(2, "0")}.000Z`,
    ...fields,
  };
}

function transaction({ sequence, leaseId, generation, hidden, events }) {
  return {
    transactionId: `drawing-export-${sequence}-lease-${leaseId}`,
    leaseId,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 5,
    surfaceGeneration: generation,
    sceneKind: hidden ? "hidden-frame" : "settled-exact",
    events,
  };
}

function lifecycleFixture() {
  return {
    schemaVersion: 1,
    transactionCount: 3,
    transactions: [
      transaction({
        sequence: 1,
        leaseId: 7,
        generation: 3,
        hidden: false,
        events: [
          event("lease-prepared", 1),
          event("capture-source-fixed", 4),
          event("post-capture-revalidate", 5, { valid: false }),
          event("lease-restored", 6),
        ],
      }),
      transaction({
        sequence: 2,
        leaseId: 8,
        generation: 4,
        hidden: false,
        events: [
          event("lease-prepared", 7),
          event("capture-source-fixed", 8),
          event("post-capture-revalidate", 9, { valid: true }),
          event("lease-restored", 10),
          event("image-encoded", 11),
          event("preview-published", 12),
        ],
      }),
      transaction({
        sequence: 3,
        leaseId: 9,
        generation: null,
        hidden: true,
        events: [
          event("lease-prepared", 13),
          event("capture-source-fixed", 14),
          event("post-capture-revalidate", 15, { valid: true }),
          event("lease-restored", 16),
          event("image-encoded", 17),
          event("preview-published", 18),
        ],
      }),
    ],
  };
}

test("series-rebuild export producer owns the exact 17-checkpoint contract", () => {
  assert.deepEqual([...SERIES_REBUILD_EXPORT_CHECKPOINT_TYPES], EXPECTED_CHECKPOINT_TYPES);
  assert.equal(new Set(SERIES_REBUILD_EXPORT_CHECKPOINT_TYPES).size, 17);

  const lifecycle = lifecycleFixture();
  assert.equal(seriesRebuildProductLifecycleAccepted(lifecycle), true);
  lifecycle.transactions[2].events[2].valid = false;
  assert.equal(seriesRebuildProductLifecycleAccepted(lifecycle), false);
});

test("checkpoint builder binds product events, rebuild generations, and PNG receipts", () => {
  const lifecycle = lifecycleFixture();
  const visiblePng = Object.freeze({ digest: `sha256:${"a".repeat(64)}` });
  const hiddenPng = Object.freeze({ digest: `sha256:${"b".repeat(64)}` });
  const comparison = Object.freeze({
    completedAt: "2026-07-17T00:00:19.000Z",
    algorithm: "complete-frame-drawing-bounds-v1",
  });
  const checkpoints = buildSeriesRebuildExportCheckpointEvents(
    lifecycle,
    {
      startedAt: "2026-07-17T00:00:02.000Z",
      completedAt: "2026-07-17T00:00:03.000Z",
      beforeChartType: "candlestick",
      afterChartType: "line",
      surfaceGeneration: 4,
    },
    visiblePng,
    hiddenPng,
    comparison,
  );

  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.type), EXPECTED_CHECKPOINT_TYPES);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.eventSequence), Array.from(
    { length: 17 },
    (_value, index) => index + 1,
  ));
  assert.equal(checkpoints[3].surfaceGeneration, 3);
  assert.equal(checkpoints[3].capturedSurfaceGeneration, 4);
  assert.equal(checkpoints[4].valid, false);
  assert.equal(checkpoints[8].valid, true);
  assert.strictEqual(checkpoints[10].png, visiblePng);
  assert.strictEqual(checkpoints[15].png, hiddenPng);
  assert.strictEqual(checkpoints[16].comparison, comparison);
});

test("injection builder binds controlled navigation and the exact three-attempt gate", () => {
  const tokenDigest = "a".repeat(64);
  const navigation = {
    kind: "controlled-rollback-drill-navigation",
    runId: "run-1",
    drillId: "series-rebuild-before-export",
    variant: null,
    faultId: "fault-1",
    sequence: 1,
    authorityTokenSha256: tokenDigest,
    bootstrap: {
      armed: true,
      authorityAccepted: true,
      tokenRemoved: true,
      documentInstanceId: "document-1",
    },
  };
  const controlled = {
    runId: "run-1",
    authorityTokenSha256: tokenDigest,
    documentInstanceId: "document-1",
    faultId: "fault-1",
    sequence: 1,
    observed: true,
    seriesRebuildExport: {
      checkpointCount: 3,
      pauseConsumed: true,
      releaseCount: 1,
      activeCheckpointId: null,
      checkpoints: [
        { paused: true, releaseReason: "harness-release" },
        { paused: false, releaseReason: "not-paused" },
        { paused: false, releaseReason: "not-paused" },
      ],
    },
  };

  const receipt = buildSeriesRebuildExportInjectionReceipt(navigation, controlled, true);
  assert.equal(receipt.armed, true);
  assert.equal(receipt.observed, true);
  assert.equal(receipt.buildAuthorityCurrent, true);
  assert.equal(receipt.authorityTokenSha256, `sha256:${tokenDigest}`);
  assert.equal(receipt.navigation.authorityTokenSha256, `sha256:${tokenDigest}`);
  assert.equal(receipt.gate.checkpoints.length, 3);
});
