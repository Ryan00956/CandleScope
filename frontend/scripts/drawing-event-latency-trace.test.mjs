import assert from "node:assert/strict";
import test from "node:test";

import { parseDrawingEventLatencyTrace } from "./drawing-event-latency-trace.mjs";

const EVENT_CATEGORY = "cc,benchmark,input,input.scrolling";

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

test("keeps only the presented wheel branch and conserves expected dispatch counts", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ local: "0x20", timestampUs: 1_000, presented: false }),
    begin({ local: "0x21", timestampUs: 1_000 }),
    end({ local: "0x21", timestampUs: 21_000 }),
    end({ local: "0x20", timestampUs: 22_000 }),
  ], { expectedDispatchCounts: { wheel: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.eventLatency, {
    beginCount: 2,
    endCount: 2,
    pairedCount: 2,
    presentedPairCount: 1,
    terminationOnlyPairCount: 1,
    partialPresentationPairCount: 0,
  });
  assert.deepEqual(report.inputTypes.wheel, {
    count: 1,
    samplesMs: [20],
    p50Ms: 20,
    p95Ms: 20,
    p99Ms: 20,
  });
  assert.equal(report.eventsInAnimationFrame.supported, false);
});

test("reuses local IDs sequentially and computes nearest-rank typed percentiles", () => {
  const events = [];
  const durationsMs = [1, 2, 3, 4, 5, 100];
  for (let index = 0; index < durationsMs.length; index += 1) {
    const start = 100_000 * index;
    events.push(begin({ local: "0x20", timestampUs: start }));
    events.push(end({ local: "0x20", timestampUs: start + durationsMs[index] * 1_000 }));
  }
  const report = parseDrawingEventLatencyTrace(events, {
    expectedDispatchCounts: { wheel: durationsMs.length },
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.inputTypes.wheel.samplesMs, durationsMs);
  assert.equal(report.inputTypes.wheel.p50Ms, 3);
  assert.equal(report.inputTypes.wheel.p95Ms, 100);
  assert.equal(report.inputTypes.wheel.p99Ms, 100);
});

test("pairs nested events on one reusable local track with a LIFO stack", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ local: "0x20", timestampUs: 1_000, rawEventType: "MOUSE_WHEEL" }),
    begin({ local: "0x20", timestampUs: 2_000, rawEventType: "MOUSE_PRESSED" }),
    end({ local: "0x20", timestampUs: 5_000 }),
    end({ local: "0x20", timestampUs: 11_000 }),
  ], { expectedDispatchCounts: { wheel: 1, pointerdown: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.inputTypes.pointerdown.samplesMs, [3]);
  assert.deepEqual(report.inputTypes.wheel.samplesMs, [10]);
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
    end({ local: "0x20", timestampUs: 11_000 }),
    end({ local: "0x21", timestampUs: 22_000 }),
  ], { expectedDispatchCounts: { pointerdown: 1, pointerup: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.inputTypes.pointerdown.samplesMs, [10]);
  assert.deepEqual(report.inputTypes.pointerup.samplesMs, [20]);
});

test("excludes presented hover movement from pointermove metrics", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, rawEventType: "MOUSE_MOVED_EVENT" }),
    end({ timestampUs: 18_000 }),
  ], { expectedDispatchCounts: { pointermove: 0 } });

  assert.equal(report.passed, true);
  assert.equal(report.inputTypes.pointermove.count, 0);
  assert.deepEqual(report.excluded.hover.samplesMs, [17]);
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
  assert.deepEqual(report.eventsInAnimationFrame.inputTypes.pointerdown.samplesMs, [30]);
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
