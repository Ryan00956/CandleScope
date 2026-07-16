import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

test("incomplete runner writes only a fail-closed partial report for the fixed eight drills", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-rollback-runner-"));
  try {
    const result = runCli(
      ["--out-dir", temporaryRoot, "--timeout-ms", "1000"],
      { CHROME_PATH: "C:\\untrusted\\ambient-chrome.exe" },
    );
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "partial");
    assert.equal(summary.phase9RollbackDrillsPassed, false);
    assert.deepEqual(summary.failureReasons, [
      "controlled-browser-drill-producers-not-implemented",
    ]);
    const report = JSON.parse(fs.readFileSync(summary.report, "utf8"));
    assert.equal(report.schemaVersion, "drawing-rollback-controlled-run-partial/v1");
    assert.equal(report.status, "partial");
    assert.equal(report.phase9RollbackDrillsPassed, false);
    assert.equal(report.harnessPassed, false);
    assert.equal(report.planValid, true);
    assert.equal(report.drills.length, 8);
    assert.deepEqual(report.drills.map((drill) => drill.id), EXPECTED_DRILL_ORDER);
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
    assert.ok(!fs.existsSync(summary.report.replace(".partial.json", ".json")));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("controlled rollback browser CLI rejects duplicate and malformed safe options", () => {
  const duplicate = runCli(["--timeout-ms=1000", "--timeout-ms", "2000"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate option/);
  const malformed = runCli(["--timeout-ms", "0"]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /must be a positive integer/);

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
