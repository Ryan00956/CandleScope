import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessDrawingWorkerRuntimeEvidence } from "./drawing-controlled-cdp-smoke.mjs";

const FRONTEND_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(FRONTEND_ROOT, "scripts", "drawing-controlled-cdp-smoke.mjs");

function stamp(overrides = {}) {
  return {
    scopeKey: "binance:spot:BTCUSDT:1h",
    documentRevision: 4,
    surfaceGeneration: 2,
    dataRevision: 7,
    projectionRevision: 8,
    lineageIndexRevision: 3,
    viewportRevision: 9,
    themeRevision: 1,
    widthCssPx: 1200,
    heightCssPx: 700,
    dpr: 1,
    ...overrides,
  };
}

function workerIdentity(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 3,
    generation: 2,
    stamp: stamp(),
    ...overrides,
  };
}

function completedWorkerRuntime(overrides = {}) {
  const identity = workerIdentity();
  return {
    engineMode: "scene-canary",
    scenePublicationReady: true,
    attachedPrimitiveCount: 1,
    backend: "worker",
    backendSource: "environment",
    offscreenSupported: true,
    workerJobDelta: 3,
    workerResultDelta: 2,
    queueDepthCurrent: 0,
    inFlightCurrent: 0,
    stalePublishCount: 0,
    sceneFallbackCount: 0,
    sceneRuntimeFaultCount: 0,
    legacyFallbackSucceededCount: 0,
    sceneFallbackLastReason: null,
    submittedWorkerHeaders: [identity],
    latestSubmittedWorkerIdentity: identity,
    acceptedWorkerIdentity: identity,
    publishedWorkerIdentity: identity,
    lastRequestedStamp: stamp(),
    lastPublishedStamp: stamp(),
    lastPaintedStamp: stamp(),
    paintReceipt: {
      kind: "drawing-scene-bridge-paint-ack",
      observedAt: "2026-07-16T12:00:00.000Z",
      stamp: stamp(),
      attachmentRevision: 2,
      paintSequence: 5,
    },
    ...overrides,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("controlled CDP smoke help documents only its owned visible authority", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owns its production build, servers, visible browser, CDP session/);
  assert.match(result.stdout, /accepts no external server\/CDP\/transport/);
  assert.doesNotMatch(result.stdout, /--cdp-url/);
});

test("controlled CDP smoke rejects authority-bypassing and malformed inputs before lifecycle start", () => {
  for (const args of [
    ["--headless"],
    ["--cdp-url=ws://127.0.0.1:9222"],
    ["--fixture=fake.json"],
    ["--scenario-module=fake.mjs"],
    ["--artifact=fake.json"],
    ["--allow-incomplete"],
    ["--help", "--headless"],
    ["--chrome=--headless", "--help"],
    ["--timeout-ms", "999", "--help"],
    ["--timeout-ms", "600001", "--help"],
    ["--timeout-ms", "1000", "--timeout-ms", "2000", "--help"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});

test("controlled CDP smoke help validates safe boundary values without creating output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-controlled-smoke-test-"));
  const output = path.join(root, "must-not-exist");
  try {
    for (const timeout of ["1000", "600000"]) {
      const result = runCli(["--out-dir", output, "--timeout-ms", timeout, "--help"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(output), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("controlled drawing worker evidence requires a completed job-result-publish-paint identity", () => {
  const accepted = assessDrawingWorkerRuntimeEvidence(completedWorkerRuntime());
  assert.equal(accepted.passed, true, accepted.failures.join(","));

  for (const [name, runtime, expectedFailure] of [
    [
      "main-thread fallback",
      completedWorkerRuntime({ backend: "main-thread" }),
      "worker-backend-not-active",
    ],
    [
      "no worker result",
      completedWorkerRuntime({ workerResultDelta: 0 }),
      "worker-result-not-observed",
    ],
    [
      "runtime fallback",
      completedWorkerRuntime({ sceneFallbackCount: 1, sceneFallbackLastReason: "worker-fault" }),
      "scene-fallback-observed",
    ],
    [
      "accepted stale identity",
      completedWorkerRuntime({
        acceptedWorkerIdentity: workerIdentity({ jobId: 2 }),
      }),
      "accepted-worker-identity-not-latest",
    ],
    [
      "painted stale stamp",
      completedWorkerRuntime({
        lastPaintedStamp: stamp({ viewportRevision: 8 }),
      }),
      "painted-stamp-not-latest-worker-job",
    ],
    [
      "missing paint receipt",
      completedWorkerRuntime({ paintReceipt: null }),
      "paint-receipt-not-latest-worker-job",
    ],
  ]) {
    const assessment = assessDrawingWorkerRuntimeEvidence(runtime);
    assert.equal(assessment.passed, false, name);
    assert.ok(assessment.failures.includes(expectedFailure), `${name}: ${assessment.failures.join(",")}`);
  }
});
