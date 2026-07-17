export function createDrawingInputPaintFenceTracker(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("drawing input paint fence options must be an object");
  }

  const eventTypes = Array.isArray(options.eventTypes) ? options.eventTypes.slice() : [];
  if (eventTypes.length === 0
    || eventTypes.some((type) => typeof type !== "string" || type.length === 0)
    || new Set(eventTypes).size !== eventTypes.length) {
    throw new TypeError("drawing input paint fence eventTypes must be unique non-empty strings");
  }
  const eventTypeSet = new Set(eventTypes);
  const requiredFunctions = [
    "now",
    "readLastRafAt",
    "requestFrame",
    "schedulePostRafTask",
    "onOverallFence",
    "onTypeFence",
  ];
  for (const key of requiredFunctions) {
    if (typeof options[key] !== "function") {
      throw new TypeError(`drawing input paint fence ${key} must be a function`);
    }
  }
  if (typeof options.performanceTimeOriginMs !== "number"
    || !Number.isFinite(options.performanceTimeOriginMs)
    || options.performanceTimeOriginMs < 0) {
    throw new TypeError(
      "drawing input paint fence performanceTimeOriginMs must be finite and non-negative",
    );
  }
  if (!Number.isSafeInteger(options.topKCapacity) || options.topKCapacity < 0) {
    throw new TypeError(
      "drawing input paint fence topKCapacity must be a non-negative safe integer",
    );
  }
  const now = options.now;
  const readLastRafAtOption = options.readLastRafAt;
  const requestFrame = options.requestFrame;
  const schedulePostRafTask = options.schedulePostRafTask;
  const onOverallFence = options.onOverallFence;
  const onTypeFence = options.onTypeFence;
  const performanceTimeOriginMs = options.performanceTimeOriginMs;
  const topKCapacity = options.topKCapacity;

  const makePendingType = () => ({
    eventCount: 0,
    eventTimeStampMs: null,
    handlerAtMs: null,
    lastRafAtMs: null,
    cycle: null,
  });
  const makePendingCohort = () => ({
    eventCount: 0,
    earliestHandlerAtMs: null,
    byType: Object.fromEntries(eventTypes.map((type) => [type, makePendingType()])),
  });
  const typeStats = Object.fromEntries(eventTypes.map((type) => [type, {
    eventCount: 0,
    completedEventCount: 0,
    droppedEventCount: 0,
    fenceCount: 0,
    coalescedEventCount: 0,
    maxEventsPerFence: 0,
    postRafInputCount: 0,
    inputWhileFrozenCount: 0,
    unattributedEventCount: 0,
    unattributedFenceCount: 0,
  }]));

  let disposed = false;
  let epoch = 0;
  let activeCycle = null;
  let pending = makePendingCohort();
  let frameScheduled = false;
  let nextFenceId = 1;
  let overallFenceCount = 0;
  let staleFrameCallbackCount = 0;
  let stalePostRafTaskCallbackCount = 0;
  const frozenCohorts = new Map();
  const slowEntries = [];
  let observedTypeFenceCount = 0;

  const finiteTimestamp = (value, label) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`drawing input paint fence ${label} must be finite and non-negative`);
    }
    return value;
  };
  const readNow = (label) => finiteTimestamp(now(), label);
  const readLastRafAt = () => {
    const value = readLastRafAtOption();
    return value === null || value === undefined
      ? null
      : finiteTimestamp(value, "last rAF timestamp");
  };
  const assertCycle = (cycle) => {
    if (!Number.isSafeInteger(cycle) || cycle <= 0) {
      throw new TypeError("drawing input paint fence cycle must be a positive safe integer");
    }
  };
  const compareSlowEntries = (left, right) => {
    const latencyDelta = right.conservativeTotalMs - left.conservativeTotalMs;
    if (latencyDelta !== 0) return latencyDelta;
    if (left.fenceId !== right.fenceId) return left.fenceId - right.fenceId;
    if (left.eventType === right.eventType) return 0;
    return left.eventType < right.eventType ? -1 : 1;
  };
  const retainSlowEntry = (entry) => {
    observedTypeFenceCount += 1;
    if (topKCapacity === 0) return;
    slowEntries.push(entry);
    slowEntries.sort(compareSlowEntries);
    if (slowEntries.length > topKCapacity) {
      slowEntries.length = topKCapacity;
    }
  };
  const markCohortDropped = (cohort) => {
    for (const type of eventTypes) {
      typeStats[type].droppedEventCount += cohort.byType[type].eventCount;
    }
  };
  const frozenEventCountForType = (type) => {
    let count = 0;
    for (const frozen of frozenCohorts.values()) {
      count += frozen.cohort.byType[type].eventCount;
    }
    return count;
  };

  const completeFrozenCohort = (frozen) => {
    const postRafTaskAtMs = readNow("post-rAF task timestamp");
    if (postRafTaskAtMs < frozen.rafAtMs
      || postRafTaskAtMs < frozen.cohort.earliestHandlerAtMs) {
      throw new RangeError("drawing input paint fence timestamps must be monotonic");
    }
    frozenCohorts.delete(frozen.fenceId);
    overallFenceCount += 1;

    // Keep the historical threshold input unchanged: the existing aggregate
    // and typed gates consume handler -> post-rAF-task latency. The trace below
    // separately exposes event dispatch delay and uses the conservative
    // event -> post-rAF-task total only for diagnostic ranking.
    const overallLatencyMs = postRafTaskAtMs - frozen.cohort.earliestHandlerAtMs;
    const typeCallbacks = [];
    for (const type of eventTypes) {
      const captured = frozen.cohort.byType[type];
      if (captured.eventCount === 0) continue;
      if (captured.handlerAtMs === null || frozen.rafAtMs < captured.handlerAtMs) {
        throw new RangeError("drawing input paint fence timestamps must be monotonic");
      }
      if (captured.eventTimeStampMs === null
        || captured.eventTimeStampMs > captured.handlerAtMs) {
        throw new RangeError("drawing input paint fence event timestamps must be monotonic");
      }
      const eventToHandlerMs = captured.handlerAtMs - captured.eventTimeStampMs;
      const handlerToRafMs = frozen.rafAtMs - captured.handlerAtMs;
      const rafToPostRafTaskMs = postRafTaskAtMs - frozen.rafAtMs;
      const handlerToPostRafTaskMs = postRafTaskAtMs - captured.handlerAtMs;
      const eventToPostRafTaskMs = postRafTaskAtMs - captured.eventTimeStampMs;
      const stats = typeStats[type];
      stats.completedEventCount += captured.eventCount;
      stats.fenceCount += 1;
      stats.coalescedEventCount += Math.max(0, captured.eventCount - 1);
      stats.maxEventsPerFence = Math.max(stats.maxEventsPerFence, captured.eventCount);
      if (captured.cycle === null) stats.unattributedFenceCount += 1;
      retainSlowEntry({
        fenceId: frozen.fenceId,
        cycle: captured.cycle,
        eventType: type,
        eventCount: captured.eventCount,
        eventTimeStampMs: captured.eventTimeStampMs,
        handlerAtMs: captured.handlerAtMs,
        lastRafAtMs: captured.lastRafAtMs,
        rafAtMs: frozen.rafAtMs,
        postRafTaskAtMs,
        eventToHandlerMs,
        handlerToRafMs,
        rafToPostRafTaskMs,
        handlerToPostRafTaskMs,
        eventToPostRafTaskMs,
        conservativeTotalMs: eventToPostRafTaskMs,
      });
      typeCallbacks.push([type, handlerToPostRafTaskMs]);
    }

    onOverallFence(overallLatencyMs);
    for (const [type, latencyMs] of typeCallbacks) {
      onTypeFence(type, latencyMs);
    }
  };

  const scheduleFence = () => {
    if (frameScheduled || disposed) return;
    frameScheduled = true;
    const scheduledEpoch = epoch;
    try {
      requestFrame(() => {
        if (disposed || scheduledEpoch !== epoch) {
          staleFrameCallbackCount += 1;
          return;
        }

        const rafAtMs = readNow("rAF timestamp");
        const cohort = pending;
        pending = makePendingCohort();
        frameScheduled = false;
        if (cohort.eventCount === 0 || cohort.earliestHandlerAtMs === null) return;
        if (rafAtMs < cohort.earliestHandlerAtMs) {
          markCohortDropped(cohort);
          throw new RangeError("drawing input paint fence timestamps must be monotonic");
        }

        // The cohort is detached at rAF entry. Any input arriving before the
        // following task now sees frameScheduled=false and creates a new fence.
        const frozen = {
          fenceId: nextFenceId,
          epoch: scheduledEpoch,
          rafAtMs,
          cohort,
        };
        nextFenceId += 1;
        frozenCohorts.set(frozen.fenceId, frozen);
        try {
          schedulePostRafTask(() => {
            if (disposed || frozen.epoch !== epoch) {
              stalePostRafTaskCallbackCount += 1;
              return;
            }
            if (frozenCohorts.get(frozen.fenceId) !== frozen) {
              stalePostRafTaskCallbackCount += 1;
              return;
            }
            completeFrozenCohort(frozen);
          });
        } catch (error) {
          frozenCohorts.delete(frozen.fenceId);
          markCohortDropped(cohort);
          throw error;
        }
      });
    } catch (error) {
      frameScheduled = false;
      throw error;
    }
  };

  const recordInput = (event) => {
    if (disposed) return false;
    if (event === null || typeof event !== "object" || !eventTypeSet.has(event.type)) {
      return false;
    }
    const rawEventTimeStampMs = finiteTimestamp(event.timeStamp, "event timestamp");
    const handlerAtMs = readNow("input handler timestamp");
    const lastRafAtMs = readLastRafAt();
    const relativeEpochEventTimeStampMs = rawEventTimeStampMs
      - performanceTimeOriginMs;
    let eventTimeStampMs = rawEventTimeStampMs;
    if (rawEventTimeStampMs > handlerAtMs
      && relativeEpochEventTimeStampMs >= 0
      && relativeEpochEventTimeStampMs <= handlerAtMs) {
      eventTimeStampMs = relativeEpochEventTimeStampMs;
    }
    if (eventTimeStampMs > handlerAtMs
      || (lastRafAtMs !== null && lastRafAtMs > handlerAtMs)) {
      throw new RangeError("drawing input paint fence input timestamps must be monotonic");
    }
    const type = event.type;
    const stats = typeStats[type];
    stats.eventCount += 1;
    if (frozenCohorts.size > 0) stats.inputWhileFrozenCount += 1;
    if (activeCycle === null) stats.unattributedEventCount += 1;

    pending.eventCount += 1;
    if (pending.earliestHandlerAtMs === null
      || handlerAtMs < pending.earliestHandlerAtMs) {
      pending.earliestHandlerAtMs = handlerAtMs;
    }
    const pendingType = pending.byType[type];
    pendingType.eventCount += 1;
    if (pendingType.eventTimeStampMs === null
      || eventTimeStampMs < pendingType.eventTimeStampMs) {
      pendingType.eventTimeStampMs = eventTimeStampMs;
    }
    if (pendingType.handlerAtMs === null || handlerAtMs < pendingType.handlerAtMs) {
      pendingType.handlerAtMs = handlerAtMs;
      pendingType.lastRafAtMs = lastRafAtMs;
      pendingType.cycle = activeCycle;
    }
    scheduleFence();
    return true;
  };

  const beginCycle = (cycle) => {
    if (disposed) throw new Error("drawing input paint fence tracker is disposed");
    assertCycle(cycle);
    if (activeCycle !== null) {
      throw new Error(`drawing input paint fence cycle ${activeCycle} is already active`);
    }
    activeCycle = cycle;
    return true;
  };

  const endCycle = (cycle) => {
    if (disposed) throw new Error("drawing input paint fence tracker is disposed");
    assertCycle(cycle);
    if (activeCycle !== cycle) {
      throw new Error(
        `drawing input paint fence cycle mismatch: expected ${activeCycle}, received ${cycle}`,
      );
    }
    activeCycle = null;
    return true;
  };

  const dispose = () => {
    if (disposed) return false;
    markCohortDropped(pending);
    for (const frozen of frozenCohorts.values()) markCohortDropped(frozen.cohort);
    pending = makePendingCohort();
    frozenCohorts.clear();
    frameScheduled = false;
    activeCycle = null;
    disposed = true;
    epoch += 1;
    return true;
  };

  const snapshot = () => {
    const inputEventCounts = {};
    const inputPaintFenceStats = {};
    let inputEvents = 0;
    let completedEventCount = 0;
    let droppedEventCount = 0;
    let pendingEventCount = 0;
    let frozenEventCount = 0;
    let postRafInputCount = 0;
    let inputWhileFrozenCount = 0;
    let unattributedEventCount = 0;
    let unattributedFenceCount = 0;
    let allTypeCountsConserved = true;
    let typeFenceCount = 0;
    for (const type of eventTypes) {
      const stats = typeStats[type];
      const typePendingEventCount = pending.byType[type].eventCount;
      const typeFrozenEventCount = frozenEventCountForType(type);
      const countConservationPassed = stats.eventCount
        === stats.completedEventCount
          + stats.droppedEventCount
          + typePendingEventCount
          + typeFrozenEventCount
        && stats.coalescedEventCount === stats.completedEventCount - stats.fenceCount;
      const attributionCountsValid = stats.unattributedEventCount <= stats.eventCount
        && stats.unattributedFenceCount <= stats.fenceCount;
      inputEventCounts[type] = stats.eventCount;
      inputPaintFenceStats[type] = {
        eventCount: stats.eventCount,
        completedEventCount: stats.completedEventCount,
        droppedEventCount: stats.droppedEventCount,
        pendingEventCount: typePendingEventCount,
        frozenEventCount: typeFrozenEventCount,
        fenceCount: stats.fenceCount,
        coalescedEventCount: stats.coalescedEventCount,
        maxEventsPerFence: stats.maxEventsPerFence,
        postRafInputCount: stats.postRafInputCount,
        inputWhileFrozenCount: stats.inputWhileFrozenCount,
        unattributedEventCount: stats.unattributedEventCount,
        unattributedFenceCount: stats.unattributedFenceCount,
        countConservationPassed: countConservationPassed && attributionCountsValid,
      };
      inputEvents += stats.eventCount;
      completedEventCount += stats.completedEventCount;
      droppedEventCount += stats.droppedEventCount;
      pendingEventCount += typePendingEventCount;
      frozenEventCount += typeFrozenEventCount;
      postRafInputCount += stats.postRafInputCount;
      inputWhileFrozenCount += stats.inputWhileFrozenCount;
      unattributedEventCount += stats.unattributedEventCount;
      unattributedFenceCount += stats.unattributedFenceCount;
      typeFenceCount += stats.fenceCount;
      allTypeCountsConserved = allTypeCountsConserved
        && countConservationPassed
        && attributionCountsValid;
    }
    const slowCountConservationPassed = observedTypeFenceCount === typeFenceCount
      && observedTypeFenceCount === slowEntries.length
        + Math.max(0, observedTypeFenceCount - slowEntries.length);
    const overallCountConservationPassed = inputEvents === completedEventCount
        + droppedEventCount
        + pendingEventCount
        + frozenEventCount
      && allTypeCountsConserved
      && slowCountConservationPassed;
    const slowInputPostRafTaskFences = {
      schemaVersion: "drawing-input-post-raf-task/v2",
      endpoint: "post-rAF-task",
      timestampAggregation: "per-type-cohort-earliest-independent",
      rankingMetric: "conservativeTotalMs",
      capacity: topKCapacity,
      observedFenceCount: observedTypeFenceCount,
      retainedFenceCount: slowEntries.length,
      omittedFenceCount: Math.max(0, observedTypeFenceCount - slowEntries.length),
      performanceTimeOriginMs,
      countConservationPassed: slowCountConservationPassed,
      entries: slowEntries.map((entry) => ({ ...entry })),
    };
    const slowInputPaintFences = {
      ...slowInputPostRafTaskFences,
      legacyAlias: true,
      deprecated: true,
      canonicalProperty: "slowInputPostRafTaskFences",
      entries: slowInputPostRafTaskFences.entries.map((entry) => ({ ...entry })),
    };
    return {
      schemaVersion: "drawing-input-post-raf-task/v2",
      disposed,
      epoch,
      activeCycle,
      eventTypes: eventTypes.slice(),
      inputEvents,
      inputEventCounts,
      inputPaintFenceStats,
      overall: {
        eventCount: inputEvents,
        completedEventCount,
        droppedEventCount,
        pendingEventCount,
        frozenEventCount,
        fenceCount: overallFenceCount,
        typeFenceCount,
        postRafInputCount,
        inputWhileFrozenCount,
        unattributedEventCount,
        unattributedFenceCount,
        frameScheduled,
        frozenFenceCount: frozenCohorts.size,
        staleFrameCallbackCount,
        stalePostRafTaskCallbackCount,
        legacyAliases: {
          stalePostPaintCallbackCount: stalePostRafTaskCallbackCount,
        },
        countConservationPassed: overallCountConservationPassed,
      },
      slowInputPostRafTaskFences,
      slowInputPaintFences,
    };
  };

  return Object.freeze({
    recordInput,
    beginCycle,
    endCycle,
    dispose,
    snapshot,
  });
}
