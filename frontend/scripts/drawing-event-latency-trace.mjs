const EVENT_LATENCY_NAME = "EventLatency";
const EVENTS_IN_ANIMATION_FRAME_NAME = "EventsInAnimationFrame";
const LATENCY_CATEGORY = "latency";
const INPUT_CATEGORY = "input";

const FRAME_SUBMIT_STAGE_NAMES = Object.freeze(new Set([
  "SubmitCompositorFrameToPresentationCompositorFrame",
  "SubmitUpdateDisplayTreeToPresentationCompositorFrame",
]));
const HANDLER_STAGE_NAME = "RendererMainProcessing";
const TERMINATION_STAGE_NAME = "RendererMainFinishedToTermination";

const METRIC_SEMANTICS = Object.freeze({
  inputToNextPaintByType: Object.freeze({
    start: "renderer-main-processing",
    end: "next-frame-submit",
    meaning: "presented-input-to-next-paint",
  }),
  presentationByType: Object.freeze({
    start: "input-generation",
    end: "physical-presentation",
    meaning: "input-to-physical-presentation",
  }),
});

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
  return Number.isSafeInteger(value) && value >= 0;
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

const STAGE_DESCRIPTORS = Object.freeze({
  handler: Object.freeze({
    cardinalityDiagnostic: "handlerStageCardinalityMismatches",
    invalidDiagnostic: "invalidHandlerStages",
    nonMonotonicDiagnostic: "nonMonotonicHandlerStages",
    openDiagnostic: "openHandlerStageBegins",
    orphanDiagnostic: "orphanHandlerStageEnds",
    unnestedDiagnostic: "unnestedHandlerStages",
  }),
  submit: Object.freeze({
    cardinalityDiagnostic: "submitStageCardinalityMismatches",
    invalidDiagnostic: "invalidSubmitStages",
    nonMonotonicDiagnostic: "nonMonotonicSubmitStages",
    openDiagnostic: "openSubmitStageBegins",
    orphanDiagnostic: "orphanSubmitStageEnds",
    unnestedDiagnostic: "unnestedSubmitStages",
  }),
  termination: Object.freeze({
    cardinalityDiagnostic: "terminationStageCardinalityMismatches",
    invalidDiagnostic: "invalidTerminationStages",
    nonMonotonicDiagnostic: "nonMonotonicTerminationStages",
    openDiagnostic: "openTerminationStageBegins",
    orphanDiagnostic: "orphanTerminationStageEnds",
    unnestedDiagnostic: "unnestedTerminationStages",
  }),
});

function inputStageKind(event) {
  if (!categoryIncludes(event?.cat, INPUT_CATEGORY)) return null;
  if (event?.name === HANDLER_STAGE_NAME) return "handler";
  if (FRAME_SUBMIT_STAGE_NAMES.has(event?.name)) return "submit";
  if (event?.name === TERMINATION_STAGE_NAME) return "termination";
  return null;
}

function emptyDispatchGroupCounts() {
  return {
    count: 0,
    presentedCount: 0,
    standaloneTerminationCount: 0,
    duplicateTerminationCount: 0,
  };
}

function frozenDispatchGroupCounts(value) {
  return Object.freeze({ ...value });
}

function stageStateMatchesOwner(kind, owner) {
  if (owner === null) return false;
  if (kind === "submit") return owner.state === "presented";
  if (kind === "termination") return owner.state === "termination-only";
  return true;
}

function parsePrimaryEventLatency(events, expectedDispatchCounts) {
  const diagnostics = {
    orphanEnds: [],
    openBegins: [],
    invalidEvents: [],
    nonMonotonicEvents: [],
    unknownTypes: [],
    countMismatches: [],
    dispatchGroupMismatches: [],
    orphanHandlerStageEnds: [],
    openHandlerStageBegins: [],
    invalidHandlerStages: [],
    nonMonotonicHandlerStages: [],
    unnestedHandlerStages: [],
    handlerStageCardinalityMismatches: [],
    orphanSubmitStageEnds: [],
    openSubmitStageBegins: [],
    invalidSubmitStages: [],
    nonMonotonicSubmitStages: [],
    unnestedSubmitStages: [],
    submitStageCardinalityMismatches: [],
    submitStagePresentationMismatches: [],
    orphanTerminationStageEnds: [],
    openTerminationStageBegins: [],
    invalidTerminationStages: [],
    nonMonotonicTerminationStages: [],
    unnestedTerminationStages: [],
    terminationStageCardinalityMismatches: [],
    terminationStageEndpointMismatches: [],
  };
  const inputToNextPaintSamples = Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [inputType, []]),
  );
  const presentationSamples = Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [inputType, []]),
  );
  const dispatchGroups = Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [
      inputType,
      emptyDispatchGroupCounts(),
    ]),
  );
  const excludedHoverInputToNextPaintSamples = [];
  const excludedHoverPresentationSamples = [];
  const excludedHoverDispatchGroups = emptyDispatchGroupCounts();
  const samples = [];
  const branches = [];
  const stacks = new Map();
  const stageStacks = new Map();
  const lastTimestampByTrack = new Map();
  const lastStageTimestampByTrack = new Map();
  let beginCount = 0;
  let endCount = 0;
  let pairedCount = 0;
  let presentedPairCount = 0;
  let terminationOnlyPairCount = 0;
  let partialPresentationPairCount = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const kind = inputStageKind(event);
    if (kind !== null) {
      const descriptor = STAGE_DESCRIPTORS[kind];
      const allowedInstant = kind === "termination";
      if (event.ph !== "b" && event.ph !== "e" && !(allowedInstant && event.ph === "n")) {
        diagnostics[descriptor.invalidDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            reason: `unsupported-${kind}-stage-phase`,
          }),
        );
        continue;
      }
      const key = eventLatencyTrackKey(event);
      if (key === null || !validTimestamp(event.ts) || !validProcessOrThreadId(event.tid)) {
        diagnostics[descriptor.invalidDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            reason: `invalid-${kind}-stage-track-or-timestamp`,
          }),
        );
        continue;
      }
      const stageTrackKey = `${kind}|${key}`;
      const previousTimestamp = lastStageTimestampByTrack.get(stageTrackKey);
      if (previousTimestamp !== undefined && event.ts < previousTimestamp) {
        diagnostics[descriptor.nonMonotonicDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            key,
            previousTimestampUs: previousTimestamp,
            reason: `${kind}-stage-track-timestamp-regressed`,
          }),
        );
      }
      lastStageTimestampByTrack.set(stageTrackKey, event.ts);
      const owner = (stacks.get(key) ?? []).at(-1) ?? null;

      if (event.ph === "n") {
        let valid = true;
        if (!stageStateMatchesOwner(kind, owner)) {
          valid = false;
          diagnostics[descriptor.unnestedDiagnostic].push(
            normalizedEventDiagnostic(event, eventIndex, {
              key,
              ownerEventIndex: owner?.eventIndex ?? null,
              ownerState: owner?.state ?? null,
              reason: `${kind}-stage-instant-without-matching-event-latency-owner`,
            }),
          );
        }
        if (owner !== null && event.tid !== owner.event.tid) {
          valid = false;
          diagnostics[descriptor.unnestedDiagnostic].push(
            normalizedEventDiagnostic(event, eventIndex, {
              key,
              ownerEventIndex: owner.eventIndex,
              ownerTid: owner.event.tid,
              stageTid: event.tid,
              reason: `${kind}-stage-thread-does-not-match-owner`,
            }),
          );
        }
        if (owner !== null) {
          owner.stages[kind].push({
            begin: event,
            beginEventIndex: eventIndex,
            end: event,
            endEventIndex: eventIndex,
            valid,
          });
        }
        continue;
      }

      const stageStack = stageStacks.get(stageTrackKey) ?? [];
      if (event.ph === "b") {
        if (!stageStateMatchesOwner(kind, owner)) {
          diagnostics[descriptor.unnestedDiagnostic].push(
            normalizedEventDiagnostic(event, eventIndex, {
              key,
              ownerEventIndex: owner?.eventIndex ?? null,
              ownerState: owner?.state ?? null,
              reason: `${kind}-stage-begin-without-matching-event-latency-owner`,
            }),
          );
        }
        stageStack.push({ event, eventIndex, key, owner });
        stageStacks.set(stageTrackKey, stageStack);
        continue;
      }

      const stageBegin = stageStack.pop();
      stageStacks.set(stageTrackKey, stageStack);
      if (!stageBegin) {
        diagnostics[descriptor.orphanDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, { key }),
        );
        continue;
      }
      let valid = true;
      if (event.name !== stageBegin.event.name) {
        valid = false;
        diagnostics[descriptor.invalidDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            beginEventIndex: stageBegin.eventIndex,
            beginName: stageBegin.event.name,
            key,
            reason: `${kind}-stage-name-mismatch`,
          }),
        );
      }
      if (event.ts < stageBegin.event.ts) {
        valid = false;
        diagnostics[descriptor.nonMonotonicDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            beginEventIndex: stageBegin.eventIndex,
            beginTimestampUs: stageBegin.event.ts,
            key,
            reason: `${kind}-stage-end-precedes-begin`,
          }),
        );
      }
      const currentOwner = (stacks.get(key) ?? []).at(-1) ?? null;
      if (stageBegin.owner === null
        || currentOwner !== stageBegin.owner
        || !stageStateMatchesOwner(kind, stageBegin.owner)) {
        valid = false;
        diagnostics[descriptor.unnestedDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            beginEventIndex: stageBegin.eventIndex,
            key,
            reason: `${kind}-stage-end-outside-matching-event-latency-owner`,
          }),
        );
      }
      if (stageBegin.owner !== null
        && (stageBegin.event.tid !== stageBegin.owner.event.tid
          || event.tid !== stageBegin.owner.event.tid)) {
        valid = false;
        diagnostics[descriptor.unnestedDiagnostic].push(
          normalizedEventDiagnostic(event, eventIndex, {
            beginEventIndex: stageBegin.eventIndex,
            key,
            ownerTid: stageBegin.owner.event.tid,
            beginTid: stageBegin.event.tid,
            endTid: event.tid,
            reason: `${kind}-stage-thread-does-not-match-owner`,
          }),
        );
      }
      if (stageBegin.owner !== null) {
        stageBegin.owner.stages[kind].push({
          begin: stageBegin.event,
          beginEventIndex: stageBegin.eventIndex,
          end: event,
          endEventIndex: eventIndex,
          valid,
        });
      }
      continue;
    }

    if (event?.name !== EVENT_LATENCY_NAME
      || !categoryIncludes(event?.cat, INPUT_CATEGORY)) continue;
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
          valid = false;
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
        stages: { handler: [], submit: [], termination: [] },
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
    if (event.tid !== begin.event.tid) {
      begin.valid = false;
      diagnostics.invalidEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        beginEventIndex: begin.eventIndex,
        beginTid: begin.event.tid,
        endTid: event.tid,
        key,
        reason: "event-latency-end-thread-does-not-match-begin",
      }));
    }
    if (event.ts < begin.event.ts) {
      begin.valid = false;
      diagnostics.nonMonotonicEvents.push(normalizedEventDiagnostic(event, eventIndex, {
        beginEventIndex: begin.eventIndex,
        beginTimestampUs: begin.event.ts,
        key,
        reason: "event-latency-end-precedes-generation",
      }));
    }
    if (begin.state === "presented") presentedPairCount += 1;
    else if (begin.state === "termination-only") terminationOnlyPairCount += 1;
    else if (begin.state === "partial") partialPresentationPairCount += 1;
    branches.push({ ...begin, end: event, endEventIndex: eventIndex });
  }

  for (const [key, stack] of stacks) {
    for (const begin of stack) {
      diagnostics.openBegins.push(normalizedEventDiagnostic(begin.event, begin.eventIndex, {
        key,
        rawEventType: begin.rawEventType,
      }));
    }
  }
  for (const [stageTrackKey, stack] of stageStacks) {
    const kind = stageTrackKey.slice(0, stageTrackKey.indexOf("|"));
    const descriptor = STAGE_DESCRIPTORS[kind];
    for (const stageBegin of stack) {
      diagnostics[descriptor.openDiagnostic].push(
        normalizedEventDiagnostic(stageBegin.event, stageBegin.eventIndex, {
          key: stageBegin.key,
          ownerEventIndex: stageBegin.owner?.eventIndex ?? null,
        }),
      );
    }
  }

  function requireStageCardinality(branch, kind, expectedCount) {
    const actualCount = branch.stages[kind].length;
    if (actualCount === expectedCount) return true;
    const descriptor = STAGE_DESCRIPTORS[kind];
    diagnostics[descriptor.cardinalityDiagnostic].push(
      normalizedEventDiagnostic(branch.end, branch.endEventIndex, {
        beginEventIndex: branch.eventIndex,
        key: branch.key,
        expectedCount,
        actualCount,
        reason: `${branch.state}-event-latency-${kind}-stage-cardinality`,
      }),
    );
    return false;
  }

  function measureBranch(branch) {
    if (!requireStageCardinality(branch, "handler", 1)) return null;
    const handlerStage = branch.stages.handler[0];
    let cardinalityValid = true;
    if (branch.state === "presented") {
      const submitCardinalityValid = requireStageCardinality(branch, "submit", 1);
      const terminationCardinalityValid = requireStageCardinality(branch, "termination", 0);
      cardinalityValid = submitCardinalityValid && terminationCardinalityValid;
    } else if (branch.state === "termination-only") {
      const submitCardinalityValid = requireStageCardinality(branch, "submit", 0);
      const terminationCardinalityValid = requireStageCardinality(branch, "termination", 1);
      cardinalityValid = submitCardinalityValid && terminationCardinalityValid;
    } else {
      diagnostics.dispatchGroupMismatches.push(
        normalizedEventDiagnostic(branch.end, branch.endEventIndex, {
          beginEventIndex: branch.eventIndex,
          rawEventType: branch.rawEventType,
          state: branch.state,
          reason: "event-latency-branch-has-no-supported-endpoint",
        }),
      );
      return null;
    }
    if (!cardinalityValid || !branch.valid || !handlerStage.valid) return null;

    const generationTimestampUs = branch.event.ts;
    const handlerStartTimestampUs = handlerStage.begin.ts;
    if (handlerStartTimestampUs < generationTimestampUs
      || handlerStage.end.ts < handlerStartTimestampUs
      || handlerStage.end.ts > branch.end.ts) {
      diagnostics.invalidHandlerStages.push(
        normalizedEventDiagnostic(handlerStage.end, handlerStage.endEventIndex, {
          eventLatencyBeginEventIndex: branch.eventIndex,
          eventLatencyEndEventIndex: branch.endEventIndex,
          reason: "handler-stage-not-contained-by-event-latency",
        }),
      );
      return null;
    }

    if (branch.state === "presented") {
      const submitStage = branch.stages.submit[0];
      if (!submitStage.valid) return null;
      const frameSubmitTimestampUs = submitStage.begin.ts;
      const presentationTimestampUs = branch.end.ts;
      if (frameSubmitTimestampUs < handlerStage.end.ts
        || submitStage.end.ts < frameSubmitTimestampUs
        || submitStage.end.ts > presentationTimestampUs) {
        diagnostics.unnestedSubmitStages.push(
          normalizedEventDiagnostic(submitStage.end, submitStage.endEventIndex, {
            eventLatencyBeginEventIndex: branch.eventIndex,
            eventLatencyEndEventIndex: branch.endEventIndex,
            reason: "submit-stage-not-contained-after-handler",
          }),
        );
        return null;
      }
      if (submitStage.end.ts !== presentationTimestampUs) {
        diagnostics.submitStagePresentationMismatches.push(
          normalizedEventDiagnostic(submitStage.end, submitStage.endEventIndex, {
            eventLatencyEndEventIndex: branch.endEventIndex,
            eventLatencyPresentationTimestampUs: presentationTimestampUs,
            reason: "submit-stage-end-does-not-match-presentation",
          }),
        );
        return null;
      }
      const generationToHandlerUs = handlerStartTimestampUs - generationTimestampUs;
      const handlerToNextPaintUs = frameSubmitTimestampUs - handlerStartTimestampUs;
      const frameSubmitToPresentationUs = presentationTimestampUs - frameSubmitTimestampUs;
      const generationToPresentationUs = presentationTimestampUs - generationTimestampUs;
      if (![generationToHandlerUs, handlerToNextPaintUs, frameSubmitToPresentationUs,
        generationToPresentationUs].every((value) => Number.isSafeInteger(value) && value >= 0)
        || generationToHandlerUs + handlerToNextPaintUs + frameSubmitToPresentationUs
          !== generationToPresentationUs) {
        diagnostics.invalidEvents.push(
          normalizedEventDiagnostic(branch.end, branch.endEventIndex, {
            beginEventIndex: branch.eventIndex,
            reason: "presented-duration-microsecond-conservation-failed",
          }),
        );
        return null;
      }
      return {
        branch,
        endpoint: "frame-submit",
        endpointTimestampUs: frameSubmitTimestampUs,
        frameSubmitStageName: submitStage.begin.name,
        frameSubmitTimestampUs,
        frameSubmitToPresentationMs: frameSubmitToPresentationUs / 1_000,
        generationTimestampUs,
        generationToHandlerMs: generationToHandlerUs / 1_000,
        generationToPresentationMs: generationToPresentationUs / 1_000,
        handlerStartTimestampUs,
        handlerToTerminationMs: null,
        handlerToNextPaintMs: handlerToNextPaintUs / 1_000,
        presentationTimestampUs,
      };
    }

    const terminationStage = branch.stages.termination[0];
    if (!terminationStage.valid) return null;
    const endpointTimestampUs = branch.end.ts;
    if (terminationStage.begin.ts < handlerStage.end.ts
      || terminationStage.end.ts < terminationStage.begin.ts
      || terminationStage.end.ts !== endpointTimestampUs) {
      diagnostics.terminationStageEndpointMismatches.push(
        normalizedEventDiagnostic(terminationStage.end, terminationStage.endEventIndex, {
          eventLatencyBeginEventIndex: branch.eventIndex,
          eventLatencyEndEventIndex: branch.endEventIndex,
          eventLatencyTerminationTimestampUs: endpointTimestampUs,
          reason: "termination-stage-does-not-end-at-event-latency-termination",
        }),
      );
      return null;
    }
    const generationToHandlerUs = handlerStartTimestampUs - generationTimestampUs;
    const handlerToNextPaintUs = endpointTimestampUs - handlerStartTimestampUs;
    const generationToEndpointUs = endpointTimestampUs - generationTimestampUs;
    if (![generationToHandlerUs, handlerToNextPaintUs, generationToEndpointUs]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
      || generationToHandlerUs + handlerToNextPaintUs !== generationToEndpointUs) {
      diagnostics.invalidEvents.push(
        normalizedEventDiagnostic(branch.end, branch.endEventIndex, {
          beginEventIndex: branch.eventIndex,
          reason: "termination-duration-microsecond-conservation-failed",
        }),
      );
      return null;
    }
    return {
      branch,
      endpoint: "event-latency-termination",
      endpointTimestampUs,
      frameSubmitStageName: null,
      frameSubmitTimestampUs: null,
      frameSubmitToPresentationMs: null,
      generationTimestampUs,
      generationToHandlerMs: generationToHandlerUs / 1_000,
      generationToPresentationMs: null,
      handlerStartTimestampUs,
      handlerToTerminationMs: handlerToNextPaintUs / 1_000,
      handlerToNextPaintMs: null,
      presentationTimestampUs: null,
    };
  }

  const groups = new Map();
  for (const branch of branches) {
    if (branch.rawEventType === null || branch.classification === null) continue;
    const groupKey = `${branch.event.pid}|${branch.rawEventType}|${branch.event.ts}`;
    const group = groups.get(groupKey) ?? {
      branches: [],
      classification: branch.classification,
      generationTimestampUs: branch.event.ts,
      pid: branch.event.pid,
      rawEventType: branch.rawEventType,
    };
    group.branches.push(branch);
    groups.set(groupKey, group);
  }

  const orderedGroups = [...groups.values()].sort((left, right) => (
    left.generationTimestampUs - right.generationTimestampUs
      || left.rawEventType.localeCompare(right.rawEventType)
      || left.pid - right.pid
  ));
  for (const group of orderedGroups) {
    const targetCounts = group.classification.kind === "excluded"
      ? excludedHoverDispatchGroups
      : dispatchGroups[group.classification.inputType];
    targetCounts.count += 1;
    const presented = group.branches.filter((branch) => branch.state === "presented");
    const terminated = group.branches.filter((branch) => branch.state === "termination-only");
    const validPresentedGroup = presented.length === 1
      && terminated.length === 0
      && group.branches.length === 1;
    const validTerminationGroup = presented.length === 0
      && terminated.length === 1
      && group.branches.length === 1;
    const validDuplicateGroup = presented.length === 1
      && terminated.length === 1
      && group.branches.length === 2;
    if (!validPresentedGroup && !validTerminationGroup && !validDuplicateGroup) {
      diagnostics.dispatchGroupMismatches.push(Object.freeze({
        pid: group.pid,
        rawEventType: group.rawEventType,
        generationTimestampUs: group.generationTimestampUs,
        branchCount: group.branches.length,
        presentedCount: presented.length,
        terminationOnlyCount: terminated.length,
        reason: "dispatch-group-endpoint-cardinality",
      }));
      for (const branch of group.branches) measureBranch(branch);
      continue;
    }

    let selected;
    if (validPresentedGroup || validDuplicateGroup) {
      targetCounts.presentedCount += 1;
      if (validDuplicateGroup) targetCounts.duplicateTerminationCount += 1;
      const presentedMeasurement = measureBranch(presented[0]);
      const duplicateMeasurement = validDuplicateGroup ? measureBranch(terminated[0]) : true;
      if (presentedMeasurement === null || duplicateMeasurement === null) continue;
      selected = presentedMeasurement;
    } else {
      targetCounts.standaloneTerminationCount += 1;
      selected = measureBranch(terminated[0]);
      if (selected === null) continue;
    }

    const branch = selected.branch;
    const sample = Object.freeze({
      inputType: branch.classification.kind === "excluded"
        ? "hover"
        : branch.classification.inputType,
      rawEventType: branch.rawEventType,
      endpoint: selected.endpoint,
      generationTimestampUs: selected.generationTimestampUs,
      handlerStartTimestampUs: selected.handlerStartTimestampUs,
      endpointTimestampUs: selected.endpointTimestampUs,
      frameSubmitTimestampUs: selected.frameSubmitTimestampUs,
      presentationTimestampUs: selected.presentationTimestampUs,
      generationToHandlerMs: selected.generationToHandlerMs,
      handlerToNextPaintMs: selected.handlerToNextPaintMs,
      frameSubmitToPresentationMs: selected.frameSubmitToPresentationMs,
      generationToPresentationMs: selected.generationToPresentationMs,
      handlerToTerminationMs: selected.handlerToTerminationMs,
      frameSubmitStageName: selected.frameSubmitStageName,
      pid: branch.event.pid,
      tid: branch.event.tid,
      category: branch.event.cat,
      localId: branch.event.id2.local,
    });
    if (branch.classification.kind === "excluded") {
      if (selected.handlerToNextPaintMs !== null) {
        excludedHoverInputToNextPaintSamples.push(selected.handlerToNextPaintMs);
      }
      if (selected.generationToPresentationMs !== null) {
        excludedHoverPresentationSamples.push(selected.generationToPresentationMs);
      }
      continue;
    }
    if (selected.handlerToNextPaintMs !== null) {
      inputToNextPaintSamples[branch.classification.inputType]
        .push(selected.handlerToNextPaintMs);
    }
    if (selected.generationToPresentationMs !== null) {
      presentationSamples[branch.classification.inputType]
        .push(selected.generationToPresentationMs);
    }
    samples.push(sample);
  }

  const allDispatchGroupCounts = [
    ...Object.values(dispatchGroups),
    excludedHoverDispatchGroups,
  ];
  const groupedPresentedCount = allDispatchGroupCounts.reduce(
    (total, value) => total + value.presentedCount,
    0,
  );
  const groupedTerminationCount = allDispatchGroupCounts.reduce(
    (total, value) => total + value.standaloneTerminationCount
      + value.duplicateTerminationCount,
    0,
  );
  if (presentedPairCount !== groupedPresentedCount) {
    diagnostics.dispatchGroupMismatches.push(Object.freeze({
      expectedCount: presentedPairCount,
      actualCount: groupedPresentedCount,
      reason: "presented-pair-to-dispatch-group-conservation",
    }));
  }
  if (terminationOnlyPairCount !== groupedTerminationCount) {
    diagnostics.dispatchGroupMismatches.push(Object.freeze({
      expectedCount: terminationOnlyPairCount,
      actualCount: groupedTerminationCount,
      reason: "termination-pair-to-dispatch-group-conservation",
    }));
  }
  if (partialPresentationPairCount !== 0) {
    diagnostics.dispatchGroupMismatches.push(Object.freeze({
      actualCount: partialPresentationPairCount,
      expectedCount: 0,
      reason: "partial-presentation-pairs-must-be-zero",
    }));
  }
  const classifiedPairCount = presentedPairCount
    + terminationOnlyPairCount
    + partialPresentationPairCount;
  if (pairedCount !== classifiedPairCount) {
    diagnostics.dispatchGroupMismatches.push(Object.freeze({
      actualCount: classifiedPairCount,
      expectedCount: pairedCount,
      reason: "paired-event-latency-state-conservation",
    }));
  }

  const inputToNextPaintByType = Object.freeze(Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [
      inputType,
      metricForSamples(inputToNextPaintSamples[inputType]),
    ]),
  ));
  const presentationByType = Object.freeze(Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [
      inputType,
      metricForSamples(presentationSamples[inputType]),
    ]),
  ));
  const dispatchGroupsByType = Object.freeze(Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [
      inputType,
      frozenDispatchGroupCounts(dispatchGroups[inputType]),
    ]),
  ));
  if (expectedDispatchCounts !== null) {
    for (const [inputType, expectedCount] of Object.entries(expectedDispatchCounts)) {
      const actualCount = dispatchGroupsByType[inputType].count;
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
    dispatchGroupsByType,
    endCount,
    excluded: Object.freeze({
      hover: Object.freeze({
        dispatchGroups: frozenDispatchGroupCounts(excludedHoverDispatchGroups),
        inputToNextPaint: metricForSamples(excludedHoverInputToNextPaintSamples),
        presentation: metricForSamples(excludedHoverPresentationSamples),
      }),
    }),
    inputToNextPaintByType,
    pairedCount,
    partialPresentationPairCount,
    presentationByType,
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

function isSortedMultisetSubset(subset, superset) {
  let supersetIndex = 0;
  for (const expected of subset) {
    while (supersetIndex < superset.length
      && superset[supersetIndex] < expected - 1e-9) {
      supersetIndex += 1;
    }
    if (supersetIndex >= superset.length
      || Math.abs(superset[supersetIndex] - expected) > 1e-9) return false;
    supersetIndex += 1;
  }
  return true;
}

function parseAnimationFrameCrossCheck(
  events,
  primaryPresentationByType,
  expectedDispatchCounts,
) {
  const emptyDiscreteMetrics = () => Object.freeze({
    pointerdown: metricForSamples([]),
    pointerup: metricForSamples([]),
  });
  const hasAnimationFrameSchema = events.some((event) => (
    event?.name === EVENTS_IN_ANIMATION_FRAME_NAME
      && categoryIncludes(event.cat, LATENCY_CATEGORY)
  ));
  if (!hasAnimationFrameSchema) {
    const requiredDiscreteTypes = ["pointerdown", "pointerup"].filter((inputType) => (
      (expectedDispatchCounts?.[inputType] ?? 0) > 0
    ));
    const schemaErrors = requiredDiscreteTypes.length > 0
      ? Object.freeze([Object.freeze({
        inputTypes: Object.freeze(requiredDiscreteTypes),
        reason: "required-animation-frame-schema-missing",
      })])
      : Object.freeze([]);
    return Object.freeze({
      supported: false,
      passed: null,
      reason: "latency-category EventsInAnimationFrame schema is absent",
      frameCount: 0,
      excludedFrameCount: 0,
      presentationByType: emptyDiscreteMetrics(),
      fallbackByType: emptyDiscreteMetrics(),
      samples: Object.freeze([]),
      mismatches: Object.freeze([]),
      schemaErrors,
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
  const endpointInstants = events.filter((event) => (
    (event?.name === "EventPresentation" || event?.name === "EventFallbackTime")
      && categoryIncludes(event.cat, LATENCY_CATEGORY)
  ));
  for (let eventIndex = 0; eventIndex < endpointInstants.length; eventIndex += 1) {
    const event = endpointInstants[eventIndex];
    if (event.ph !== "n"
      || !validTimestamp(event.ts)
      || !validProcessOrThreadId(event.pid)
      || !validProcessOrThreadId(event.tid)
      || typeof event.id2?.local !== "string"
      || event.id2.local.length === 0) {
      schemaErrors.push({
        eventIndex,
        name: event.name,
        reason: "invalid-animation-frame-endpoint-instant",
      });
    }
  }
  const presentationSamples = { pointerdown: [], pointerup: [] };
  const fallbackSamples = { pointerdown: [], pointerup: [] };
  const samples = [];
  const generationKeys = new Set();
  let excludedFrameCount = 0;

  for (const frame of slices.pairs) {
    const matchingFrameFlows = frameFlows.pairs.filter((flow) => (
      flow.begin.pid === frame.begin.pid
        && flow.begin.tid === frame.begin.tid
        && flow.begin.ts === frame.begin.ts
    ));
    if (matchingFrameFlows.length !== 1) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "animation-frame-endpoint-flow-cardinality",
        actualCount: matchingFrameFlows.length,
      });
      continue;
    }
    const endpointFlow = matchingFrameFlows[0];
    const endpointTimestampUs = endpointFlow.end.ts;
    if (endpointFlow.end.pid !== frame.begin.pid
      || endpointFlow.end.tid !== frame.begin.tid) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        endpointTimestampUs,
        endpointPid: endpointFlow.end.pid,
        endpointTid: endpointFlow.end.tid,
        reason: "animation-frame-endpoint-flow-thread-mismatch",
      });
      continue;
    }
    if (endpointTimestampUs < frame.end.ts) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        frameEndTimestampUs: frame.end.ts,
        endpointTimestampUs,
        reason: "animation-frame-endpoint-precedes-frame-end",
      });
      continue;
    }
    const matchingEndpointInstants = endpointInstants.filter((event) => (
      event.ph === "n"
        && event.pid === frame.begin.pid
        && event.tid === frame.begin.tid
        && event.id2?.local === frame.begin.id2.local
        && event.ts === endpointTimestampUs
    ));
    if (matchingEndpointInstants.length !== 1) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        endpointTimestampUs,
        reason: "animation-frame-endpoint-instant-cardinality",
        actualCount: matchingEndpointInstants.length,
      });
      continue;
    }
    const outcome = matchingEndpointInstants[0].name === "EventPresentation"
      ? "presentation"
      : "fallback";
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
    const matchingCreationFlows = creationFlows.pairs.filter((flow) => (
      flow.begin.pid === frame.begin.pid
        && flow.begin.tid === frame.begin.tid
        && flow.end.ts >= frame.begin.ts
        && flow.end.ts <= frame.end.ts
    ));
    if (matchingCreationFlows.length !== 1) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        actualCount: matchingCreationFlows.length,
        reason: "animation-frame-event-creation-flow-cardinality",
      });
      continue;
    }
    const generationTimestampUs = matchingCreationFlows[0].begin.ts;
    if (!validTimestamp(generationTimestampUs)
      || !validTimestamp(endpointTimestampUs)
      || endpointTimestampUs < generationTimestampUs) {
      schemaErrors.push({
        timestampUs: frame.begin.ts,
        reason: "animation-frame-generation-endpoint-nonmonotonic",
      });
      continue;
    }
    const generationKey = `${frame.begin.pid}|${inputType}|${generationTimestampUs}`;
    if (generationKeys.has(generationKey)) {
      schemaErrors.push({
        inputType,
        generationTimestampUs,
        pid: frame.begin.pid,
        reason: "duplicate-animation-frame-dispatch-generation",
      });
      continue;
    }
    generationKeys.add(generationKey);
    const generationToEndpointMs = (endpointTimestampUs - generationTimestampUs) / 1_000;
    const targetSamples = outcome === "presentation" ? presentationSamples : fallbackSamples;
    targetSamples[inputType].push(generationToEndpointMs);
    samples.push(Object.freeze({
      inputType,
      outcome,
      generationTimestampUs,
      endpointTimestampUs,
      generationToEndpointMs,
      pid: frame.begin.pid,
      tid: frame.begin.tid,
      localId: frame.begin.id2.local,
    }));
  }

  const presentationByType = Object.freeze({
    pointerdown: metricForSamples(presentationSamples.pointerdown),
    pointerup: metricForSamples(presentationSamples.pointerup),
  });
  const fallbackByType = Object.freeze({
    pointerdown: metricForSamples(fallbackSamples.pointerdown),
    pointerup: metricForSamples(fallbackSamples.pointerup),
  });
  const mismatches = [];
  for (const inputType of ["pointerdown", "pointerup"]) {
    const primary = [...primaryPresentationByType[inputType].samplesMs]
      .sort((left, right) => left - right);
    const crossCheck = [...presentationByType[inputType].samplesMs]
      .sort((left, right) => left - right);
    const expectedCount = expectedDispatchCounts?.[inputType] ?? null;
    const fallbackCount = fallbackByType[inputType].count;
    if (expectedCount !== null && crossCheck.length + fallbackCount !== expectedCount) {
      mismatches.push(Object.freeze({
        inputType,
        expectedCount,
        actualCount: crossCheck.length + fallbackCount,
        presentationCount: crossCheck.length,
        fallbackCount,
        reason: "animation-frame-outcome-count-mismatch",
      }));
    }
    if (!isSortedMultisetSubset(primary, crossCheck)) {
      mismatches.push(Object.freeze({
        inputType,
        eventLatencyPresentationSamplesMs: Object.freeze(primary),
        animationFramePresentationSamplesMs: Object.freeze(crossCheck),
        reason: "event-latency-presentations-not-animation-frame-multiset-subset",
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
    presentationByType,
    fallbackByType,
    samples: Object.freeze(samples),
    mismatches: Object.freeze(mismatches),
    schemaErrors: Object.freeze(schemaErrors.map((error) => Object.freeze({ ...error }))),
  });
}

/**
 * Parse Chrome JSON trace events without using precision-losing latency IDs.
 * EventLatency `id2.local` is a reusable async track, so begin/end events are
 * paired in serialized order with a per-track LIFO stack. The resulting raw
 * branches are grouped by process, raw event type, and integer generation
 * timestamp so Chromium's legal duplicate termination branch remains one
 * dispatch without allowing cross-renderer collisions.
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
  const animationFrameCrossCheck = parseAnimationFrameCrossCheck(
    events,
    primary.presentationByType,
    expectedDispatchCounts,
  );
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
    schemaVersion: "drawing-event-latency-trace/v3",
    passed: failureReasons.length === 0,
    failureReasons: Object.freeze(failureReasons),
    expectedDispatchCounts,
    metricSemantics: METRIC_SEMANTICS,
    eventLatency: Object.freeze({
      beginCount: primary.beginCount,
      endCount: primary.endCount,
      pairedCount: primary.pairedCount,
      presentedPairCount: primary.presentedPairCount,
      terminationOnlyPairCount: primary.terminationOnlyPairCount,
      partialPresentationPairCount: primary.partialPresentationPairCount,
    }),
    inputToNextPaintByType: primary.inputToNextPaintByType,
    presentationByType: primary.presentationByType,
    dispatchGroupsByType: primary.dispatchGroupsByType,
    excluded: primary.excluded,
    samples: primary.samples,
    diagnostics,
    eventsInAnimationFrame: animationFrameCrossCheck,
  });
}
