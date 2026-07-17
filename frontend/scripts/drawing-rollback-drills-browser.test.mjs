import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildInitialControlledRunReport,
  canaryRetirementAuthorityPassed,
  CONTROLLED_DRILL_PLAN,
  CONTROLLED_PRODUCER_ORDER,
  controlledRunAuthorityPassed,
  controlledRunCliSummary,
  crossBuildDrillAuthorityPassed,
  dprDrillBuildAuthorityPassed,
  lifecycleDrillBuildAuthorityPassed,
  parseArgs,
  storageDrillBuildAuthorityPassed,
  workerDrillBuildAuthorityPassed,
} from "./drawing-rollback-drills-browser.mjs";

const FRONTEND_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(FRONTEND_ROOT, "scripts", "drawing-rollback-drills-browser.mjs");
const EXPECTED_DRILL_ORDER = Object.freeze([
  "worker-init-failure",
  "offscreen-canvas-unsupported",
  "indexeddb-quota-blocked",
  "worker-stale-generation",
  "active-gesture-chart-boundary",
  "series-rebuild-before-export",
  "continuous-dpr-resize",
  "canary-to-legacy-snapshot",
]);
const IMPLEMENTED_WORKER_DRILLS = Object.freeze([
  "worker-init-failure",
  "offscreen-canvas-unsupported",
  "worker-stale-generation",
]);
const IMPLEMENTED_STORAGE_DRILLS = Object.freeze(["indexeddb-quota-blocked"]);
const IMPLEMENTED_LIFECYCLE_DRILLS = Object.freeze([
  "active-gesture-chart-boundary",
  "series-rebuild-before-export",
]);

function fixtureRawDigest(character) {
  return character.repeat(64);
}

function fixtureDigest(character) {
  return `sha256:${fixtureRawDigest(character)}`;
}

function fixtureBuildReceipt() {
  return {
    buildId: "controlled-build-1",
    buildFingerprint: { sha256: fixtureRawDigest("a") },
    assetFingerprint: { sha256: fixtureRawDigest("b") },
    inputFingerprint: { sha256: fixtureRawDigest("c") },
    git: { commit: "0123456789abcdef" },
  };
}

function fixtureInitialBuildAuthority(drillId, buildReceipt = fixtureBuildReceipt()) {
  return {
    kind: "controlled-browser-build-authority",
    drillId,
    authoritative: true,
    assetBuildAuthoritative: true,
    buildId: buildReceipt.buildId,
    buildFingerprint: fixtureDigest("a"),
    assetDigest: fixtureDigest("b"),
    currentAssetDigest: fixtureDigest("b"),
    buildInputDigest: fixtureDigest("c"),
    currentBuildInputDigest: fixtureDigest("c"),
    gitRevision: buildReceipt.git.commit,
    matchesManagedOrigin: true,
    matchesManagedDocument: true,
    entryAssetsLoaded: true,
    networkAssetAuthorityPassed: true,
    networkQuiescencePassed: true,
    browserLoadedAssetsAccepted: true,
    domLoadedAssetsAccepted: true,
    expectedEntriesPresentInDom: true,
    distMatchesBuild: true,
    buildInputsMatch: true,
    gitMatchesBuild: true,
    managedOriginGuardPassed: true,
    workerDiagnosticsPassed: true,
    handlerSettlementsPassed: true,
    workerLifecycle: { accepted: true, assetAuthorityAccepted: true },
  };
}

function fixtureCrossBuildResult() {
  const origin = "http://127.0.0.1:15173";
  const profileId = "controlled-profile:phase9";
  const inputDigest = fixtureDigest("c");
  const phase = ({
    buildId,
    fingerprint,
    asset,
    documentAuthority,
    engineMode,
    interactionSurfaceMode,
    rasterBackend,
    browserInstanceId,
    serverInstanceId,
  }) => {
    const build = {
      buildId,
      buildFingerprint: fixtureDigest(fingerprint),
      assetDigest: fixtureDigest(asset),
      buildInputDigest: inputDigest,
      gitRevision: "0123456789abcdef",
      origin,
      profileId,
      browserInstanceId,
      serverInstanceId,
      documentAuthority,
      engineMode,
      interactionSurfaceMode,
      rasterBackend,
    };
    const authority = {
      kind: "controlled-browser-build-authority",
      drillId: "canary-to-legacy-snapshot",
      authoritative: true,
      assetBuildAuthoritative: true,
      capturedAt: "2026-07-17T08:00:00.000Z",
      ...build,
      currentAssetDigest: build.assetDigest,
      currentBuildInputDigest: build.buildInputDigest,
      managedOrigin: origin,
      observedOrigin: origin,
    };
    return { build, authority };
  };
  const canary = phase({
    buildId: "canary-build",
    fingerprint: "d",
    asset: "e",
    documentAuthority: "document",
    engineMode: "scene-canary",
    interactionSurfaceMode: "overlay",
    rasterBackend: "worker",
    browserInstanceId: "browser-canary",
    serverInstanceId: "server-canary",
  });
  const legacy = phase({
    buildId: "legacy-build",
    fingerprint: "f",
    asset: "0",
    documentAuthority: "legacy",
    engineMode: "legacy",
    interactionSurfaceMode: "legacy",
    rasterBackend: "main-thread",
    browserInstanceId: "browser-legacy",
    serverInstanceId: "server-legacy",
  });
  return {
    drills: [{
      drillId: "canary-to-legacy-snapshot",
      builds: { canary: canary.build, legacy: legacy.build },
      buildAuthority: {
        ...legacy.authority,
        pairKind: "controlled-canary-to-legacy-build-authority",
        crossBuild: {
          kind: "controlled-cross-build-authority",
          authoritative: true,
          canary: canary.authority,
          legacy: legacy.authority,
          profile: {
            kind: "controlled-shared-browser-profile",
            retainedAcrossRestart: true,
            profileId,
          },
          origin: {
            kind: "controlled-cross-build-same-origin-authority",
            sameOriginStorageRetained: true,
            managedOrigin: origin,
          },
          browserRestartReceiptId: "browser-restart",
          serverRestartReceiptId: "server-restart",
          writeReceiptId: "write-receipt",
          readReceiptId: "read-receipt",
        },
      },
    }],
    transition: { canaryRetirement: { complete: true } },
  };
}

function runCli(args, environment = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true,
  });
}

test("controlled rollback browser CLI exposes only owned headed-run inputs", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /starts its own production servers, visible browser, and CDP session/);
  assert.match(result.stdout, /never accepts external artifacts/);
  assert.doesNotMatch(result.stdout, /--artifact <drill-id>/);
});

test("controlled rollback browser CLI rejects every authority-bypassing option", () => {
  const forbidden = [
    "--allow-incomplete",
    "--artifact=worker-init-failure=fake.json",
    "--cdp-url=ws://127.0.0.1:9222",
    "--fake-transport=fake.mjs",
    "--fixture=fake.json",
    "--headless",
    "--phase6-report=fake.json",
    "--scenario-module=fake.mjs",
  ];
  for (const argument of forbidden) {
    const result = runCli([argument]);
    assert.equal(result.status, 1, argument);
    assert.match(result.stderr, /is forbidden for the controlled browser authority/, argument);
  }
});

test("initial controlled report is fail closed for the fixed eight-drill authority", () => {
  const args = parseArgs(["--out-dir", "controlled-output", "--timeout-ms", "1000"]);
  const report = buildInitialControlledRunReport(args, {
    runId: "phase9-pure-test",
    startedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(report.schemaVersion, "drawing-rollback-controlled-run-partial/v2");
  assert.equal(report.status, "partial");
  assert.equal(report.phase9RollbackDrillsPassed, false);
  assert.equal(report.harnessPassed, false);
  assert.equal(report.workerHarnessPassed, false);
  assert.equal(report.storageHarnessPassed, false);
  assert.equal(report.lifecycleHarnessPassed, false);
  assert.equal(report.dprHarnessPassed, false);
  assert.equal(report.crossBuildHarnessPassed, false);
  assert.equal(report.planValid, true);
  assert.equal(report.drills.length, 8);
  assert.deepEqual(report.drills.map((drill) => drill.id), EXPECTED_DRILL_ORDER);
  assert.deepEqual(CONTROLLED_DRILL_PLAN.map((drill) => drill.id), EXPECTED_DRILL_ORDER);
  assert.equal(new Set(report.drills.map((drill) => drill.id)).size, 8);
  assert.ok(report.drills.every((drill) => (
    drill.status === "not-run"
      && drill.contractPassed === false
      && drill.trustedRunnerAccepted === false
  )));
  assert.equal(report.configuration.externalArtifactsAccepted, false);
  assert.equal(report.configuration.externalCdpAccepted, false);
  assert.equal(report.configuration.allowIncomplete, false);
  assert.equal(report.configuration.chromePathConfigured, false);
  assert.equal(report.lifecycle.runClosed, false);
  assert.equal(report.lifecycle.canaryRetirementComplete, false);
  assert.deepEqual(report.failureReasons, []);
});

test("controlled producer order runs DPR after export and cross-build last", () => {
  assert.deepEqual(CONTROLLED_PRODUCER_ORDER, [
    "worker",
    "storage",
    "lifecycle",
    "export",
    "dpr",
    "cross-build",
  ]);
  assert.deepEqual(CONTROLLED_DRILL_PLAN.map(({ id, producer }) => [id, producer]), [
    ["worker-init-failure", "worker"],
    ["offscreen-canvas-unsupported", "worker"],
    ["indexeddb-quota-blocked", "storage"],
    ["worker-stale-generation", "worker"],
    ["active-gesture-chart-boundary", "lifecycle"],
    ["series-rebuild-before-export", "export"],
    ["continuous-dpr-resize", "dpr"],
    ["canary-to-legacy-snapshot", "cross-build"],
  ]);
});

test("controlled CLI summary exposes DPR, cross-build, and retirement authority", () => {
  const report = buildInitialControlledRunReport(parseArgs([]), {
    runId: "phase9-summary-test",
    startedAt: "2026-07-17T00:00:00.000Z",
  });
  const summary = controlledRunCliSummary({ reportPath: "controlled-run.json", report });
  assert.equal(summary.report, "controlled-run.json");
  assert.equal(summary.dprHarnessPassed, false);
  assert.equal(summary.crossBuildHarnessPassed, false);
  assert.equal(summary.canaryRetirementComplete, false);
  assert.equal(summary.runAuthorityPassed, false);
  assert.equal(summary.phase9RollbackDrillsPassed, false);
});

test("run authority requires exact current build receipts from every worker drill", () => {
  const rawDigest = (character) => character.repeat(64);
  const digest = (character) => `sha256:${rawDigest(character)}`;
  const buildReceipt = {
    buildId: "controlled-build-1",
    buildFingerprint: { sha256: rawDigest("a") },
    assetFingerprint: { sha256: rawDigest("b") },
    inputFingerprint: { sha256: rawDigest("c") },
    git: { commit: "0123456789abcdef" },
  };
  const workerResult = {
    drills: IMPLEMENTED_WORKER_DRILLS.map((drillId) => {
      const offscreen = drillId === "offscreen-canvas-unsupported";
      return {
        drillId,
        buildAuthority: {
          kind: "controlled-browser-build-authority",
          drillId,
          authoritative: true,
          fullBuildAuthoritative: !offscreen,
          assetBuildAuthoritative: true,
          buildId: buildReceipt.buildId,
          buildFingerprint: digest("a"),
          assetDigest: digest("b"),
          currentAssetDigest: digest("b"),
          buildInputDigest: digest("c"),
          currentBuildInputDigest: digest("c"),
          gitRevision: buildReceipt.git.commit,
          matchesManagedOrigin: true,
          matchesManagedDocument: true,
          entryAssetsLoaded: true,
          networkAssetsPassed: !offscreen,
          networkAssetAuthorityPassed: true,
          networkQuiescencePassed: true,
          browserLoadedAssetsAccepted: true,
          domLoadedAssetsAccepted: true,
          expectedEntriesPresentInDom: true,
          distMatchesBuild: true,
          buildInputsMatch: true,
          gitMatchesBuild: true,
          managedOriginGuardPassed: true,
          workerDiagnosticsPassed: true,
          handlerSettlementsPassed: true,
          workerLifecycle: {
            accepted: true,
            assetAuthorityAccepted: true,
          },
        },
      };
    }),
  };
  assert.equal(workerDrillBuildAuthorityPassed(workerResult, buildReceipt), true);

  workerResult.drills[1].buildAuthority.currentAssetDigest = digest("d");
  assert.equal(workerDrillBuildAuthorityPassed(workerResult, buildReceipt), false);
  workerResult.drills[1].buildAuthority.currentAssetDigest = digest("b");
  workerResult.drills[2].drillId = "worker-init-failure";
  assert.equal(workerDrillBuildAuthorityPassed(workerResult, buildReceipt), false);
  workerResult.drills[2].drillId = "worker-stale-generation";
  workerResult.drills.pop();
  assert.equal(workerDrillBuildAuthorityPassed(workerResult, buildReceipt), false);
});

test("run authority independently requires the current storage drill build receipt", () => {
  const rawDigest = (character) => character.repeat(64);
  const digest = (character) => `sha256:${rawDigest(character)}`;
  const buildReceipt = {
    buildId: "controlled-build-1",
    buildFingerprint: { sha256: rawDigest("a") },
    assetFingerprint: { sha256: rawDigest("b") },
    inputFingerprint: { sha256: rawDigest("c") },
    git: { commit: "0123456789abcdef" },
  };
  const storageResult = {
    drills: IMPLEMENTED_STORAGE_DRILLS.map((drillId) => ({
      drillId,
      buildAuthority: {
        kind: "controlled-browser-build-authority",
        drillId,
        authoritative: true,
        assetBuildAuthoritative: true,
        buildId: buildReceipt.buildId,
        buildFingerprint: digest("a"),
        assetDigest: digest("b"),
        currentAssetDigest: digest("b"),
        buildInputDigest: digest("c"),
        currentBuildInputDigest: digest("c"),
        gitRevision: buildReceipt.git.commit,
        matchesManagedOrigin: true,
        matchesManagedDocument: true,
        entryAssetsLoaded: true,
        networkAssetAuthorityPassed: true,
        networkQuiescencePassed: true,
        browserLoadedAssetsAccepted: true,
        domLoadedAssetsAccepted: true,
        expectedEntriesPresentInDom: true,
        distMatchesBuild: true,
        buildInputsMatch: true,
        gitMatchesBuild: true,
        managedOriginGuardPassed: true,
        workerDiagnosticsPassed: true,
        handlerSettlementsPassed: true,
        workerLifecycle: {
          accepted: true,
          assetAuthorityAccepted: true,
        },
      },
    })),
  };
  assert.equal(storageDrillBuildAuthorityPassed(storageResult, buildReceipt), true);
  storageResult.drills[0].buildAuthority.currentBuildInputDigest = digest("d");
  assert.equal(storageDrillBuildAuthorityPassed(storageResult, buildReceipt), false);
  storageResult.drills[0].buildAuthority.currentBuildInputDigest = digest("c");
  storageResult.drills[0].drillId = "worker-stale-generation";
  assert.equal(storageDrillBuildAuthorityPassed(storageResult, buildReceipt), false);
});

test("run authority independently requires the current lifecycle drill build receipt", () => {
  const rawDigest = (character) => character.repeat(64);
  const digest = (character) => `sha256:${rawDigest(character)}`;
  const buildReceipt = {
    buildId: "controlled-build-1",
    buildFingerprint: { sha256: rawDigest("a") },
    assetFingerprint: { sha256: rawDigest("b") },
    inputFingerprint: { sha256: rawDigest("c") },
    git: { commit: "0123456789abcdef" },
  };
  const lifecycleResult = {
    drills: IMPLEMENTED_LIFECYCLE_DRILLS.map((drillId) => ({
      drillId,
      buildAuthority: {
        kind: "controlled-browser-build-authority",
        drillId,
        authoritative: true,
        assetBuildAuthoritative: true,
        buildId: buildReceipt.buildId,
        buildFingerprint: digest("a"),
        assetDigest: digest("b"),
        currentAssetDigest: digest("b"),
        buildInputDigest: digest("c"),
        currentBuildInputDigest: digest("c"),
        gitRevision: buildReceipt.git.commit,
        matchesManagedOrigin: true,
        matchesManagedDocument: true,
        entryAssetsLoaded: true,
        networkAssetAuthorityPassed: true,
        networkQuiescencePassed: true,
        browserLoadedAssetsAccepted: true,
        domLoadedAssetsAccepted: true,
        expectedEntriesPresentInDom: true,
        distMatchesBuild: true,
        buildInputsMatch: true,
        gitMatchesBuild: true,
        managedOriginGuardPassed: true,
        workerDiagnosticsPassed: true,
        handlerSettlementsPassed: true,
        workerLifecycle: { accepted: true, assetAuthorityAccepted: true },
      },
    })),
  };
  assert.equal(lifecycleDrillBuildAuthorityPassed(lifecycleResult, buildReceipt), true);
  lifecycleResult.drills[0].buildAuthority.currentAssetDigest = digest("d");
  assert.equal(lifecycleDrillBuildAuthorityPassed(lifecycleResult, buildReceipt), false);
  lifecycleResult.drills[0].buildAuthority.currentAssetDigest = digest("b");
  lifecycleResult.drills[0].drillId = "series-rebuild-before-export";
  assert.equal(lifecycleDrillBuildAuthorityPassed(lifecycleResult, buildReceipt), false);
  lifecycleResult.drills[0].drillId = "active-gesture-chart-boundary";
  lifecycleResult.drills.pop();
  assert.equal(lifecycleDrillBuildAuthorityPassed(lifecycleResult, buildReceipt), false);
});

test("the DPR drill remains bound to the initial canary build receipt", () => {
  const buildReceipt = fixtureBuildReceipt();
  const dprResult = {
    drills: [{
      drillId: "continuous-dpr-resize",
      buildAuthority: fixtureInitialBuildAuthority("continuous-dpr-resize", buildReceipt),
    }],
  };
  assert.equal(dprDrillBuildAuthorityPassed(dprResult, buildReceipt), true);

  dprResult.drills[0].buildAuthority.buildId = "legacy-build";
  assert.equal(dprDrillBuildAuthorityPassed(dprResult, buildReceipt), false);
  dprResult.drills[0].buildAuthority.buildId = buildReceipt.buildId;
  dprResult.drills.push(structuredClone(dprResult.drills[0]));
  assert.equal(dprDrillBuildAuthorityPassed(dprResult, buildReceipt), false);
});

test("cross-build authority is independent from the initial receipt and binds both builds", () => {
  const valid = fixtureCrossBuildResult();
  assert.equal(crossBuildDrillAuthorityPassed(valid), true);
  assert.equal(canaryRetirementAuthorityPassed(valid), true);

  const finalAuthorityDrift = fixtureCrossBuildResult();
  finalAuthorityDrift.drills[0].buildAuthority.buildId = "canary-build";
  assert.equal(crossBuildDrillAuthorityPassed(finalAuthorityDrift), false);

  const canaryConfigurationDrift = fixtureCrossBuildResult();
  canaryConfigurationDrift.drills[0].buildAuthority.crossBuild.canary.rasterBackend = "main-thread";
  assert.equal(crossBuildDrillAuthorityPassed(canaryConfigurationDrift), false);

  const sharedInputDrift = fixtureCrossBuildResult();
  sharedInputDrift.drills[0].builds.legacy.buildInputDigest = fixtureDigest("1");
  assert.equal(crossBuildDrillAuthorityPassed(sharedInputDrift), false);

  const incompleteRetirement = fixtureCrossBuildResult();
  incompleteRetirement.transition.canaryRetirement.complete = false;
  assert.equal(canaryRetirementAuthorityPassed(incompleteRetirement), false);
  assert.equal(crossBuildDrillAuthorityPassed(incompleteRetirement), true);
});

test("run authority fails closed when canary retirement is incomplete", () => {
  const passing = {
    executionSucceeded: true,
    initialBuildAuthoritative: true,
    initialCanaryBuildAuthorityPassed: true,
    crossBuildAuthorityPassed: true,
    crossBuildContractPassed: true,
    canaryRetirementComplete: true,
    producerOrderPassed: true,
    authoritativeStatePresent: true,
    liveDiagnosticsPassed: true,
    finalDiagnosticsPassed: true,
    cleanupComplete: true,
  };
  assert.equal(controlledRunAuthorityPassed(passing), true);
  for (const field of Object.keys(passing)) {
    assert.equal(
      controlledRunAuthorityPassed({ ...passing, [field]: false }),
      false,
      field,
    );
  }
});

test("controlled rollback browser CLI rejects duplicate and malformed safe options", () => {
  const duplicate = runCli(["--timeout-ms=1000", "--timeout-ms", "2000"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate option/);
  const malformed = runCli(["--timeout-ms", "0"]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /must be an integer between 1000 and 600000/);

  for (const swallowedAuthorityOption of [
    ["--chrome", "--headless", "--help"],
    ["--out-dir", "--artifact=fake.json", "--help"],
    ["--chrome=--headless", "--help"],
    ["--out-dir=--artifact=fake.json", "--help"],
  ]) {
    const result = runCli(swallowedAuthorityOption);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a value/);
    assert.equal(result.stdout, "");
  }
});
