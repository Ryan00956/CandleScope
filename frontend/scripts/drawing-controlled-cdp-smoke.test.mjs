import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assessDrawingWorkerRuntimeEvidence,
  waitForDrawingExerciseSurface,
} from "./drawing-controlled-cdp-smoke.mjs";
import {
  exchangePayload,
  indicatorRangeBatchPayload,
  websocketConnectedPayload,
} from "./mock-api.mjs";

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

test("controlled mock schema v2 advertises usable kline history and realtime intervals", () => {
  const exchange = exchangePayload().exchanges[0];
  const kline = exchange.channels.find((channel) => channel.channel === "kline");

  assert.ok(kline);
  assert.equal(exchange.capability_schema_version, 2);
  assert.deepEqual(kline.market_types, ["spot", "futures"]);
  assert.equal(kline.history, true);
  assert.equal(kline.realtime, true);
  assert.deepEqual(kline.history_transports, ["rest_history"]);
  assert.deepEqual(kline.realtime_transports, ["websocket"]);
  assert.deepEqual(kline.params.interval, exchange.native_intervals);
});

test("controlled mock advertises the product WebSocket protocol for each routed stream", () => {
  assert.deepEqual(
    websocketConnectedPayload("/api/v1/stream/market"),
    { type: "connected", protocol: "market.v1", max_subscriptions: 64 },
  );
  assert.deepEqual(
    websocketConnectedPayload("/api/v1/stream/order-book"),
    { type: "connected", protocol: "orderbook.v1" },
  );
  assert.deepEqual(
    websocketConnectedPayload("/api/v1/stream/full-order-book"),
    { type: "connected", protocol: "orderbook.full.v1" },
  );
  assert.deepEqual(
    websocketConnectedPayload("/api/v1/stream/trade-flow"),
    { type: "connected", protocol: "tradeflow.v1" },
  );
  assert.deepEqual(
    websocketConnectedPayload("/api/v1/stream/klines?symbol=BTCUSDT"),
    { type: "connected" },
  );
});

test("controlled mock returns a parseable payload for hosted indicator range batches", () => {
  const response = indicatorRangeBatchPayload({
    requests: [
      {
        clientId: "vol",
        kind: "builtin",
        name: "VOL",
        start: 1,
        end: Number.MAX_SAFE_INTEGER,
        reason: "window-prepend",
      },
      {
        clientId: "ma",
        kind: "builtin",
        name: "MA",
        params: { period: 20 },
        start: 1,
        end: Number.MAX_SAFE_INTEGER,
        reason: "initial-visible",
      },
    ],
  });

  assert.equal(response.schemaVersion, 1);
  assert.equal(response.ok, true);
  assert.equal(response.type, "indicator.range_batch");
  assert.deepEqual(response.results.map((result) => result.clientId), ["vol", "ma"]);
  for (const result of response.results) {
    const { payload } = result;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, "indicator.replace_range");
    assert.equal(payload.clientId, result.clientId);
    assert.ok(payload.range.start > 1);
    assert.ok(payload.range.end < Number.MAX_SAFE_INTEGER);
    assert.ok(payload.lines[0].data.length > 0);
    assert.ok(payload.lines[0].data.every(
      (point) => point.time >= payload.range.start && point.time <= payload.range.end,
    ));
  }

  const fullMa = response.results[1].payload;
  const narrowStart = fullMa.lines[0].data.at(-3).time;
  const narrow = indicatorRangeBatchPayload({
    requests: [{
      clientId: "ma",
      kind: "builtin",
      name: "MA",
      params: { period: 20 },
      start: narrowStart,
      end: fullMa.range.end,
      reason: "window-prepend",
    }],
  }).results[0].payload;
  assert.deepEqual(
    narrow.lines[0].data,
    fullMa.lines[0].data.filter((point) => point.time >= narrowStart),
  );
});

test("controlled drawing surface wait tolerates React readiness lag", async () => {
  let currentTime = 0;
  let attempts = 0;
  const states = [
    { ready: false, buttonFound: true, chartFound: false, errorText: null, rect: null },
    {
      ready: false,
      buttonFound: true,
      buttonDisabled: true,
      chartFound: true,
      errorText: null,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      ready: true,
      buttonFound: true,
      buttonDisabled: false,
      chartFound: true,
      errorText: null,
      rect: { x: 40, y: 80, width: 1200, height: 700 },
    },
  ];

  const ready = await waitForDrawingExerciseSurface(
    async () => states[Math.min(attempts++, states.length - 1)],
    {
      timeoutMs: 100,
      pollMs: 10,
      now: () => currentTime,
      waitForInterval: async (delayMs) => { currentTime += delayMs; },
    },
  );

  assert.equal(ready.attempts, 3);
  assert.equal(ready.waitedMs, 20);
  assert.equal(ready.rect.width, 1200);
});

test("controlled drawing surface wait reports the product error instead of hiding it as timing", async () => {
  await assert.rejects(
    waitForDrawingExerciseSurface(
      async () => ({
        ready: false,
        buttonFound: true,
        chartFound: false,
        errorText: "Data load failed: no kline capability",
        rect: null,
      }),
      { timeoutMs: 100 },
    ),
    /chart entered an error state.*no kline capability/,
  );
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
