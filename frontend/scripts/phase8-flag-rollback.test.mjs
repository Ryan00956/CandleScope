import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePhase8FlagRollback } from "./phase8-flag-rollback.mjs";

function stage(id, roots, build) {
  return {
    stage: id,
    result: "pass",
    build,
    userData: "C:/same-profile",
    windows: roots.map((chartRoots) => ({ renderer: { chartRoots } })),
    storage: {
      v6: {
        documentSha256: "sha256:v6",
        documentContentSha256: "sha256:content",
        cellCount: 64,
        windowCount: 4,
        revision: 50,
      },
      v5: { sentinelSha256: "sha256:v5", localSentinelSha256: "sha256:v5" },
    },
    runtimeErrors: [],
  };
}

function passingStages() {
  return {
    "64": stage("64", [16, 16, 16, 16], {
      multiChart16Enabled: true,
      multiWindowEnabled: true,
      multiChart64Enabled: true,
      chartWindowBrokerEnabled: true,
      klineBatchEnabled: true,
    }),
    "16": stage("16", [16], {
      multiChart16Enabled: true,
      multiWindowEnabled: false,
      multiChart64Enabled: false,
      chartWindowBrokerEnabled: true,
      klineBatchEnabled: true,
    }),
    "4": stage("4", [4], {
      multiChart16Enabled: false,
      multiWindowEnabled: false,
      multiChart64Enabled: false,
      chartWindowBrokerEnabled: false,
      klineBatchEnabled: false,
    }),
  };
}

test("Phase 8 rollback accepts exact 64 to 16 to 4 projections with unchanged storage", () => {
  assert.equal(evaluatePhase8FlagRollback(passingStages()).result, "pass");
});

test("Phase 8 rollback fails closed when a lower-capacity build rewrites v6", () => {
  const stages = passingStages();
  stages["4"].storage.v6.documentSha256 = "sha256:truncated";
  stages["4"].storage.v6.documentContentSha256 = "sha256:truncated-content";
  const result = evaluatePhase8FlagRollback(stages);
  assert.equal(result.result, "fail");
  assert.equal(result.checks.v6DocumentPreserved.passed, false);
});

test("Phase 8 rollback rejects different Chromium profiles", () => {
  const stages = passingStages();
  stages["16"].userData = "C:/new-profile";
  const result = evaluatePhase8FlagRollback(stages);
  assert.equal(result.result, "fail");
  assert.equal(result.checks.sameChromiumProfile.passed, false);
});
