import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPhase1Comparison,
  buildPhase3Comparison,
  drawingWheelConfiguration,
  drawingWorkerBackpressureConfiguration,
  parseArgs,
  runWheel,
  withDrawingPerformanceHostDeadline,
} from "./drawing-performance.mjs";

test("parses the wheel cadence default, zero, and explicit integer values", () => {
  assert.equal(parseArgs([]).wheelIntervalMs, 24);
  assert.equal(parseArgs(["--wheel-interval-ms", "0"]).wheelIntervalMs, 0);
  assert.equal(parseArgs(["--wheel-interval-ms", "80"]).wheelIntervalMs, 80);

  for (const value of ["-1", "1.5", "Infinity", "not-a-number"]) {
    assert.throws(
      () => parseArgs(["--wheel-interval-ms", value]),
      /--wheel-interval-ms must be an integer >= 0/,
    );
  }
});

test("records wheel cadence in the report configuration payload", () => {
  const args = parseArgs([
    "--wheel-events",
    "12",
    "--wheel-interval-ms",
    "80",
  ]);

  assert.deepEqual(drawingWheelConfiguration(args), {
    wheelEvents: 12,
    wheelIntervalMs: 80,
  });
});

test("worker backpressure cadence opens quiet windows while outrunning delivery", () => {
  const configuration = drawingWorkerBackpressureConfiguration();
  assert.equal(configuration.performanceContractVersion, 1);
  assert.ok(configuration.cadenceMs > configuration.exactViewportSettleDelayMs);
  assert.ok(configuration.workerDelayMs >= configuration.cadenceMs * 3);
  assert.ok(configuration.wheelEvents >= 64);
});

test("host wall-clock deadlines bound a stalled browser operation", async () => {
  assert.equal(await withDrawingPerformanceHostDeadline(
    async () => "complete",
    50,
    "test operation",
  ), "complete");

  await assert.rejects(
    withDrawingPerformanceHostDeadline(
      () => new Promise(() => {}),
      5,
      "stalled browser operation",
    ),
    /stalled browser operation exceeded the 5ms host wall-clock deadline/,
  );
});

test("runWheel applies the configured cadence and skips delay at zero", async () => {
  const events = [];
  const delays = [];
  const cdp = {
    async send(method, payload) {
      events.push({ method, payload });
    },
  };
  const rect = { x: 10, y: 20, width: 100, height: 80 };

  assert.equal(await runWheel(
    cdp,
    rect,
    3,
    80,
    async (delayMs) => delays.push(delayMs),
  ), 3);
  assert.deepEqual(delays, [80, 80, 80]);
  assert.deepEqual(events.map(({ payload }) => payload.deltaY), [-92, 92, -92]);

  let zeroDelayCalls = 0;
  await runWheel(cdp, rect, 2, 0, async () => {
    zeroDelayCalls += 1;
  });
  assert.equal(zeroDelayCalls, 0);
});

test("before/after comparisons require the same wheel cadence", (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "drawing-performance-cli-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const baselinePath = path.join(temporaryDirectory, "before.json");
  const before = {
    configuration: {
      seed: 7,
      wheelEvents: 60,
      wheelIntervalMs: 24,
    },
    context: {},
    environment: {},
    scenarios: [],
  };
  fs.writeFileSync(baselinePath, JSON.stringify(before), "utf8");

  const matching = structuredClone(before);
  const mismatched = structuredClone(before);
  mismatched.configuration.wheelIntervalMs = 80;

  const phase1Matching = buildPhase1Comparison(matching, baselinePath);
  const phase1Mismatched = buildPhase1Comparison(mismatched, baselinePath);
  assert.equal(phase1Matching.contextChecks.wheelIntervalMs, true);
  assert.equal(phase1Matching.comparable, true);
  assert.equal(phase1Mismatched.contextChecks.wheelIntervalMs, false);
  assert.equal(phase1Mismatched.comparable, false);

  const phase3Matching = buildPhase3Comparison(matching, baselinePath);
  const phase3Mismatched = buildPhase3Comparison(mismatched, baselinePath);
  assert.equal(phase3Matching.contextChecks.wheelIntervalMs, true);
  assert.equal(phase3Mismatched.contextChecks.wheelIntervalMs, false);
});
