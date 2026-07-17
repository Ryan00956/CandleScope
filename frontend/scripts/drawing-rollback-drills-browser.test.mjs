import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildInitialControlledRunReport,
  CONTROLLED_DRILL_PLAN,
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
  assert.deepEqual(report.failureReasons, []);
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
