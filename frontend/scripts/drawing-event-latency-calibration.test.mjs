import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT,
} from "./drawing-soak-metrics.mjs";
import { runDrawingEventLatencyCalibration } from "./drawing-event-latency-calibration.mjs";

const RECT = Object.freeze({ x: 20, y: 30, width: 1_000, height: 600 });
const PROVENANCE = Object.freeze({
  gitCommit: "1".repeat(40),
  buildInputFingerprint: "2".repeat(64),
  productionBuildVerification: "managed-vite-preview",
  browserProduct: "Chrome/150.0.0.0",
  userAgent: "test-agent",
  fixtureRawSha256: "3".repeat(64),
  scenarioId: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.scenarioId,
  viewport: { width: 1_440, height: 900 },
  dpr: 1.5,
  formalWindowEndedAt: "2026-07-16T00:00:00.000Z",
});

function metric({ count = 128, p50Ms = 8, p95Ms = 16, p99Ms = 24 } = {}) {
  return { count, samplesMs: Array(count).fill(p50Ms), p50Ms, p95Ms, p99Ms };
}

function parserReport({ passed = true, count = 128, p95Ms = 16, p99Ms = 24 } = {}) {
  const inputTypeNames = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "wheel",
  ];
  const frameSubmitByType = Object.fromEntries(inputTypeNames.map((inputType) => [
    inputType,
    metric({ count, p95Ms, p99Ms }),
  ]));
  const presentationByType = Object.fromEntries(inputTypeNames.map((inputType) => [
    inputType,
    metric({ count, p50Ms: 28, p95Ms: 32, p99Ms: 48 }),
  ]));
  return {
    schemaVersion: "drawing-event-latency-trace/v2",
    passed,
    failureReasons: passed ? [] : ["countMismatches"],
    expectedDispatchCounts: Object.fromEntries(
      inputTypeNames.map((inputType) => [inputType, 128]),
    ),
    eventLatency: {
      beginCount: count * 4,
      endCount: count * 4,
      pairedCount: count * 4,
      presentedPairCount: count * 4,
      terminationOnlyPairCount: 0,
      partialPresentationPairCount: 0,
    },
    frameSubmitByType,
    presentationByType,
    excluded: {
      hover: {
        frameSubmit: metric({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null }),
        presentation: metric({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null }),
      },
    },
    samples: [],
    diagnostics: {
      orphanEnds: [],
      openBegins: [],
      invalidEvents: [],
      nonMonotonicEvents: [],
      unknownTypes: [],
      countMismatches: passed ? [] : [{ inputType: "wheel", expectedCount: 128, actualCount: count }],
    },
    eventsInAnimationFrame: {
      supported: true,
      passed: true,
      reason: null,
      frameCount: count * 2,
      excludedFrameCount: 0,
      presentationByType: {
        pointerdown: presentationByType.pointerdown,
        pointerup: presentationByType.pointerup,
      },
      mismatches: [],
      schemaErrors: [],
    },
  };
}

function createMockCdp({
  closeFailure = false,
  dataLossOccurred = false,
  emitBufferUsage = true,
} = {}) {
  const handlers = new Map();
  const commands = [];
  const closedStreams = [];
  const reads = new Map();
  let attempt = 0;
  let tracingActive = false;
  const emit = (method, params) => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  return {
    commands,
    closedStreams,
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    async send(method, params = {}) {
      commands.push({ method, params, attempt, tracingActive });
      if (method === "Tracing.start") {
        attempt += 1;
        tracingActive = true;
        if (emitBufferUsage) {
          queueMicrotask(() => emit("Tracing.bufferUsage", { percentFull: 0.25 }));
        }
        return { result: {} };
      }
      if (method === "Tracing.end") {
        const stream = `trace-${attempt}`;
        tracingActive = false;
        queueMicrotask(() => emit("Tracing.tracingComplete", {
          stream,
          dataLossOccurred,
        }));
        return { result: {} };
      }
      if (method === "IO.read") {
        const readCount = reads.get(params.handle) ?? 0;
        reads.set(params.handle, readCount + 1);
        return readCount === 0
          ? { result: { data: JSON.stringify({ traceEvents: [{ name: "probe" }] }), eof: true } }
          : { result: { data: "", eof: true } };
      }
      if (method === "IO.close") {
        if (closeFailure) throw new Error("synthetic IO.close failure");
        closedStreams.push(params.handle);
        return { result: {} };
      }
      return { result: {} };
    },
  };
}

async function runWith({ cdp = createMockCdp(), parseTrace = () => parserReport() } = {}) {
  let animationFrames = 0;
  const report = await runDrawingEventLatencyCalibration({
    cdp,
    rect: RECT,
    waitForAnimationFrame: async () => { animationFrames += 1; },
    provenance: PROVENANCE,
    parseTrace,
  });
  return { cdp, report, animationFrames };
}

test("collects exactly 128 presented samples per type and closes the trace stream", async () => {
  let parserOptions = null;
  const { cdp, report, animationFrames } = await runWith({
    parseTrace: (_trace, options) => {
      parserOptions = options;
      return parserReport();
    },
  });

  assert.equal(report.schemaVersion, "drawing-event-latency-calibration/v1");
  assert.equal(report.window, "post-formal-soak");
  assert.deepEqual(report.configuration, DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration);
  assert.deepEqual(report.expectedDispatchCounts, {
    pointerdown: 128,
    pointermove: 128,
    pointerup: 128,
    wheel: 128,
  });
  assert.deepEqual(report.actualDispatchCounts, report.expectedDispatchCounts);
  assert.deepEqual(parserOptions, { expectedDispatchCounts: report.expectedDispatchCounts });
  assert.equal(report.acquisition.passed, true);
  assert.equal(report.acquisition.attemptCount, 1);
  assert.deepEqual(report.attempts.map((attempt) => Object.keys(attempt)), [[
    "attempt",
    "passed",
    "startedAt",
    "completedAt",
    "failureReason",
  ]]);
  assert.deepEqual(report.attempts.map(({ attempt, passed, failureReason }) => ({
    attempt,
    passed,
    failureReason,
  })), [{ attempt: 1, passed: true, failureReason: null }]);
  assert.equal(report.trace.chunkCount, 1);
  assert.equal(report.trace.eventCount, 1);
  assert.equal(report.trace.dataLossOccurred, false);
  assert.equal(report.trace.maxBufferUsage, 0.25);
  assert.deepEqual(cdp.closedStreams, ["trace-1"]);
  assert.equal(
    animationFrames,
    2 + 128 * 4
      * DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration.settleFramesPerInput + 1,
  );

  const inputCommands = cdp.commands.filter(({ method }) => (
    method === "Input.dispatchMouseEvent"
  ));
  assert.equal(inputCommands[0].params.type, "mouseMoved");
  assert.equal(inputCommands[0].tracingActive, false);
  const tracedInputs = inputCommands.filter(({ tracingActive }) => tracingActive);
  assert.equal(tracedInputs.length, 128 * 4);
  assert.equal(tracedInputs.filter(({ params }) => (
    params.type === "mouseMoved" && params.buttons === 0
  )).length, 0);
  assert.deepEqual(tracedInputs.slice(0, 4).map(({ params }) => params.type), [
    "mousePressed",
    "mouseMoved",
    "mouseReleased",
    "mouseWheel",
  ]);

  const tracingStart = cdp.commands.find(({ method }) => method === "Tracing.start");
  assert.equal(tracingStart.params.transferMode, "ReturnAsStream");
  assert.equal(tracingStart.params.streamFormat, "json");
  assert.equal(tracingStart.params.streamCompression, "none");
  assert.equal(tracingStart.params.traceConfig.recordMode, "recordAsMuchAsPossible");
  assert.deepEqual(
    tracingStart.params.traceConfig.includedCategories,
    DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration.categories,
  );
  assert.deepEqual(tracingStart.params.traceConfig.excludedCategories, ["*"]);
  assert.equal(cdp.commands.find(({ method }) => method === "IO.read").params.size, 1_048_576);
});

test("retries a parser count mismatch once and returns a structured schema failure", async () => {
  let calls = 0;
  const { cdp, report } = await runWith({
    parseTrace: () => {
      calls += 1;
      return parserReport({ passed: false, count: 127 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 2);
  assert.match(report.acquisition.failureReason, /^schema:/);
  assert.deepEqual(report.attempts.map(({ attempt, passed }) => ({ attempt, passed })), [
    { attempt: 1, passed: false },
    { attempt: 2, passed: false },
  ]);
  assert.deepEqual(cdp.closedStreams, ["trace-1", "trace-2"]);
});

test("returns data-loss acquisition failure after the bounded retry and closes both streams", async () => {
  const cdp = createMockCdp({ dataLossOccurred: true });
  const { report } = await runWith({ cdp });

  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 2);
  assert.match(report.acquisition.failureReason, /data loss/);
  assert.equal(report.trace, null);
  assert.equal(report.parser, null);
  assert.deepEqual(cdp.closedStreams, ["trace-1", "trace-2"]);
  assert.equal(cdp.commands.filter(({ method }) => method === "IO.read").length, 0);
});

test("does not retry a valid trace whose p95 exceeds the fixed threshold", async () => {
  let calls = 0;
  const { cdp, report } = await runWith({
    parseTrace: () => {
      calls += 1;
      return parserReport({ p95Ms: 20.01, p99Ms: 24 });
    },
  });

  assert.equal(calls, 1);
  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 1);
  assert.match(report.acquisition.failureReason, /^threshold:/);
  assert.deepEqual(report.attempts.map(({ attempt, passed }) => ({ attempt, passed })), [
    { attempt: 1, passed: false },
  ]);
  assert.deepEqual(cdp.closedStreams, ["trace-1"]);
});

test("retries an incomplete EventsInAnimationFrame cross-check only after safe cleanup", async () => {
  let calls = 0;
  const { cdp, report } = await runWith({
    parseTrace: () => {
      calls += 1;
      const parsed = parserReport();
      if (calls === 1) {
        parsed.eventsInAnimationFrame = {
          ...parsed.eventsInAnimationFrame,
          supported: false,
          passed: null,
        };
      }
      return parsed;
    },
  });

  assert.equal(calls, 2);
  assert.equal(report.acquisition.passed, true);
  assert.equal(report.acquisition.attemptCount, 2);
  assert.deepEqual(report.attempts.map(({ attempt, passed }) => ({ attempt, passed })), [
    { attempt: 1, passed: false },
    { attempt: 2, passed: true },
  ]);
  assert.deepEqual(cdp.closedStreams, ["trace-1", "trace-2"]);
});

test("fails closed when a parser response falls back to the removed v1 aliases", async () => {
  const { report } = await runWith({
    parseTrace: () => {
      const parsed = parserReport();
      parsed.excluded.hover = metric({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null });
      parsed.eventsInAnimationFrame.inputTypes =
        parsed.eventsInAnimationFrame.presentationByType;
      delete parsed.eventsInAnimationFrame.presentationByType;
      return parsed;
    },
  });

  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 2);
  assert.match(report.acquisition.failureReason, /^schema:/);
});

test("does not retry when IO.close cannot confirm cleanup", async () => {
  const cdp = createMockCdp({ closeFailure: true });
  const { report } = await runWith({ cdp });

  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 1);
  assert.match(report.acquisition.failureReason, /^cleanup: IO\.close failed:/);
  assert.deepEqual(report.attempts.map(({ attempt, passed }) => ({ attempt, passed })), [
    { attempt: 1, passed: false },
  ]);
  assert.equal(cdp.commands.filter(({ method }) => method === "Tracing.start").length, 1);
  assert.deepEqual(cdp.closedStreams, []);
});

test("fails closed when Chromium emits no trace buffer usage evidence", async () => {
  const cdp = createMockCdp({ emitBufferUsage: false });
  const { report } = await runWith({ cdp });

  assert.equal(report.acquisition.passed, false);
  assert.equal(report.acquisition.attemptCount, 2);
  assert.match(report.acquisition.failureReason, /buffer usage evidence was missing/);
  assert.equal(report.trace, null);
  assert.equal(report.parser, null);
  assert.deepEqual(cdp.closedStreams, ["trace-1", "trace-2"]);
});
