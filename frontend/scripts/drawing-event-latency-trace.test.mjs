import assert from "node:assert/strict";
import test from "node:test";

import { parseDrawingEventLatencyTrace } from "./drawing-event-latency-trace.mjs";

const EVENT_CATEGORY = "cc,benchmark,input,input.scrolling";
const COMPOSITOR_SUBMIT_STAGE = "SubmitCompositorFrameToPresentationCompositorFrame";
const DISPLAY_TREE_SUBMIT_STAGE = "SubmitUpdateDisplayTreeToPresentationCompositorFrame";

function begin({
  local = "0x20",
  pid = 10,
  presented = true,
  rawEventType = "MOUSE_WHEEL",
  tid = 20,
  timestampUs,
  eventLatencyId = 9_007_199_254_740_992,
} = {}) {
  return {
    name: "EventLatency",
    cat: EVENT_CATEGORY,
    ph: "b",
    ts: timestampUs,
    pid,
    tid,
    id2: { local },
    args: {
      event_latency: {
        event_latency_id: eventLatencyId,
        event_type: rawEventType,
        has_high_latency: false,
        ...(presented ? {
          display_trace_id: -7_791_227_938_003_813_000,
          surface_frame_trace_id: -7_791_227_938_003_813_000,
          vsync_interval_ms: 16.666,
        } : {}),
      },
    },
  };
}

function end({ local = "0x20", pid = 10, tid = 20, timestampUs } = {}) {
  return {
    name: "EventLatency",
    cat: EVENT_CATEGORY,
    ph: "e",
    ts: timestampUs,
    pid,
    tid,
    id2: { local },
    args: {},
  };
}

function submitBegin({
  local = "0x20",
  name = COMPOSITOR_SUBMIT_STAGE,
  pid = 10,
  tid = 20,
  timestampUs,
} = {}) {
  return {
    name,
    cat: EVENT_CATEGORY,
    ph: "b",
    ts: timestampUs,
    pid,
    tid,
    id2: { local },
    args: {},
  };
}

function submitEnd({
  local = "0x20",
  name = COMPOSITOR_SUBMIT_STAGE,
  pid = 10,
  tid = 20,
  timestampUs,
} = {}) {
  return {
    name,
    cat: EVENT_CATEGORY,
    ph: "e",
    ts: timestampUs,
    pid,
    tid,
    id2: { local },
    args: {},
  };
}

function presentedEvents({
  frameSubmitTimestampUs,
  local = "0x20",
  presentationTimestampUs,
  rawEventType = "MOUSE_WHEEL",
  stageName = COMPOSITOR_SUBMIT_STAGE,
  timestampUs,
} = {}) {
  return [
    begin({ local, rawEventType, timestampUs }),
    submitBegin({ local, name: stageName, timestampUs: frameSubmitTimestampUs }),
    submitEnd({ local, name: stageName, timestampUs: presentationTimestampUs }),
    end({ local, timestampUs: presentationTimestampUs }),
  ];
}

test("keeps only the presented wheel branch and conserves expected dispatch counts", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ local: "0x20", timestampUs: 1_000, presented: false }),
    begin({ local: "0x21", timestampUs: 1_000 }),
    submitBegin({ local: "0x21", timestampUs: 11_000 }),
    submitEnd({ local: "0x21", timestampUs: 21_000 }),
    end({ local: "0x21", timestampUs: 21_000 }),
    end({ local: "0x20", timestampUs: 22_000 }),
  ], { expectedDispatchCounts: { wheel: 1 } });

  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, "drawing-event-latency-trace/v2");
  assert.deepEqual(report.eventLatency, {
    beginCount: 2,
    endCount: 2,
    pairedCount: 2,
    presentedPairCount: 1,
    terminationOnlyPairCount: 1,
    partialPresentationPairCount: 0,
  });
  assert.deepEqual(report.frameSubmitByType.wheel, {
    count: 1,
    samplesMs: [10],
    p50Ms: 10,
    p95Ms: 10,
    p99Ms: 10,
  });
  assert.deepEqual(report.presentationByType.wheel, {
    count: 1,
    samplesMs: [20],
    p50Ms: 20,
    p95Ms: 20,
    p99Ms: 20,
  });
  assert.equal(Object.hasOwn(report, "inputTypes"), false);
  assert.deepEqual(report.samples[0], {
    inputType: "wheel",
    rawEventType: "MOUSE_WHEEL",
    generationTimestampUs: 1_000,
    frameSubmitTimestampUs: 11_000,
    frameSubmitStageEndTimestampUs: 21_000,
    presentationTimestampUs: 21_000,
    generationToFrameSubmitMs: 10,
    frameSubmitToPresentationMs: 10,
    generationToPresentationMs: 20,
    frameSubmitStageName: COMPOSITOR_SUBMIT_STAGE,
    pid: 10,
    tid: 20,
    category: EVENT_CATEGORY,
    localId: "0x21",
  });
  assert.equal(report.eventsInAnimationFrame.supported, false);
});

test("reuses local IDs sequentially and computes nearest-rank typed percentiles", () => {
  const events = [];
  const durationsMs = [1, 2, 3, 4, 5, 100];
  for (let index = 0; index < durationsMs.length; index += 1) {
    const start = 100_000 * index;
    const presentation = start + durationsMs[index] * 1_000;
    events.push(...presentedEvents({
      local: "0x20",
      timestampUs: start,
      frameSubmitTimestampUs: start + Math.floor((durationsMs[index] * 1_000) / 2),
      presentationTimestampUs: presentation,
    }));
  }
  const report = parseDrawingEventLatencyTrace(events, {
    expectedDispatchCounts: { wheel: durationsMs.length },
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.presentationByType.wheel.samplesMs, durationsMs);
  assert.equal(report.presentationByType.wheel.p50Ms, 3);
  assert.equal(report.presentationByType.wheel.p95Ms, 100);
  assert.equal(report.presentationByType.wheel.p99Ms, 100);
});

test("pairs nested events on one reusable local track with a LIFO stack", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ local: "0x20", timestampUs: 1_000, rawEventType: "MOUSE_WHEEL" }),
    begin({ local: "0x20", timestampUs: 2_000, rawEventType: "MOUSE_PRESSED" }),
    submitBegin({ local: "0x20", timestampUs: 3_000 }),
    submitEnd({ local: "0x20", timestampUs: 5_000 }),
    end({ local: "0x20", timestampUs: 5_000 }),
    submitBegin({ local: "0x20", timestampUs: 6_000 }),
    submitEnd({ local: "0x20", timestampUs: 11_000 }),
    end({ local: "0x20", timestampUs: 11_000 }),
  ], { expectedDispatchCounts: { wheel: 1, pointerdown: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.presentationByType.pointerdown.samplesMs, [3]);
  assert.deepEqual(report.presentationByType.wheel.samplesMs, [10]);
});

test("never correlates on precision-colliding int64 event_latency_id values", () => {
  const firstId = JSON.parse("9007199254740992");
  const secondId = JSON.parse("9007199254740993");
  assert.equal(firstId, secondId, "fixture must reproduce JSON number precision collision");
  const report = parseDrawingEventLatencyTrace([
    begin({
      local: "0x20",
      timestampUs: 1_000,
      rawEventType: "MOUSE_PRESSED",
      eventLatencyId: firstId,
    }),
    begin({
      local: "0x21",
      timestampUs: 2_000,
      rawEventType: "MOUSE_RELEASED",
      eventLatencyId: secondId,
    }),
    submitBegin({ local: "0x20", timestampUs: 5_000 }),
    submitEnd({ local: "0x20", timestampUs: 11_000 }),
    end({ local: "0x20", timestampUs: 11_000 }),
    submitBegin({ local: "0x21", timestampUs: 12_000 }),
    submitEnd({ local: "0x21", timestampUs: 22_000 }),
    end({ local: "0x21", timestampUs: 22_000 }),
  ], { expectedDispatchCounts: { pointerdown: 1, pointerup: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.presentationByType.pointerdown.samplesMs, [10]);
  assert.deepEqual(report.presentationByType.pointerup.samplesMs, [20]);
});

test("excludes presented hover movement from pointermove metrics", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, rawEventType: "MOUSE_MOVED_EVENT" }),
    submitBegin({ timestampUs: 8_000 }),
    submitEnd({ timestampUs: 18_000 }),
    end({ timestampUs: 18_000 }),
  ], { expectedDispatchCounts: { pointermove: 0 } });

  assert.equal(report.passed, true);
  assert.equal(report.presentationByType.pointermove.count, 0);
  assert.deepEqual(report.excluded.hover.frameSubmit.samplesMs, [7]);
  assert.deepEqual(report.excluded.hover.presentation.samplesMs, [17]);
});

test("supports both official submit stages and preserves exact three-segment accounting", () => {
  const report = parseDrawingEventLatencyTrace(presentedEvents({
    timestampUs: 1_000,
    frameSubmitTimestampUs: 2_333,
    presentationTimestampUs: 4_777,
    stageName: DISPLAY_TREE_SUBMIT_STAGE,
  }), { expectedDispatchCounts: { wheel: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.metricSemantics, {
    frameSubmitByType: {
      start: "input-generation",
      end: "next-frame-submit",
      meaning: "documented-input-to-next-paint",
    },
    presentationByType: {
      start: "input-generation",
      end: "physical-presentation",
      meaning: "input-to-physical-presentation",
    },
  });
  const [sample] = report.samples;
  assert.equal(sample.frameSubmitStageName, DISPLAY_TREE_SUBMIT_STAGE);
  assert.equal(sample.generationToFrameSubmitMs, 1.333);
  assert.equal(sample.frameSubmitToPresentationMs, 2.444);
  assert.equal(
    sample.generationToPresentationMs,
    sample.generationToFrameSubmitMs + sample.frameSubmitToPresentationMs,
  );
  assert.deepEqual(report.frameSubmitByType.wheel.samplesMs, [1.333]);
  assert.deepEqual(report.presentationByType.wheel.samplesMs, [sample.generationToPresentationMs]);
});

test("fails closed when a presented track has no submit stage or multiple submit stages", () => {
  const missing = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    end({ timestampUs: 10_000 }),
  ]);
  const multiple = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    submitBegin({ timestampUs: 2_000 }),
    submitEnd({ timestampUs: 5_000 }),
    submitBegin({ name: DISPLAY_TREE_SUBMIT_STAGE, timestampUs: 6_000 }),
    submitEnd({ name: DISPLAY_TREE_SUBMIT_STAGE, timestampUs: 10_000 }),
    end({ timestampUs: 10_000 }),
  ]);

  assert.equal(missing.passed, false);
  assert.equal(missing.diagnostics.submitStageCardinalityMismatches[0].actualCount, 0);
  assert.equal(multiple.passed, false);
  assert.equal(multiple.diagnostics.submitStageCardinalityMismatches[0].actualCount, 2);
  assert.equal(multiple.presentationByType.wheel.count, 0);
});

test("fails closed on orphan, open, and non-nested submit stages", () => {
  const report = parseDrawingEventLatencyTrace([
    submitEnd({ local: "orphan", timestampUs: 1_000 }),
    submitBegin({ local: "open", timestampUs: 2_000 }),
    submitBegin({ local: "detached", timestampUs: 3_000 }),
    submitEnd({ local: "detached", timestampUs: 4_000 }),
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.orphanSubmitStageEnds.length, 1);
  assert.equal(report.diagnostics.openSubmitStageBegins.length, 1);
  assert.equal(report.diagnostics.unnestedSubmitStages.length, 3);
});

test("fails closed on regressed, mismatched, and presentation-misaligned submit stages", () => {
  const regressed = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    submitBegin({ timestampUs: 5_000 }),
    submitEnd({ timestampUs: 4_000 }),
    end({ timestampUs: 10_000 }),
  ]);
  const mismatchedName = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    submitBegin({ timestampUs: 5_000 }),
    submitEnd({ name: DISPLAY_TREE_SUBMIT_STAGE, timestampUs: 10_000 }),
    end({ timestampUs: 10_000 }),
  ]);
  const presentationMismatch = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    submitBegin({ timestampUs: 5_000 }),
    submitEnd({ timestampUs: 9_000 }),
    end({ timestampUs: 10_000 }),
  ]);

  assert.equal(regressed.passed, false);
  assert.equal(regressed.diagnostics.nonMonotonicSubmitStages.length, 2);
  assert.equal(mismatchedName.passed, false);
  assert.equal(mismatchedName.diagnostics.invalidSubmitStages[0].reason, "submit-stage-name-mismatch");
  assert.equal(presentationMismatch.passed, false);
  assert.equal(presentationMismatch.diagnostics.submitStagePresentationMismatches.length, 1);
});

test("never turns a termination-only chain into a frame-submit sample", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, presented: false }),
    submitBegin({ timestampUs: 5_000 }),
    submitEnd({ timestampUs: 10_000 }),
    end({ timestampUs: 10_000 }),
  ], { expectedDispatchCounts: { wheel: 0 } });

  assert.equal(report.passed, false);
  assert.equal(report.eventLatency.terminationOnlyPairCount, 1);
  assert.equal(report.frameSubmitByType.wheel.count, 0);
  assert.equal(report.presentationByType.wheel.count, 0);
  assert.equal(
    report.diagnostics.invalidSubmitStages.at(-1).reason,
    "termination-only-event-latency-has-submit-stage",
  );
});

test("fails closed on orphan ends, open begins, nonmonotonic tracks, and count mismatch", () => {
  const report = parseDrawingEventLatencyTrace([
    end({ local: "orphan", timestampUs: 1_000 }),
    begin({ local: "open", timestampUs: 3_000 }),
    begin({ local: "backwards", timestampUs: 10_000 }),
    end({ local: "backwards", timestampUs: 9_000 }),
  ], { expectedDispatchCounts: { wheel: 3 } });

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.orphanEnds.length, 1);
  assert.equal(report.diagnostics.openBegins.length, 1);
  assert.equal(report.diagnostics.nonMonotonicEvents.length, 2);
  assert.deepEqual(report.diagnostics.countMismatches, [{
    inputType: "wheel",
    expectedCount: 3,
    actualCount: 0,
  }]);
});

test("fails closed on unknown event types and partial presentation identifiers", () => {
  const unknown = begin({ timestampUs: 1_000, rawEventType: "GESTURE_FUTURE_EVENT" });
  const partial = begin({ local: "0x21", timestampUs: 2_000 });
  delete partial.args.event_latency.surface_frame_trace_id;
  const report = parseDrawingEventLatencyTrace([
    unknown,
    submitBegin({ timestampUs: 5_000 }),
    submitEnd({ timestampUs: 10_000 }),
    end({ timestampUs: 10_000 }),
    partial,
    end({ local: "0x21", timestampUs: 12_000 }),
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.unknownTypes.length, 1);
  assert.equal(report.diagnostics.invalidEvents.length, 1);
  assert.equal(report.eventLatency.presentedPairCount, 1);
  assert.equal(report.eventLatency.partialPresentationPairCount, 1);
});

test("cross-checks discrete pointer generation-to-presentation through EventsInAnimationFrame flows", () => {
  const latencyTrack = { cat: "latency", pid: 30, tid: 40 };
  const report = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, rawEventType: "MOUSE_PRESSED" }),
    submitBegin({ timestampUs: 10_000 }),
    submitEnd({ timestampUs: 31_000 }),
    end({ timestampUs: 31_000 }),
    { ...latencyTrack, name: "EventCreation", ph: "s", ts: 1_000, id: 100, args: {} },
    { ...latencyTrack, name: "EventCreation", ph: "f", ts: 3_000, id: 100, args: {} },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "s",
      ts: 3_000,
      id: 101,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "f",
      ts: 31_000,
      id: 101,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "b",
      ts: 3_000,
      id2: { local: "0x5b" },
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventProcessing",
      ph: "b",
      ts: 3_000,
      id2: { local: "0x5b" },
      args: { event_timing: { type: "POINTER_DOWN_EVENT" } },
    },
    {
      ...latencyTrack,
      name: "EventProcessing",
      ph: "e",
      ts: 4_000,
      id2: { local: "0x5b" },
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "e",
      ts: 10_000,
      id2: { local: "0x5b" },
      args: {},
    },
  ], { expectedDispatchCounts: { pointerdown: 1 } });

  assert.equal(report.passed, true);
  assert.equal(report.eventsInAnimationFrame.supported, true);
  assert.equal(report.eventsInAnimationFrame.passed, true);
  assert.deepEqual(report.frameSubmitByType.pointerdown.samplesMs, [9]);
  assert.deepEqual(report.presentationByType.pointerdown.samplesMs, [30]);
  assert.deepEqual(
    report.eventsInAnimationFrame.presentationByType.pointerdown.samplesMs,
    [30],
  );
  assert.equal(Object.hasOwn(report.eventsInAnimationFrame, "inputTypes"), false);
});

test("exposes an incomplete EventsInAnimationFrame schema as unsupported", () => {
  const report = parseDrawingEventLatencyTrace([
    {
      cat: "latency",
      name: "EventsInAnimationFrame",
      ph: "s",
      ts: 1_000,
      id: 1,
      pid: 30,
      tid: 40,
      args: {},
    },
    {
      cat: "latency",
      name: "EventsInAnimationFrame",
      ph: "f",
      ts: 2_000,
      id: 1,
      pid: 30,
      tid: 40,
      args: {},
    },
  ]);

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureReasons, ["eventsInAnimationFrameSchemaInvalid"]);
  assert.equal(report.eventsInAnimationFrame.supported, false);
  assert.match(report.eventsInAnimationFrame.reason, /incomplete|ambiguous/i);
  assert.deepEqual(
    report.eventsInAnimationFrame.schemaErrors.map((entry) => entry.reason),
    ["animation-frame-slices-missing"],
  );
});

test("validates parser inputs and expected dispatch count contracts", () => {
  assert.throws(() => parseDrawingEventLatencyTrace({}), /traceEvents/);
  assert.throws(
    () => parseDrawingEventLatencyTrace([], { expectedDispatchCounts: { hover: 1 } }),
    /unknown expected/,
  );
  assert.throws(
    () => parseDrawingEventLatencyTrace([], { expectedDispatchCounts: { wheel: -1 } }),
    /non-negative/,
  );
});
