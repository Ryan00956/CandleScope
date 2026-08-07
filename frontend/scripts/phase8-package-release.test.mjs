import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePhase8Package } from "./phase8-package-release.mjs";

function passingProcess(pid, userData) {
  const renderer = {
    chartRoots: 16,
    dataReadyRoots: 16,
    indicators: { runtimeCount: 16, definitionCount: 32, issueCount: 0 },
    broker: { klineStream: { physicalStreams: 1, logicalSubscribers: 16, activeLogicalSubscriptions: 16 } },
  };
  return {
    result: "pass",
    mode: "W3",
    environment: { packaged: true, userData },
    sidecar: { pid },
    samples: [{
      windows: Array.from({ length: 4 }, () => ({ renderer })),
      backend: {
        klineBatch: { websocket_connections: 4, logical_clients: 64, logical_subscriptions: 64 },
        dataManager: { activeSeries: 64, streamLeases: 64 },
      },
      runtimeErrors: [],
    }],
  };
}

const packageFiles = Object.fromEntries(
  ["executable", "appAsar", "backend", "pluginSdk"].map((name) => [name, { exists: true, bytes: 1 }]),
);

test("Phase 8 package requires two independent exact W3 processes", () => {
  const result = evaluatePhase8Package({
    first: passingProcess(10, "profile-a"),
    second: passingProcess(11, "profile-b"),
    packageFiles,
  });
  assert.equal(result.result, "pass");
});

test("Phase 8 package fails closed on reused profile or missing packaged resources", () => {
  const missing = structuredClone(packageFiles);
  missing.backend.exists = false;
  const result = evaluatePhase8Package({
    first: passingProcess(10, "same"),
    second: passingProcess(11, "same"),
    packageFiles: missing,
  });
  assert.equal(result.result, "fail");
  assert.equal(result.checks.independentProcesses.passed, false);
  assert.equal(result.checks.packageContents.passed, false);
});
