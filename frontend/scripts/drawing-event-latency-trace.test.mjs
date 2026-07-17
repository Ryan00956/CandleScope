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

function stage({
  local = "0x20",
  name,
  ph,
  pid = 10,
  tid = 20,
  timestampUs,
} = {}) {
  return {
    name,
    cat: EVENT_CATEGORY,
    ph,
    ts: timestampUs,
    pid,
    tid,
    id2: { local },
    args: {},
  };
}

function handlerEvents({
  endTimestampUs,
  local = "0x20",
  pid = 10,
  startTimestampUs,
  tid = 20,
} = {}) {
  return [
    stage({
      local,
      name: "RendererMainProcessing",
      ph: "b",
      pid,
      tid,
      timestampUs: startTimestampUs,
    }),
    stage({
      local,
      name: "RendererMainProcessing",
      ph: "e",
      pid,
      tid,
      timestampUs: endTimestampUs,
    }),
  ];
}

function submitEvents({
  endTimestampUs,
  local = "0x20",
  name = COMPOSITOR_SUBMIT_STAGE,
  pid = 10,
  startTimestampUs,
  tid = 20,
} = {}) {
  return [
    stage({ local, name, ph: "b", pid, tid, timestampUs: startTimestampUs }),
    stage({ local, name, ph: "e", pid, tid, timestampUs: endTimestampUs }),
  ];
}

function terminationEvents({
  endTimestampUs,
  instant = false,
  local = "0x20",
  pid = 10,
  startTimestampUs,
  tid = 20,
} = {}) {
  if (instant) {
    return [stage({
      local,
      name: "RendererMainFinishedToTermination",
      ph: "n",
      pid,
      tid,
      timestampUs: endTimestampUs,
    })];
  }
  return [
    stage({
      local,
      name: "RendererMainFinishedToTermination",
      ph: "b",
      pid,
      tid,
      timestampUs: startTimestampUs,
    }),
    stage({
      local,
      name: "RendererMainFinishedToTermination",
      ph: "e",
      pid,
      tid,
      timestampUs: endTimestampUs,
    }),
  ];
}

function presentedEvents({
  frameSubmitTimestampUs,
  handlerEndTimestampUs,
  handlerStartTimestampUs,
  local = "0x20",
  pid = 10,
  presentationTimestampUs,
  rawEventType = "MOUSE_WHEEL",
  stageName = COMPOSITOR_SUBMIT_STAGE,
  tid = 20,
  timestampUs,
} = {}) {
  return [
    begin({ local, pid, rawEventType, tid, timestampUs }),
    ...handlerEvents({
      endTimestampUs: handlerEndTimestampUs ?? handlerStartTimestampUs + 500,
      local,
      pid,
      startTimestampUs: handlerStartTimestampUs,
      tid,
    }),
    ...submitEvents({
      endTimestampUs: presentationTimestampUs,
      local,
      name: stageName,
      pid,
      startTimestampUs: frameSubmitTimestampUs,
      tid,
    }),
    end({ local, pid, tid, timestampUs: presentationTimestampUs }),
  ];
}

function fallbackEvents({
  handlerEndTimestampUs,
  handlerStartTimestampUs,
  instantTermination = false,
  local = "0x20",
  pid = 10,
  rawEventType = "MOUSE_DRAGGED",
  terminationTimestampUs,
  tid = 20,
  timestampUs,
} = {}) {
  return [
    begin({ local, pid, presented: false, rawEventType, tid, timestampUs }),
    ...handlerEvents({
      endTimestampUs: handlerEndTimestampUs,
      local,
      pid,
      startTimestampUs: handlerStartTimestampUs,
      tid,
    }),
    ...terminationEvents({
      endTimestampUs: terminationTimestampUs,
      instant: instantTermination,
      local,
      pid,
      startTimestampUs: handlerEndTimestampUs,
      tid,
    }),
    end({ local, pid, tid, timestampUs: terminationTimestampUs }),
  ];
}

function animationFrameEvidence({
  eventType = "POINTER_DOWN_EVENT",
  flowId,
  frameEndTimestampUs,
  frameLocal,
  frameStartTimestampUs,
  generationTimestampUs,
  outcome = "presentation",
  pid = 30,
  presentationTimestampUs,
  tid = 40,
} = {}) {
  const latencyTrack = { cat: "latency", pid, tid };
  return [
    {
      ...latencyTrack,
      name: "EventCreation",
      ph: "s",
      ts: generationTimestampUs,
      id: flowId,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventCreation",
      ph: "f",
      ts: frameStartTimestampUs,
      id: flowId,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "s",
      ts: frameStartTimestampUs,
      id: flowId + 1,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "f",
      ts: presentationTimestampUs,
      id: flowId + 1,
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "b",
      ts: frameStartTimestampUs,
      id2: { local: frameLocal },
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventProcessing",
      ph: "b",
      ts: frameStartTimestampUs,
      id2: { local: frameLocal },
      args: { event_timing: { type: eventType } },
    },
    {
      ...latencyTrack,
      name: "EventProcessing",
      ph: "e",
      ts: frameStartTimestampUs + 100,
      id2: { local: frameLocal },
      args: {},
    },
    {
      ...latencyTrack,
      name: "EventsInAnimationFrame",
      ph: "e",
      ts: frameEndTimestampUs,
      id2: { local: frameLocal },
      args: {},
    },
    {
      ...latencyTrack,
      name: outcome === "presentation" ? "EventPresentation" : "EventFallbackTime",
      ph: "n",
      ts: presentationTimestampUs,
      id2: { local: frameLocal },
      args: {},
    },
  ];
}

test("groups a wheel presented chain plus duplicate termination into one dispatch", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ local: "termination", presented: false, timestampUs: 1_000 }),
    begin({ local: "presented", timestampUs: 1_000 }),
    ...handlerEvents({
      local: "presented",
      startTimestampUs: 2_000,
      endTimestampUs: 3_000,
    }),
    ...submitEvents({
      local: "presented",
      startTimestampUs: 11_000,
      endTimestampUs: 21_000,
    }),
    end({ local: "presented", timestampUs: 21_000 }),
    ...handlerEvents({
      local: "termination",
      startTimestampUs: 27_000,
      endTimestampUs: 28_000,
    }),
    ...terminationEvents({
      local: "termination",
      startTimestampUs: 28_000,
      endTimestampUs: 28_500,
    }),
    end({ local: "termination", timestampUs: 28_500 }),
  ], { expectedDispatchCounts: { wheel: 1 } });

  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, "drawing-event-latency-trace/v3");
  assert.deepEqual(report.eventLatency, {
    beginCount: 2,
    endCount: 2,
    pairedCount: 2,
    presentedPairCount: 1,
    terminationOnlyPairCount: 1,
    partialPresentationPairCount: 0,
  });
  assert.deepEqual(report.dispatchGroupsByType.wheel, {
    count: 1,
    presentedCount: 1,
    standaloneTerminationCount: 0,
    duplicateTerminationCount: 1,
  });
  assert.deepEqual(report.inputToNextPaintByType.wheel.samplesMs, [9]);
  assert.deepEqual(report.presentationByType.wheel.samplesMs, [20]);
  assert.deepEqual(report.samples, [{
    inputType: "wheel",
    rawEventType: "MOUSE_WHEEL",
    endpoint: "frame-submit",
    generationTimestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    endpointTimestampUs: 11_000,
    frameSubmitTimestampUs: 11_000,
    presentationTimestampUs: 21_000,
    generationToHandlerMs: 1,
    handlerToNextPaintMs: 9,
    frameSubmitToPresentationMs: 10,
    generationToPresentationMs: 20,
    handlerToTerminationMs: null,
    frameSubmitStageName: COMPOSITOR_SUBMIT_STAGE,
    pid: 10,
    tid: 20,
    category: EVENT_CATEGORY,
    localId: "presented",
  }]);
});

test("keeps a sole termination chain out of the formal next-paint metric", () => {
  const report = parseDrawingEventLatencyTrace(fallbackEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    terminationTimestampUs: 5_000,
  }), { expectedDispatchCounts: { pointermove: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.dispatchGroupsByType.pointermove, {
    count: 1,
    presentedCount: 0,
    standaloneTerminationCount: 1,
    duplicateTerminationCount: 0,
  });
  assert.deepEqual(report.inputToNextPaintByType.pointermove.samplesMs, []);
  assert.equal(report.presentationByType.pointermove.count, 0);
  assert.deepEqual(report.samples[0], {
    inputType: "pointermove",
    rawEventType: "MOUSE_DRAGGED",
    endpoint: "event-latency-termination",
    generationTimestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    endpointTimestampUs: 5_000,
    frameSubmitTimestampUs: null,
    presentationTimestampUs: null,
    generationToHandlerMs: 1,
    handlerToNextPaintMs: null,
    frameSubmitToPresentationMs: null,
    generationToPresentationMs: null,
    handlerToTerminationMs: 3,
    frameSubmitStageName: null,
    pid: 10,
    tid: 20,
    category: EVENT_CATEGORY,
    localId: "0x20",
  });
});

test("accepts an instant RendererMainFinishedToTermination stage", () => {
  const report = parseDrawingEventLatencyTrace(fallbackEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    terminationTimestampUs: 3_000,
    instantTermination: true,
  }), { expectedDispatchCounts: { pointermove: 1 } });

  assert.equal(report.passed, true);
  assert.deepEqual(report.inputToNextPaintByType.pointermove.samplesMs, []);
  assert.equal(report.samples[0].handlerToTerminationMs, 1);
});

test("supports both official submit stages and nearest-rank handler percentiles", () => {
  const events = [];
  const handlerDurationsMs = [1, 2, 3, 4, 5, 100];
  for (let index = 0; index < handlerDurationsMs.length; index += 1) {
    const generation = 200_000 * index;
    const handler = generation + 1_000;
    const submit = handler + handlerDurationsMs[index] * 1_000;
    events.push(...presentedEvents({
      timestampUs: generation,
      handlerStartTimestampUs: handler,
      handlerEndTimestampUs: handler + 500,
      frameSubmitTimestampUs: submit,
      presentationTimestampUs: submit + 10_000,
      stageName: index % 2 === 0 ? COMPOSITOR_SUBMIT_STAGE : DISPLAY_TREE_SUBMIT_STAGE,
    }));
  }
  const report = parseDrawingEventLatencyTrace(events, {
    expectedDispatchCounts: { wheel: handlerDurationsMs.length },
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.metricSemantics, {
    inputToNextPaintByType: {
      start: "renderer-main-processing",
      end: "next-frame-submit",
      meaning: "presented-input-to-next-paint",
    },
    presentationByType: {
      start: "input-generation",
      end: "physical-presentation",
      meaning: "input-to-physical-presentation",
    },
  });
  assert.deepEqual(report.inputToNextPaintByType.wheel.samplesMs, handlerDurationsMs);
  assert.equal(report.inputToNextPaintByType.wheel.p50Ms, 3);
  assert.equal(report.inputToNextPaintByType.wheel.p95Ms, 100);
  assert.equal(report.inputToNextPaintByType.wheel.p99Ms, 100);
  assert.equal(report.samples[1].frameSubmitStageName, DISPLAY_TREE_SUBMIT_STAGE);
});

test("excludes hover dispatches into a fail-closed evidence bucket", () => {
  const report = parseDrawingEventLatencyTrace(presentedEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    frameSubmitTimestampUs: 8_000,
    presentationTimestampUs: 18_000,
    rawEventType: "MOUSE_MOVED_EVENT",
  }), { expectedDispatchCounts: { pointermove: 0 } });

  assert.equal(report.passed, true);
  assert.equal(report.samples.length, 0);
  assert.equal(report.inputToNextPaintByType.pointermove.count, 0);
  assert.deepEqual(report.excluded.hover, {
    dispatchGroups: {
      count: 1,
      presentedCount: 1,
      standaloneTerminationCount: 0,
      duplicateTerminationCount: 0,
    },
    inputToNextPaint: {
      count: 1,
      samplesMs: [6],
      p50Ms: 6,
      p95Ms: 6,
      p99Ms: 6,
    },
    presentation: {
      count: 1,
      samplesMs: [17],
      p50Ms: 17,
      p95Ms: 17,
      p99Ms: 17,
    },
  });
});

test("fails two presented endpoints but permits duplicate termination for any known type", () => {
  const duplicatePresented = parseDrawingEventLatencyTrace([
    ...presentedEvents({
      local: "a",
      timestampUs: 1_000,
      handlerStartTimestampUs: 2_000,
      frameSubmitTimestampUs: 4_000,
      presentationTimestampUs: 8_000,
    }),
    ...presentedEvents({
      local: "b",
      timestampUs: 1_000,
      handlerStartTimestampUs: 2_500,
      frameSubmitTimestampUs: 5_000,
      presentationTimestampUs: 9_000,
    }),
  ], { expectedDispatchCounts: { wheel: 1 } });
  const nonWheelDuplicate = parseDrawingEventLatencyTrace([
    ...presentedEvents({
      local: "a",
      timestampUs: 1_000,
      handlerStartTimestampUs: 2_000,
      frameSubmitTimestampUs: 4_000,
      presentationTimestampUs: 8_000,
      rawEventType: "MOUSE_DRAGGED",
    }),
    ...fallbackEvents({
      local: "b",
      timestampUs: 1_000,
      handlerStartTimestampUs: 3_000,
      handlerEndTimestampUs: 4_000,
      terminationTimestampUs: 5_000,
      rawEventType: "MOUSE_DRAGGED",
    }),
  ], { expectedDispatchCounts: { pointermove: 1 } });

  assert.equal(duplicatePresented.passed, false);
  assert.match(duplicatePresented.failureReasons.join(","), /dispatchGroupMismatches/);
  assert.equal(nonWheelDuplicate.passed, true);
  assert.equal(nonWheelDuplicate.dispatchGroupsByType.pointermove.count, 1);
  assert.equal(nonWheelDuplicate.dispatchGroupsByType.pointermove.presentedCount, 1);
  assert.equal(nonWheelDuplicate.dispatchGroupsByType.pointermove.duplicateTerminationCount, 1);
  assert.deepEqual(nonWheelDuplicate.inputToNextPaintByType.pointermove.samplesMs, [2]);
});

test("fails closed on missing or multiple handler and endpoint stages", () => {
  const missingHandler = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    ...submitEvents({ startTimestampUs: 4_000, endTimestampUs: 8_000 }),
    end({ timestampUs: 8_000 }),
  ]);
  const multipleSubmit = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000 }),
    ...handlerEvents({ startTimestampUs: 2_000, endTimestampUs: 3_000 }),
    ...submitEvents({ startTimestampUs: 4_000, endTimestampUs: 6_000 }),
    ...submitEvents({
      name: DISPLAY_TREE_SUBMIT_STAGE,
      startTimestampUs: 6_500,
      endTimestampUs: 8_000,
    }),
    end({ timestampUs: 8_000 }),
  ]);
  const missingTermination = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, presented: false }),
    ...handlerEvents({ startTimestampUs: 2_000, endTimestampUs: 3_000 }),
    end({ timestampUs: 4_000 }),
  ]);

  assert.equal(missingHandler.passed, false);
  assert.equal(missingHandler.diagnostics.handlerStageCardinalityMismatches.length, 1);
  assert.equal(multipleSubmit.passed, false);
  assert.equal(multipleSubmit.diagnostics.submitStageCardinalityMismatches[0].actualCount, 2);
  assert.equal(missingTermination.passed, false);
  assert.equal(missingTermination.diagnostics.terminationStageCardinalityMismatches[0].actualCount, 0);
});

test("fails closed when termination does not end at EventLatency termination", () => {
  const report = parseDrawingEventLatencyTrace([
    begin({ timestampUs: 1_000, presented: false }),
    ...handlerEvents({ startTimestampUs: 2_000, endTimestampUs: 3_000 }),
    ...terminationEvents({ startTimestampUs: 3_000, endTimestampUs: 4_000 }),
    end({ timestampUs: 5_000 }),
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.terminationStageEndpointMismatches.length, 1);
});

test("fails closed on orphan, open, unnested, or nonmonotonic stages", () => {
  const report = parseDrawingEventLatencyTrace([
    stage({ name: "RendererMainProcessing", ph: "e", timestampUs: 1_000 }),
    stage({ name: "RendererMainProcessing", ph: "b", timestampUs: 2_000 }),
    stage({ name: COMPOSITOR_SUBMIT_STAGE, ph: "b", timestampUs: 5_000 }),
    stage({ name: COMPOSITOR_SUBMIT_STAGE, ph: "e", timestampUs: 4_000 }),
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.orphanHandlerStageEnds.length, 1);
  assert.equal(report.diagnostics.openHandlerStageBegins.length, 1);
  assert.equal(report.diagnostics.unnestedHandlerStages.length, 1);
  assert.equal(report.diagnostics.unnestedSubmitStages.length, 2);
  assert.equal(report.diagnostics.nonMonotonicSubmitStages.length, 2);
});

test("scopes generation groups by pid and never uses precision-losing latency IDs", () => {
  const firstId = JSON.parse("9007199254740992");
  const secondId = JSON.parse("9007199254740993");
  assert.equal(firstId, secondId, "fixture must reproduce JSON number precision collision");
  const first = presentedEvents({
    local: "a",
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    frameSubmitTimestampUs: 4_000,
    presentationTimestampUs: 8_000,
    rawEventType: "MOUSE_DRAGGED",
  });
  first[0].args.event_latency.event_latency_id = firstId;
  const second = presentedEvents({
    local: "a",
    pid: 11,
    tid: 21,
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_500,
    frameSubmitTimestampUs: 5_000,
    presentationTimestampUs: 9_000,
    rawEventType: "MOUSE_DRAGGED",
  });
  second[0].args.event_latency.event_latency_id = secondId;
  const report = parseDrawingEventLatencyTrace([...first, ...second], {
    expectedDispatchCounts: { pointermove: 2 },
  });

  assert.equal(report.passed, true);
  assert.equal(report.dispatchGroupsByType.pointermove.count, 2);
});

test("cross-checks full discrete EIAF counts and accepts EventLatency as a multiset subset", () => {
  const report = parseDrawingEventLatencyTrace([
    ...presentedEvents({
      timestampUs: 1_000,
      handlerStartTimestampUs: 2_000,
      handlerEndTimestampUs: 3_000,
      frameSubmitTimestampUs: 10_000,
      presentationTimestampUs: 31_000,
      rawEventType: "MOUSE_PRESSED",
    }),
    ...fallbackEvents({
      local: "0x21",
      timestampUs: 50_000,
      handlerStartTimestampUs: 52_000,
      handlerEndTimestampUs: 53_000,
      terminationTimestampUs: 55_000,
      rawEventType: "MOUSE_PRESSED",
    }),
    ...animationFrameEvidence({
      flowId: 100,
      frameLocal: "frame-a",
      generationTimestampUs: 1_000,
      frameStartTimestampUs: 3_000,
      frameEndTimestampUs: 10_000,
      presentationTimestampUs: 31_000,
    }),
    ...animationFrameEvidence({
      flowId: 200,
      frameLocal: "frame-b",
      generationTimestampUs: 50_000,
      frameStartTimestampUs: 53_000,
      frameEndTimestampUs: 60_000,
      presentationTimestampUs: 90_000,
      outcome: "fallback",
    }),
  ], { expectedDispatchCounts: { pointerdown: 2 } });

  assert.equal(report.passed, true);
  assert.equal(report.eventsInAnimationFrame.supported, true);
  assert.equal(report.eventsInAnimationFrame.passed, true);
  assert.deepEqual(report.presentationByType.pointerdown.samplesMs, [30]);
  assert.deepEqual(
    report.eventsInAnimationFrame.presentationByType.pointerdown.samplesMs,
    [30],
  );
  assert.deepEqual(report.eventsInAnimationFrame.fallbackByType.pointerdown.samplesMs, [40]);
  assert.deepEqual(report.eventsInAnimationFrame.samples.map((sample) => sample.outcome), [
    "presentation",
    "fallback",
  ]);
});

test("fails EIAF closed on exact count or physical-presentation subset mismatch", () => {
  const primary = presentedEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    frameSubmitTimestampUs: 10_000,
    presentationTimestampUs: 31_000,
    rawEventType: "MOUSE_RELEASED",
  });
  const countMismatch = parseDrawingEventLatencyTrace([
    ...primary,
    ...fallbackEvents({
      local: "0x21",
      timestampUs: 50_000,
      handlerStartTimestampUs: 52_000,
      handlerEndTimestampUs: 53_000,
      terminationTimestampUs: 55_000,
      rawEventType: "MOUSE_RELEASED",
    }),
    ...animationFrameEvidence({
      eventType: "POINTER_UP_EVENT",
      flowId: 100,
      frameLocal: "frame-a",
      generationTimestampUs: 1_000,
      frameStartTimestampUs: 3_000,
      frameEndTimestampUs: 10_000,
      presentationTimestampUs: 31_000,
    }),
  ], { expectedDispatchCounts: { pointerup: 2 } });
  const subsetMismatch = parseDrawingEventLatencyTrace([
    ...primary,
    ...animationFrameEvidence({
      eventType: "POINTER_UP_EVENT",
      flowId: 200,
      frameLocal: "frame-b",
      generationTimestampUs: 1_000,
      frameStartTimestampUs: 3_000,
      frameEndTimestampUs: 10_000,
      presentationTimestampUs: 32_000,
    }),
  ], { expectedDispatchCounts: { pointerup: 1 } });

  assert.equal(countMismatch.passed, false);
  assert.equal(
    countMismatch.eventsInAnimationFrame.mismatches[0].reason,
    "animation-frame-outcome-count-mismatch",
  );
  assert.equal(subsetMismatch.passed, false);
  assert.equal(
    subsetMismatch.eventsInAnimationFrame.mismatches[0].reason,
    "event-latency-presentations-not-animation-frame-multiset-subset",
  );
});

test("fails EIAF closed when one flow endpoint has both presentation and fallback", () => {
  const eiaf = animationFrameEvidence({
    flowId: 300,
    frameLocal: "frame-c",
    generationTimestampUs: 1_000,
    frameStartTimestampUs: 3_000,
    frameEndTimestampUs: 10_000,
    presentationTimestampUs: 31_000,
  });
  eiaf.push({
    cat: "latency",
    name: "EventFallbackTime",
    ph: "n",
    ts: 31_000,
    pid: 30,
    tid: 40,
    id2: { local: "frame-c" },
    args: {},
  });
  const report = parseDrawingEventLatencyTrace([
    ...fallbackEvents({
      timestampUs: 1_000,
      handlerStartTimestampUs: 2_000,
      handlerEndTimestampUs: 3_000,
      terminationTimestampUs: 5_000,
      rawEventType: "MOUSE_PRESSED",
    }),
    ...eiaf,
  ], { expectedDispatchCounts: { pointerdown: 1 } });

  assert.equal(report.passed, false);
  assert.equal(
    report.eventsInAnimationFrame.schemaErrors.some((entry) => (
      entry.reason === "animation-frame-endpoint-instant-cardinality"
        && entry.actualCount === 2
    )),
    true,
  );
});

test("fails EIAF closed when its outcome precedes the frame end or changes thread", () => {
  const primary = fallbackEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    terminationTimestampUs: 5_000,
    rawEventType: "MOUSE_PRESSED",
  });
  const earlyOutcome = parseDrawingEventLatencyTrace([
    ...primary,
    ...animationFrameEvidence({
      flowId: 400,
      frameLocal: "frame-early-outcome",
      generationTimestampUs: 1_000,
      frameStartTimestampUs: 3_000,
      frameEndTimestampUs: 32_000,
      presentationTimestampUs: 31_000,
      outcome: "fallback",
    }),
  ], { expectedDispatchCounts: { pointerdown: 1 } });
  const foreignThreadEvidence = animationFrameEvidence({
    flowId: 500,
    frameLocal: "frame-foreign-thread",
    generationTimestampUs: 1_000,
    frameStartTimestampUs: 3_000,
    frameEndTimestampUs: 10_000,
    presentationTimestampUs: 31_000,
    outcome: "fallback",
  });
  foreignThreadEvidence.find((event) => (
    event.name === "EventsInAnimationFrame" && event.ph === "f"
  )).tid += 1;
  const foreignThread = parseDrawingEventLatencyTrace([
    ...primary,
    ...foreignThreadEvidence,
  ], { expectedDispatchCounts: { pointerdown: 1 } });

  assert.equal(earlyOutcome.passed, false);
  assert.equal(
    earlyOutcome.eventsInAnimationFrame.schemaErrors.some((entry) => (
      entry.reason === "animation-frame-endpoint-precedes-frame-end"
    )),
    true,
  );
  assert.equal(foreignThread.passed, false);
  assert.equal(
    foreignThread.eventsInAnimationFrame.schemaErrors.some((entry) => (
      entry.reason === "animation-frame-endpoint-flow-thread-mismatch"
    )),
    true,
  );
});

test("requires EIAF schema when discrete pointer dispatches are expected", () => {
  const report = parseDrawingEventLatencyTrace(fallbackEvents({
    timestampUs: 1_000,
    handlerStartTimestampUs: 2_000,
    handlerEndTimestampUs: 3_000,
    terminationTimestampUs: 5_000,
    rawEventType: "MOUSE_PRESSED",
  }), { expectedDispatchCounts: { pointerdown: 1 } });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureReasons, ["eventsInAnimationFrameSchemaInvalid"]);
  assert.equal(
    report.eventsInAnimationFrame.schemaErrors[0].reason,
    "required-animation-frame-schema-missing",
  );
});

test("exposes an incomplete EventsInAnimationFrame schema as fail-closed", () => {
  const report = parseDrawingEventLatencyTrace([{
    cat: "latency",
    name: "EventsInAnimationFrame",
    ph: "s",
    ts: 1_000,
    id: 1,
    pid: 30,
    tid: 40,
    args: {},
  }, {
    cat: "latency",
    name: "EventsInAnimationFrame",
    ph: "f",
    ts: 2_000,
    id: 1,
    pid: 30,
    tid: 40,
    args: {},
  }]);

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureReasons, ["eventsInAnimationFrameSchemaInvalid"]);
  assert.equal(report.eventsInAnimationFrame.supported, false);
  assert.match(report.eventsInAnimationFrame.reason, /incomplete|ambiguous/i);
});

test("fails closed on invalid integer timestamps, unknown types, and count mismatch", () => {
  const fractional = begin({ timestampUs: 1_000.5 });
  const unknown = begin({
    local: "unknown",
    timestampUs: 2_000,
    rawEventType: "GESTURE_FUTURE_EVENT",
  });
  const report = parseDrawingEventLatencyTrace([
    fractional,
    unknown,
    end({ local: "unknown", timestampUs: 3_000 }),
  ], { expectedDispatchCounts: { wheel: 1 } });

  assert.equal(report.passed, false);
  assert.equal(report.diagnostics.invalidEvents.length > 0, true);
  assert.equal(report.diagnostics.unknownTypes.length, 1);
  assert.deepEqual(report.diagnostics.countMismatches, [{
    inputType: "wheel",
    expectedCount: 1,
    actualCount: 0,
  }]);
  assert.equal(
    report.diagnostics.dispatchGroupMismatches.some((entry) => (
      entry.reason === "presented-pair-to-dispatch-group-conservation"
    )),
    true,
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
