const EVENT_LATENCY_NAME = "EventLatency";
const EVENTS_IN_ANIMATION_FRAME_NAME = "EventsInAnimationFrame";
const LATENCY_CATEGORY = "latency";

export const DRAWING_EVENT_LATENCY_INPUT_TYPES = Object.freeze([
  "pointerdown",
  "pointermove",
  "pointerup",
  "wheel",
]);

const RAW_EVENT_TYPE_CLASSIFICATION = Object.freeze({
  MOUSE_WHEEL: Object.freeze({ kind: "typed", inputType: "wheel" }),
  MOUSE_DRAGGED: Object.freeze({ kind: "typed", inputType: "pointermove" }),
  MOUSE_PRESSED: Object.freeze({ kind: "typed", inputType: "pointerdown" }),
  MOUSE_RELEASED: Object.freeze({ kind: "typed", inputType: "pointerup" }),
  MOUSE_MOVED_EVENT: Object.freeze({ kind: "excluded", reason: "hover" }),
});

const DOM_DISCRETE_EVENT_TYPES = Object.freeze({
  POINTER_DOWN_EVENT: "pointerdown",
  POINTER_UP_EVENT: "pointerup",
});

function categoryIncludes(category, expected) {
  return typeof category === "string"
    && category.split(",").some((entry) => entry.trim() === expected);
}

function traceEventsFrom(trace) {
  if (Array.isArray(trace)) return trace;
  if (trace !== null && typeof trace === "object" && Array.isArray(trace.traceEvents)) {
    return trace.traceEvents;
  }
  throw new TypeError("drawing event latency trace must be an event array or traceEvents object");
}

function normalizeExpectedDispatchCounts(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected drawing trace dispatch counts must be an object");
  }
  const allowed = new Set(DRAWING_EVENT_LATENCY_INPUT_TYPES);
  const normalized = {};
  for (const [inputType, count] of Object.entries(value)) {
    if (!allowed.has(inputType)) {
      throw new TypeError(`unknown expected drawing trace input type: ${inputType}`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`expected drawing trace ${inputType} count must be non-negative`);
    }
    normalized[inputType] = count;
  }
  return Object.freeze(normalized);
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validProcessOrThreadId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function eventLatencyTrackKey(event) {
  if (!validProcessOrThreadId(event?.pid)
    || typeof event?.cat !== "string"
    || event.cat.length === 0
    || typeof event?.id2?.local !== "string"
    || event.id2.local.length === 0) {
    return null;
  }
  return `${event.pid}|${event.cat}|${event.id2.local}`;
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function metricForSamples(samplesMs) {
  return Object.freeze({
    count: samplesMs.length,
    samplesMs: Object.freeze([...samplesMs]),
    p50Ms: nearestRank(samplesMs, 50),
    p95Ms: nearestRank(samplesMs, 95),
    p99Ms: nearestRank(samplesMs, 99),
  });
}

function presentationState(eventLatency) {
  const displayPresent = Object.hasOwn(eventLatency, "display_trace_id")
    && eventLatency.display_trace_id !== null
    && eventLatency.display_trace_id !== undefined;
  const surfacePresent = Object.hasOwn(eventLatency, "surface_frame_trace_id")
    && eventLatency.surface_frame_trace_id !== null
    && eventLatency.surface_frame_trace_id !== undefined;
  if (displayPresent && surfacePresent) return "presented";
  if (!displayPresent && !surfacePresent) return "termination-only";
  return "partial";
}

function normalizedEventDiagnostic(event, eventIndex, extra = {}) {
  return Object.freeze({
    eventIndex,
    name: typeof event?.name === "string" ? event.name : null,
    phase: typeof event?.ph === "string" ? event.ph : null,
    timestampUs: validTimestamp(event?.ts) ? event.ts : null,
    ...extra,
  });
}

function parsePrimaryEventLatency(events, expectedDispatchCounts) {
  const diagnostics = {
    orphanEnds: [],
    openBegins: [],
    invalidEvents: [],
    nonMonotonicEvents: [],
    unknownTypes: [],
    countMismatches: [],
  };
  const typedSamples = Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [inputType, []]),
  );
  const samples = [];
  const excludedHoverSamples = [];
  const stacks = new Map();
  const lastTimestampByTrack = new Map();
  let beginCount = 0;
  let endCount = 0;
  let pairedCount = 0;
  let presentedPairCount = 0;
  let terminationOnlyPairCount = 0;
  let partialPresentationPairCount = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event?.name !== EVENT_LATENCY_NAME) continue;
    if (event.ph !== "b" && event.ph !== "e") {
      diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        reason: "unsupported-event-latency-phase",
      }));
      continue;
    }
    if (event.ph === "b") beginCount += 1;
    else endCount += 1;

    const key = eventLatencyTrackKey(event);
    if (key === null || !validTimestamp(event.ts) || !validProcessOrThreadId(event.tid)) {
      diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        reason: "invalid-event-latency-track-or-timestamp",
      }));
      continue;
    }
    const previousTimestamp = lastTimestampByTrack.get(key);
    if (previousTimestamp !== undefined && event.ts < previousTimestamp) {
      diagnostics.nonMonotonicEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        key,
        previousTimestampUs: previousTimestamp,
        reason: "track-timestamp-regressed",
      }));
    }
    lastTimestampByTrack.set(key, event.ts);

    const stack = stacks.get(key) ?? [];
    if (event.ph === "b") {
      const eventLatency = event.args?.event_latency;
      let valid = true;
      let rawEventType = null;
      let classification = null;
      let state = "invalid";
      if (eventLatency === null
        || typeof eventLatency !== "object"
        || Array.isArray(eventLatency)
        || typeof eventLatency.event_type !== "string"
        || eventLatency.event_type.length === 0) {
        valid = false;
        diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
          key,
          reason: "invalid-event-latency-begin-args",
        }));
      } else {
        rawEventType = eventLatency.event_type;
        classification = RAW_EVENT_TYPE_CLASSIFICATION[rawEventType] ?? null;
        state = presentationState(eventLatency);
        if (classification === null) {
          diagnostics.unknownTypes.push(normalizedEventDiagnostic(event, eventIndex, {
            key,
            rawEventType,
          }));
        }
        if (state === "partial") {
          valid = false;
          diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
            key,
            rawEventType,
            reason: "partial-presentation-identifiers",
          }));
        }
      }
      stack.push({
        classification,
        event,
        eventIndex,
        key,
        rawEventType,
        state,
        valid,
      });
      stacks.set(key, stack);
      continue;
    }

    const begin = stack.pop();
    stacks.set(key, stack);
    if (!begin) {
      diagnostics.orphanEnds.push(normalizedEventDiagnostic(event, eventIndex, { key }));
      continue;
    }
    pairedCount += 1;
    if (event.ts < begin.event.ts) {
      diagnostics.nonMonotonicEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        beginEventIndex: begin.eventIndex,
        beginTimestampUs: begin.event.ts,
        key,
        reason: "presentation-precedes-generation",
      }));
      continue;
    }
    if (begin.state === "termination-only") {
      terminationOnlyPairCount += 1;
      continue;
    }
    if (begin.state === "partial") {
      partialPresentationPairCount += 1;
      continue;
    }
    if (begin.state !== "presented") continue;
    presentedPairCount += 1;
    if (!begin.valid || begin.classification === null) continue;
    const generationToPresentationMs = (event.ts - begin.event.ts) / 1_000;
    if (!Number.isFinite(generationToPresentationMs) || generationToPresentationMs < 0) {
      diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        beginEventIndex: begin.eventIndex,
        key,
        reason: "invalid-generation-to-presentation-duration",
      }));
      continue;
    }
    if (begin.classification.kind === "excluded") {
      excludedHoverSamples.push(generationToPresentationMs);
      continue;
    }
    const inputType = begin.classification.inputType;
    typedSamples[inputType].push(generationToPresentationMs);
    samples.push(Object.freeze({
      inputType,
      rawEventType: begin.rawEventType,
      generationTimestampUs: begin.event.ts,
      presentationTimestampUs: event.ts,
      generationToPresentationMs,
      pid: begin.event.pid,
      tid: begin.event.tid,
      category: begin.event.cat,
      localId: begin.event.id2.local,
    }));
  }

  for (const [key, stack] of stacks) {
    for (const begin of stack) {
      diagnostics.openBegins.push(normalizedEventDiagnostic(begin.event, begin.eventIndex, {
        key,
        rawEventType: begin.rawEventType,
      }));
    }
  }

  const inputTypes = Object.freeze(Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => (
      [inputType, metricForSamples(typedSamples[inputType])]
    )),
  ));
  if (expectedDispatchCounts !== null) {
    for (const [inputType, expectedCount] of Object.entries(expectedDispatchCounts)) {
      const actualCount = inputTypes[inputType].count;
      if (actualCount !== expectedCount) {
        diagnostics.countMismatches.push(Object.freeze({
          inputType,
          expectedCount,
          actualCount,
        }));
      }
    }
  }

  return {
    beginCount,
    diagnostics,
    endCount,
    excluded: Object.freeze({
      hover: metricForSamples(excludedHoverSamples),
    }),
    inputTypes,
    pairedCount,
    partialPresentationPairCount,
    presentedPairCount,
    samples: Object.freeze(samples),
    terminationOnlyPairCount,
  };
}

function flowIdKey(event) {
  const id = event?.id;
  const validId = (typeof id === "string" && id.length > 0)
    || (Number.isSafeInteger(id) && id >= 0);
  if (!validProcessOrThreadId(event?.pid)
    || typeof event?.cat !== "string"
    || !validId) {
    return null;
  }
  return `${event.pid}|${event.cat}|${typeof id}:${String(id)}`;
}

function pairFlowEvents(events, name) {
  const open = new Map();
  const pairs = [];
  const errors = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event?.name !== name
      || !categoryIncludes(event.cat, LATENCY_CATEGORY)
      || (event.ph !== "s" && event.ph !== "f")) continue;
    const key = flowIdKey(event);
    if (key === null || !validTimestamp(event.ts) || !validProcessOrThreadId(event.tid)) {
      errors.push({ eventIndex, reason: "invalid-flow-event" });
      continue;
    }
    if (event.ph === "s") {
      if (open.has(key)) errors.push({ eventIndex, key, reason: "duplicate-flow-start" });
      else open.set(key, { event, eventIndex });
      continue;
    }
    const begin = open.get(key);
    if (!begin) {
      errors.push({ eventIndex, key, reason: "orphan-flow-finish" });
      continue;
    }
    open.delete(key);
    if (event.ts < begin.event.ts) {
      errors.push({ eventIndex, key, reason: "nonmonotonic-flow" });
      continue;
    }
    pairs.push({ begin: begin.event, end: event });
  }
  for (const key of open.keys()) errors.push({ key, reason: "open-flow-start" });
  return { errors, pairs };
}

function pairAnimationFrameSlices(events) {
  const stacks = new Map();
  const pairs = [];
  const errors = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event?.name !== EVENTS_IN_ANIMATION_FRAME_NAME
      || !categoryIncludes(event.cat, LATENCY_CATEGORY)
      || (event.ph !== "b" && event.ph !== "e")
      || event.id2?.local === undefined) continue;
    if (!validProcessOrThreadId(event.pid)
      || !validProcessOrThreadId(event.tid)
      || typeof event.id2.local !== "string"
      || event.id2.local.length === 0
      || !validTimestamp(event.ts)) {
      errors.push({ eventIndex, reason: "invalid-animation-frame-slice" });
      continue;
    }
    const key = `${event.pid}|${event.tid}|${event.cat}|${event.id2.local}`;
    const stack = stacks.get(key) ?? [];
    if (event.ph === "b") {
      stack.push({ event, eventIndex });
      stacks.set(key, stack);
      continue;
    }
    const begin = stack.pop();
    stacks.set(key, stack);
    if (!begin) {
      errors.push({ eventIndex, key, reason: "orphan-animation-frame-end" });
      continue;
    }
    if (event.ts < begin.event.ts) {
      errors.push({ eventIndex, key, reason: "nonmonotonic-animation-frame" });
      continue;
    }
    pairs.push({ begin: begin.event, end: event });
  }
  for (const [key, stack] of stacks) {
    if (stack.length > 0) errors.push({ key, count: stack.length, reason: "open-animation-frame" });
  }
  return { errors, pairs };
}

function parseAnimationFrameCrossCheck(events, primaryInputTypes) {
  const hasAnimationFrameSchema = events.some((event) => (
    event?.name === EVENTS_IN_ANIMATION_FRAME_NAME
      && categoryIncludes(event.cat, LATENCY_CATEGORY)
  ));
  if (!hasAnimationFrameSchema) {
    return Object.freeze({
      supported: false,
      passed: null,
      reason: "latency-category EventsInAnimationFrame schema is absent",
      frameCount: 0,
      excludedFrameCount: 0,
      inputTypes: Object.freeze({
        pointerdown: metricForSamples([]),
        pointerup: metricForSamples([]),
      }),
      mismatches: Object.freeze([]),
      schemaErrors: Object.freeze([]),
    });
  }

  const slices = pairAnimationFrameSlices(events);
  const frameFlows = pairFlowEvents(events, EVENTS_IN_ANIMATION_FRAME_NAME);
  const creationFlows = pairFlowEvents(events, "EventCreation");
  const schemaErrors = [...slices.errors, ...frameFlows.errors, ...creationFlows.errors];
  if (slices.pairs.length === 0) {
    schemaErrors.push({ reason: "animation-frame-slices-missing" });
  }
  if (frameFlows.pairs.length === 0) {
    schemaErrors.push({ reason: "animation-frame-presentation-flows-missing" });
  }
  const samples = { pointerdown: [], pointerup: [] };
  let excludedFrameCount = 0;

  for (const frame of slices.pairs) {
    const processingEvents = events.filter((event) => (
      event?.name === "EventProcessing"
        && categoryIncludes(event.cat, LATENCY_CATEGORY)
        && event.ph === "b"
        && event.pid === frame.begin.pid
        && event.tid === frame.begin.tid
        && event.id2?.local === frame.begin.id2.local
        && validTimestamp(event.ts)
        && event.ts >= frame.begin.ts
        && event.ts <= frame.end.ts
    ));
    const discreteTypes = processingEvents
      .map((event) => DOM_DISCRETE_EVENT_TYPES[event.args?.event_timing?.type] ?? null)
      .filter((inputType) => inputType !== null);
    if (discreteTypes.length === 0) {
      excludedFrameCount += 1;
      continue;
    }
    if (discreteTypes.length !== 1) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "ambiguous-discrete-events-in-animation-frame",
        discreteTypes,
      });
      continue;
    }
    const inputType = discreteTypes[0];
    const matchingFrameFlows = frameFlows.pairs.filter((flow) => (
      flow.begin.pid === frame.begin.pid
        && flow.begin.tid === frame.begin.tid
        && flow.begin.ts === frame.begin.ts
    ));
    if (matchingFrameFlows.length !== 1) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "animation-frame-presentation-flow-cardinality",
        actualCount: matchingFrameFlows.length,
      });
      continue;
    }
    const matchingCreationFlows = creationFlows.pairs.filter((flow) => (
      flow.begin.pid === frame.begin.pid
        && flow.begin.tid === frame.begin.tid
        && flow.end.ts >= frame.begin.ts
        && flow.end.ts <= frame.end.ts
    ));
    if (matchingCreationFlows.length === 0) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "animation-frame-event-creation-flow-missing",
      });
      continue;
    }
    const generationTimestampUs = Math.min(
      ...matchingCreationFlows.map((flow) => flow.begin.ts),
    );
    const presentationTimestampUs = matchingFrameFlows[0].end.ts;
    if (!validTimestamp(generationTimestampUs)
      || !validTimestamp(presentationTimestampUs)
      || presentationTimestampUs < generationTimestampUs) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "animation-frame-generation-presentation-nonmonotonic",
      });
      continue;
    }
    samples[inputType].push((presentationTimestampUs - generationTimestampUs) / 1_000);
  }

  const inputTypes = Object.freeze({
    pointerdown: metricForSamples(samples.pointerdown),
    pointerup: metricForSamples(samples.pointerup),
  });
  const mismatches = [];
  for (const inputType of ["pointerdown", "pointerup"]) {
    const primary = [...primaryInputTypes[inputType].samplesMs].sort((left, right) => left - right);
    const crossCheck = [...inputTypes[inputType].samplesMs].sort((left, right) => left - right);
    const valuesMatch = primary.length === crossCheck.length
      && primary.every((value, index) => Math.abs(value - crossCheck[index]) <= 1e-9);
    if (!valuesMatch) {
      mismatches.push(Object.freeze({
        inputType,
        eventLatencySamplesMs: Object.freeze(primary),
        animationFrameSamplesMs: Object.freeze(crossCheck),
      }));
    }
  }
  const supported = schemaErrors.length === 0;
  return Object.freeze({
    supported,
    passed: supported ? mismatches.length === 0 : null,
    reason: supported ? null : "EventsInAnimationFrame schema was incomplete or ambiguous",
    frameCount: slices.pairs.length,
    excludedFrameCount,
    inputTypes,
    mismatches: Object.freeze(mismatches),
    schemaErrors: Object.freeze(schemaErrors.map((error) => Object.freeze({ ...error }))),
  });
}

/**
 * Parse Chrome JSON trace events without using precision-losing latency IDs.
 * EventLatency `id2.local` is a reusable async track, so begin/end events are
 * paired in serialized order with a per-track LIFO stack.
 */
export function parseDrawingEventLatencyTrace(trace, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("drawing event latency trace options must be an object");
  }
  const events = traceEventsFrom(trace);
  const expectedDispatchCounts = normalizeExpectedDispatchCounts(
    options.expectedDispatchCounts,
  );
  const primary = parsePrimaryEventLatency(events, expectedDispatchCounts);
  const animationFrameCrossCheck = parseAnimationFrameCrossCheck(events, primary.inputTypes);
  const diagnostics = Object.freeze(Object.fromEntries(
    Object.entries(primary.diagnostics).map(([key, entries]) => (
      [key, Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))]
    )),
  ));
  const failureReasons = [];
  for (const [name, entries] of Object.entries(diagnostics)) {
    if (entries.length > 0) failureReasons.push(name);
  }
  if (animationFrameCrossCheck.schemaErrors.length > 0) {
    failureReasons.push("eventsInAnimationFrameSchemaInvalid");
  } else if (animationFrameCrossCheck.supported && animationFrameCrossCheck.passed === false) {
    failureReasons.push("eventsInAnimationFrameMismatch");
  }
  return Object.freeze({
    schemaVersion: "drawing-event-latency-trace/v1",
    passed: failureReasons.length === 0,
    failureReasons: Object.freeze(failureReasons),
    expectedDispatchCounts,
    eventLatency: Object.freeze({
      beginCount: primary.beginCount,
      endCount: primary.endCount,
      pairedCount: primary.pairedCount,
      presentedPairCount: primary.presentedPairCount,
      terminationOnlyPairCount: primary.terminationOnlyPairCount,
      partialPresentationPairCount: primary.partialPresentationPairCount,
    }),
    inputTypes: primary.inputTypes,
    excluded: primary.excluded,
    samples: primary.samples,
    diagnostics,
    eventsInAnimationFrame: animationFrameCrossCheck,
  });
}
