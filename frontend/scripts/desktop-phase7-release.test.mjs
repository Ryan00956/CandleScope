import assert from "node:assert/strict";
import test from "node:test";

import { buildDesktopPhase7ReleaseEvidence } from "./desktop-phase7-release.mjs";

const gates = {
  fourWindowsSixteenCells: "pass",
  uniqueSixtyFourCellIds: "pass",
  oneWorkspaceRevision: "pass",
  crossWindowLink: "pass",
  scenarioIdentityAccounting: "pass",
  minimizedWorkZero: "pass",
  crashLeaseCleanup: "pass",
  sameWindowIdRecovery: "pass",
  appBudgetBounded: "pass",
};

function scenario(name) {
  const subscriptions = name === "W1" ? 128 : 64;
  const series = name === "W1" ? 5 : 64;
  const crashWindowId = "window-2";
  return {
    result: "pass",
    environment: { scenario: name, displayCount: 1 },
    gates: { ...gates },
    beforeLink: Array.from({ length: 4 }, (_, index) => ({
      windowId: index === 0 ? "main-window" : `window-${index + 1}`,
      renderer: {
        chartRoots: 16,
        canvasCount: 10,
        broker: { klineStream: { open: true, physicalStreams: 1, logicalSubscribers: 16 } },
      },
    })),
    backendCapacity: {
      ok: true,
      limits: { klineBatchEnabled: true },
      klineBatch: {
        websocket_connections: 4,
        logical_clients: 64,
        logical_series: 64,
        logical_subscriptions: subscriptions,
        outbox_depth: 0,
        outbox_authoritative_timeouts: 0,
        connections: [{ item_failures: 0 }],
      },
      dataManager: {
        activeSeries: series,
        leasedSeries: series,
        streamLeases: subscriptions,
        uniqueLeaseConsumers: 64,
      },
    },
    dataReadiness: {
      windows: Array.from({ length: 4 }, (_, index) => ({
        windowId: index === 0 ? "main-window" : `window-${index + 1}`,
        readyCount: 16,
      })),
      hub: {
        entries: name === "W1" ? 4 : 64,
        bars: 256,
        counts: { publishes: 64, rejects: 0 },
      },
    },
    finalBudget: {
      workspaceBus: { participantCount: 4, counts: { conflicts: 0 } },
      appWork: {
        maxConcurrent: 16,
        maxPerWindow: 6,
        maxPreviewLanes: 4,
        counts: { rejectedPreview: 0, reclaimed: 1 },
      },
    },
    minimized: {
      activity: { previewLanePresent: false, replaceableCommitsBefore: 1, replaceableCommitsAfter: 1 },
    },
    crash: {
      windowId: crashWindowId,
      restored: {
        windowId: crashWindowId,
        renderer: {
          chartRoots: 16,
          dataReadyRoots: 16,
          canvasCount: 10,
          broker: { sharedSeries: { hydrations: 16, hydratedBars: 256 } },
          workspace: {
            ready: true,
            document: { revision: 9, windows: { [crashWindowId]: { windowState: "normal" } } },
          },
        },
      },
    },
  };
}

test("W1 and W2 exact identity ledgers produce Phase 7 release evidence", () => {
  const evidence = buildDesktopPhase7ReleaseEvidence(scenario("W1"), scenario("W2"));
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.measurements.W1.backendLogicalSubscriptions, 128);
  assert.equal(evidence.measurements.W2.backendActiveSeries, 64);
  assert.equal(evidence.measurements.W2.sharedSeries.restoredHydrations, 16);
});

test("any silent batch item failure fails the release evidence", () => {
  const w2 = scenario("W2");
  w2.backendCapacity.klineBatch.connections[0].item_failures = 1;
  const evidence = buildDesktopPhase7ReleaseEvidence(scenario("W1"), w2);
  assert.equal(evidence.result, "fail");
  assert.equal(evidence.gates.w2SixtyFourUniqueSeries, "fail");
});

test("a blank recovery that misses the shared snapshot fails closed", () => {
  const w2 = scenario("W2");
  w2.crash.restored.renderer.broker.sharedSeries.hydrations = 0;
  w2.crash.restored.renderer.dataReadyRoots = 0;
  const evidence = buildDesktopPhase7ReleaseEvidence(scenario("W1"), w2);
  assert.equal(evidence.result, "fail");
  assert.equal(evidence.gates.crashLeaseCleanupAndSameIdRecovery, "fail");
});
