const PHASE6_CURRENT_PAINT_ACTIONS = Object.freeze([
  "phase6-viewport",
  "phase6-worker-backpressure",
  "phase6-main-thread-fallback",
]);

export function phase6ActionRequiresCurrentPaint(action) {
  return PHASE6_CURRENT_PAINT_ACTIONS.includes(action);
}

/**
 * Phase 6 measurements begin only after the restored scene has published a
 * stable current plan. Non-freehand fixtures legitimately report zero raw and
 * rendered freehand points, so readiness must not depend on those gauges.
 */
export function phase6SceneReadiness(runtime, {
  expectedRawPoints = 0,
  requireWorker = false,
} = {}) {
  const expected = Number(expectedRawPoints);
  if (!runtime || typeof runtime !== "object"
    || !Number.isFinite(expected) || expected < 0) return false;
  const pointEvidenceReady = expected > 0
    ? Number(runtime.rawPoints) >= expected && Number(runtime.renderedPoints) > 0
    : true;
  return runtime.scenePublicationReady === true
    && runtime.attachedPrimitiveCount === 1
    && runtime.stampCurrent === true
    && pointEvidenceReady
    && (!requireWorker || runtime.backend === "worker")
    && Number(runtime.queueDepthCurrent) === 0
    && Number(runtime.inFlightCurrent) === 0;
}

/**
 * Wait for a viewport action to advance past its pre-action revision and for
 * the exact current plan to reach the visible canvas. Keeping this orchestration
 * outside the serialized browser bootstrap makes the runner's fail-closed
 * behavior directly unit-testable.
 */
export async function waitForPhase6ActionCurrentPaint({
  action,
  previousStamp,
  timeoutMs,
  waitForCurrentPaint,
}) {
  if (!phase6ActionRequiresCurrentPaint(action)) {
    return Object.freeze({ required: false, result: null });
  }
  if (!previousStamp || typeof previousStamp !== "object") {
    throw new Error(`Phase 6 ${action} current-paint baseline stamp is missing`);
  }
  if (typeof waitForCurrentPaint !== "function") {
    throw new Error(`Phase 6 ${action} current-paint probe is unavailable`);
  }
  const safeTimeoutMs = Math.min(
    10_000,
    Math.max(0, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 5_000),
  );
  const result = await waitForCurrentPaint(previousStamp, safeTimeoutMs);
  if (result?.passed !== true) {
    throw new Error(`Phase 6 ${action} did not reach a quiescent current paint: ${JSON.stringify(result)}`);
  }
  return Object.freeze({ required: true, result });
}

/**
 * Installed in the benchmark page through CDP. Keep this function completely
 * self-contained: drawing-performance.mjs serializes it with toString().
 */
export function phase6BrowserProbeBootstrap() {
  window.__CANDLESCOPE_PHASE6_PROBE__?.stop?.();
  const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
  if (!drawingHandle?.report) {
    return { started: false, reason: "drawing-perf-handle-missing" };
  }

  const finite = (value) => {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const nonNegative = (value) => {
    const number = finite(value);
    return number !== null && number >= 0 ? number : null;
  };
  const safeClone = (value) => {
    if (value == null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  };
  const valueAt = (record, names) => {
    if (!record || typeof record !== "object") return undefined;
    for (const name of names) {
      if (record[name] !== undefined) return record[name];
    }
    return undefined;
  };
  const numericAt = (record, names) => nonNegative(valueAt(record, names));
  const counterDelta = (current, baseline) => (
    current !== null && baseline !== null && current >= baseline
      ? current - baseline
      : null
  );
  const sameJson = (left, right) => {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  };
  const sameStamp = (left, right) => {
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const keys = [
      "scopeKey",
      "documentRevision",
      "surfaceGeneration",
      "dataRevision",
      "projectionRevision",
      "lineageIndexRevision",
      "viewportRevision",
      "themeRevision",
      "widthCssPx",
      "heightCssPx",
      "dpr",
    ];
    return keys.every((key) => left[key] === right[key]);
  };
  const readRaw = () => {
    const report = drawingHandle.report?.() || {};
    const runtimeSummary = drawingHandle.readRuntimeSummary?.() || null;
    let phase6 = null;
    try {
      phase6 = drawingHandle.readPhase6Runtime?.() || null;
    } catch {
      phase6 = null;
    }
    phase6 ??= runtimeSummary?.phase6
      ?? runtimeSummary?.workerRuntime
      ?? runtimeSummary?.drawingWorker
      ?? null;
    return {
      report,
      runtimeSummary,
      phase6,
    };
  };
  const readCounters = (raw) => {
    const counters = raw?.report?.counters || {};
    const maxima = raw?.report?.counterMaxima || {};
    const gauges = raw?.report?.gauges || {};
    const gaugeMaxima = raw?.report?.gaugeMaxima || {};
    const counter = (name) => numericAt(counters, [name]);
    const counterMaximum = (name) => numericAt(maxima, [name]);
    const gauge = (name) => numericAt(gauges, [name]);
    const gaugeMaximum = (name) => numericAt(gaugeMaxima, [name]);
    return {
      workerJobs: counter("workerJobCount"),
      workerResults: counter("workerResultCount"),
      pendingDrops: counter("workerQueueDropCount"),
      staleResultDrops: counter("staleWorkerResultCount"),
      stalePublishes: counter("staleWorkerPublishCount"),
      anchorResolves: counter("anchorResolveCount"),
      finalProjections: counter("finalProjectionCount"),
      workerJobsMax: counterMaximum("workerJobCount"),
      workerResultsMax: counterMaximum("workerResultCount"),
      queueDepth: gauge("workerQueue"),
      queueDepthMax: gaugeMaximum("workerQueue"),
      inFlight: gauge("workerInFlight"),
      inFlightMax: gaugeMaximum("workerInFlight"),
      rawPoints: gauge("rawPoints"),
      rawPointsMax: gaugeMaximum("rawPoints"),
      renderedPoints: gauge("renderedPoints"),
      renderedPointsMax: gaugeMaximum("renderedPoints"),
      lodRatio: gauge("lodRatio"),
      cacheBytes: gauge("cacheBytes"),
      cacheBytesMax: gaugeMaximum("cacheBytes"),
    };
  };
  const initialRaw = readRaw();
  const initialPhase6 = safeClone(initialRaw.phase6) || {};
  const initialCounters = readCounters(initialRaw);
  const config = window.__CANDLESCOPE_DRAWING_PERF_CONFIG__ || {};
  const fallbackRequested = config.phase6ForceMainThreadFallback === true;
  const backpressureDelayMs = nonNegative(config.phase6WorkerDelayMs) ?? 0;
  let hitOracle = null;
  let stopped = false;

  const normalizeRuntime = (finalRaw, finalCounters) => {
    const phase6 = finalRaw.phase6 || {};
    const summary = finalRaw.runtimeSummary || {};
    const chooseMaximum = (...values) => {
      const numbers = values.map(nonNegative).filter((value) => value !== null);
      return numbers.length > 0 ? Math.max(...numbers) : null;
    };
    const chooseNumber = (...values) => {
      for (const value of values) {
        const number = nonNegative(value);
        if (number !== null) return number;
      }
      return null;
    };
    const readLodObservation = (runtime, counters) => {
      const runtimeObservation = {
        rawPoints: nonNegative(valueAt(runtime, ["rawPoints"])),
        renderedPoints: nonNegative(valueAt(runtime, ["renderedPoints"])),
        lodRatio: nonNegative(valueAt(runtime, ["lodRatio", "currentLodRatio"])),
      };
      if (Object.values(runtimeObservation).every((value) => value !== null)) {
        return runtimeObservation;
      }
      const counterObservation = {
        rawPoints: nonNegative(counters.rawPoints),
        renderedPoints: nonNegative(counters.renderedPoints),
        lodRatio: nonNegative(counters.lodRatio),
      };
      return Object.values(counterObservation).every((value) => value !== null)
        ? counterObservation
        : null;
    };
    const aggregateInvariant = (...values) => {
      if (!values.every((value) => typeof value === "boolean")) return null;
      return values.every((value) => value === true);
    };
    const backendValue = valueAt(phase6, ["backend", "rasterBackend", "effectiveBackend"]);
    const backend = backendValue === "worker" || backendValue === "main-thread"
      ? backendValue
      : null;
    const backendSource = valueAt(phase6, ["backendSource"])
      ?? valueAt(initialPhase6, ["backendSource"])
      ?? null;
    const stalePublishRuntime = chooseNumber(
      valueAt(phase6, ["stalePublishCount", "staleWorkerPublishCount"]),
    );
    const stalePublishDelta = counterDelta(
      finalCounters.stalePublishes,
      initialCounters.stalePublishes,
    ) ?? stalePublishRuntime;
    const initialSceneFallbackCount = chooseNumber(
      valueAt(initialPhase6, ["sceneFallbackCount"]),
    );
    const sceneFallbackCount = chooseNumber(valueAt(phase6, ["sceneFallbackCount"]));
    const sceneRuntimeFaultCount = chooseNumber(
      valueAt(phase6, ["sceneRuntimeFaultCount"]),
      sceneFallbackCount,
    );
    const sceneFallbackDelta = counterDelta(sceneFallbackCount, initialSceneFallbackCount);
    const initialLodObservation = readLodObservation(initialPhase6, initialCounters);
    const finalLodObservation = readLodObservation(phase6, finalCounters);
    // Keep raw/rendered/ratio from one accepted plan. Prefer the observation
    // with the largest canonical geometry and prefer final on ties so a
    // regressed post-action heavy plan cannot hide behind the initial plan.
    const lodObservation = [
      initialLodObservation && { phase: "initial", ...initialLodObservation },
      finalLodObservation && { phase: "final", ...finalLodObservation },
    ].filter(Boolean).reduce((selected, candidate) => (
      selected === null || candidate.rawPoints >= selected.rawPoints ? candidate : selected
    ), null);
    return {
      engineMode: valueAt(phase6, ["engineMode"])
        ?? summary.effectiveEngineMode
        ?? null,
      scenePublicationReady: valueAt(phase6, ["scenePublicationReady", "publicationReady"])
        ?? summary.scenePublicationReady
        ?? null,
      attachedPrimitiveCount: chooseNumber(
        valueAt(phase6, ["attachedPrimitiveCount", "primitiveCount"]),
        summary.attachedPrimitiveCount,
      ),
      backend,
      backendSource: typeof backendSource === "string" ? backendSource : null,
      workerResultDelayMs: chooseNumber(
        valueAt(phase6, ["workerResultDelayMs"]),
        valueAt(initialPhase6, ["workerResultDelayMs"]),
      ),
      sourceLineageExactResolveCount: chooseMaximum(
        valueAt(phase6, ["sourceLineageExactResolveCount"]),
        valueAt(initialPhase6, ["sourceLineageExactResolveCount"]),
      ),
      sourceLineageFallbackResolveCount: chooseMaximum(
        valueAt(phase6, ["sourceLineageFallbackResolveCount"]),
        valueAt(initialPhase6, ["sourceLineageFallbackResolveCount"]),
      ),
      sourceLineageUnresolvedResolveCount: chooseMaximum(
        valueAt(phase6, ["sourceLineageUnresolvedResolveCount"]),
        valueAt(initialPhase6, ["sourceLineageUnresolvedResolveCount"]),
      ),
      offscreenSupported: typeof valueAt(phase6, ["offscreenSupported"]) === "boolean"
        ? valueAt(phase6, ["offscreenSupported"])
        : null,
      queueDepthMax: chooseMaximum(
        valueAt(phase6, ["queueDepthMax", "workerQueueDepthMax"]),
        finalCounters.queueDepthMax,
        finalCounters.queueDepth,
      ),
      inFlightMax: chooseMaximum(
        valueAt(phase6, ["inFlightMax", "workerInFlightMax"]),
        finalCounters.inFlightMax,
        finalCounters.inFlight,
      ),
      queueDepthCurrent: chooseNumber(
        valueAt(phase6, ["queueDepthCurrent", "workerQueueDepthCurrent"]),
        finalCounters.queueDepth,
      ),
      inFlightCurrent: chooseNumber(
        valueAt(phase6, ["inFlightCurrent", "workerInFlightCurrent"]),
        finalCounters.inFlight,
      ),
      workerJobDelta: counterDelta(finalCounters.workerJobs, initialCounters.workerJobs)
        ?? chooseNumber(valueAt(phase6, ["workerJobDelta", "jobs"])),
      workerResultDelta: counterDelta(finalCounters.workerResults, initialCounters.workerResults)
        ?? chooseNumber(valueAt(phase6, ["workerResultDelta", "results"])),
      pendingDropDelta: counterDelta(finalCounters.pendingDrops, initialCounters.pendingDrops)
        ?? chooseNumber(valueAt(phase6, ["pendingDropDelta", "pendingDrops", "queueDrops"])),
      staleResultDropDelta: counterDelta(
        finalCounters.staleResultDrops,
        initialCounters.staleResultDrops,
      ) ?? chooseNumber(valueAt(phase6, ["staleResultDropDelta", "staleResultDrops"])),
      stalePublishDelta,
      stalePublishCount: stalePublishRuntime,
      sceneFallbackCount,
      sceneRuntimeFaultCount,
      legacyFallbackSucceededCount: chooseNumber(
        valueAt(phase6, ["legacyFallbackSucceededCount"]),
      ),
      sceneFallbackDelta,
      sceneFallbackLastReason: sceneFallbackCount !== null && sceneFallbackCount > 0
        && typeof valueAt(phase6, ["sceneFallbackLastReason"]) === "string"
        ? valueAt(phase6, ["sceneFallbackLastReason"])
        : null,
      rawPointsMax: lodObservation?.rawPoints ?? null,
      renderedPointsMax: lodObservation?.renderedPoints ?? null,
      lodRatio: lodObservation?.lodRatio ?? null,
      lodObservationPhase: lodObservation?.phase ?? null,
      initialRawPoints: initialLodObservation?.rawPoints ?? null,
      initialRenderedPoints: initialLodObservation?.renderedPoints ?? null,
      initialLodRatio: initialLodObservation?.lodRatio ?? null,
      finalRawPoints: finalLodObservation?.rawPoints ?? null,
      finalRenderedPoints: finalLodObservation?.renderedPoints ?? null,
      finalLodRatio: finalLodObservation?.lodRatio ?? null,
      canonicalRawPreserved: aggregateInvariant(
        valueAt(initialPhase6, ["canonicalRawPreserved"]),
        valueAt(phase6, ["canonicalRawPreserved"]),
      ),
      vertexBudgetPassed: aggregateInvariant(
        valueAt(initialPhase6, ["vertexBudgetPassed"]),
        valueAt(phase6, ["vertexBudgetPassed"]),
      ),
      anchorResolveDelta: counterDelta(
        finalCounters.anchorResolves,
        initialCounters.anchorResolves,
      ),
      finalProjectionDelta: counterDelta(
        finalCounters.finalProjections,
        initialCounters.finalProjections,
      ),
      cacheBytes: chooseNumber(
        valueAt(phase6, ["cacheBytes"]),
        finalCounters.cacheBytes,
      ),
      cacheBytesMax: chooseMaximum(
        valueAt(phase6, ["cacheBytesMax"]),
        finalCounters.cacheBytesMax,
      ),
      cacheBudgetBytes: chooseNumber(valueAt(phase6, ["cacheBudgetBytes"])),
      cacheHardLimitBytes: chooseNumber(valueAt(phase6, ["cacheHardLimitBytes"])),
      cacheEntryCount: chooseNumber(valueAt(phase6, ["cacheEntryCount"])),
      cacheBudgetEvictionCount: chooseNumber(
        valueAt(phase6, ["cacheBudgetEvictionCount"]),
      ),
      cacheEntryBytes: chooseNumber(valueAt(phase6, ["cacheEntryBytes"])),
      cacheEntryBudgetBytes: chooseNumber(valueAt(phase6, ["cacheEntryBudgetBytes"])),
      cacheMetadataBytes: chooseNumber(valueAt(phase6, ["cacheMetadataBytes"])),
      cacheMetadataBudgetBytes: chooseNumber(valueAt(phase6, ["cacheMetadataBudgetBytes"])),
      cacheRecentHierarchyKeyCount: chooseNumber(
        valueAt(phase6, ["cacheRecentHierarchyKeyCount"]),
      ),
      cacheRecentHierarchyKeysPerRequestLimit: chooseNumber(
        valueAt(phase6, ["cacheRecentHierarchyKeysPerRequestLimit"]),
      ),
      cacheRecentRequestCount: chooseNumber(valueAt(phase6, ["cacheRecentRequestCount"])),
      cacheRecentRequestLimit: chooseNumber(valueAt(phase6, ["cacheRecentRequestLimit"])),
      lastRequestedStamp: safeClone(valueAt(phase6, ["lastRequestedStamp", "requestedStamp"])),
      lastPublishedStamp: safeClone(valueAt(phase6, ["lastPublishedStamp", "publishedStamp"])),
      lastPaintedStamp: safeClone(valueAt(
        phase6,
        ["lastPaintedStamp", "paintedStamp", "lastPublishedStamp", "publishedStamp"],
      )),
    };
  };

  const controller = {
    async waitForCurrentPaint(previousStamp, timeoutMs = 5_000) {
      const safeTimeoutMs = Math.max(0, nonNegative(timeoutMs) ?? 5_000);
      const deadline = performance.now() + safeTimeoutMs;
      let runtime = null;
      do {
        const raw = readRaw();
        runtime = normalizeRuntime(raw, readCounters(raw));
        const requestedStamp = runtime.lastRequestedStamp;
        const paintedStamp = runtime.lastPaintedStamp;
        const advanced = previousStamp == null || !sameStamp(requestedStamp, previousStamp);
        if (advanced && sameStamp(requestedStamp, paintedStamp)) {
          return {
            passed: true,
            previousStamp: safeClone(previousStamp),
            requestedStamp: safeClone(requestedStamp),
            paintedStamp: safeClone(paintedStamp),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      } while (performance.now() <= deadline);
      return {
        passed: false,
        previousStamp: safeClone(previousStamp),
        requestedStamp: safeClone(runtime?.lastRequestedStamp),
        paintedStamp: safeClone(runtime?.lastPaintedStamp),
        reason: "phase6-current-plan-paint-timeout",
      };
    },
    async runHitOracle(points) {
      const safePoints = Array.isArray(points)
        ? points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
          .slice(0, 1_000)
          .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
        : [];
      const external = window.__CANDLESCOPE_DRAWING_PHASE6__;
      const provider = typeof drawingHandle.runPhase6HitOracle === "function"
        ? drawingHandle.runPhase6HitOracle.bind(drawingHandle)
        : typeof external?.runHitOracle === "function"
          ? external.runHitOracle.bind(external)
          : null;
      if (!provider) {
        hitOracle = {
          supported: false,
          queryCount: 0,
          mismatchCount: null,
          positiveHitCount: 0,
          candidateCoverageCount: 0,
          maxCandidates: null,
          totalSegments: null,
          reason: "phase6-hit-oracle-provider-missing",
          queriedStamp: null,
          paintedStamp: null,
          currentPainted: false,
        };
        return safeClone(hitOracle);
      }
      try {
        const queryRaw = readRaw();
        const queryRuntime = normalizeRuntime(queryRaw, readCounters(queryRaw));
        const queriedStamp = safeClone(queryRuntime.lastRequestedStamp);
        const paintedStamp = safeClone(queryRuntime.lastPaintedStamp);
        const currentPainted = sameStamp(queriedStamp, paintedStamp);
        const result = await provider(safePoints);
        const indexedResults = Array.isArray(result?.indexedResults)
          ? result.indexedResults
          : null;
        const oracleResults = Array.isArray(result?.oracleResults)
          ? result.oracleResults
          : null;
        let derivedMismatchCount = null;
        if (indexedResults && oracleResults
          && indexedResults.length === safePoints.length
          && oracleResults.length === safePoints.length) {
          derivedMismatchCount = indexedResults.reduce(
            (count, value, index) => count + (sameJson(value, oracleResults[index]) ? 0 : 1),
            0,
          );
        }
        const positiveHitCount = indexedResults
          ? indexedResults.reduce((count, value) => count + (value == null ? 0 : 1), 0)
          : nonNegative(result?.positiveHitCount);
        const maxCandidates = nonNegative(result?.maxCandidates);
        // The production oracle currently reports the peak candidate count,
        // not a per-query candidate vector. A positive peak still proves that
        // at least one query exercised the index candidate path. Preserve an
        // exact provider count when a future runtime exposes one.
        const candidateCoverageCount = nonNegative(result?.candidateCoverageCount)
          ?? (maxCandidates !== null && maxCandidates > 0 ? 1 : 0);
        hitOracle = {
          supported: true,
          queryCount: nonNegative(result?.queryCount)
            ?? indexedResults?.length
            ?? 0,
          mismatchCount: derivedMismatchCount
            ?? nonNegative(result?.mismatchCount),
          positiveHitCount,
          candidateCoverageCount,
          maxCandidates,
          totalSegments: nonNegative(result?.totalSegments),
          indexedResultCount: indexedResults?.length ?? null,
          oracleResultCount: oracleResults?.length ?? null,
          queriedStamp,
          paintedStamp,
          currentPainted,
        };
      } catch (error) {
        hitOracle = {
          supported: true,
          queryCount: 0,
          mismatchCount: null,
          positiveHitCount: 0,
          candidateCoverageCount: 0,
          maxCandidates: null,
          totalSegments: null,
          error: error instanceof Error ? error.message : String(error),
          queriedStamp: null,
          paintedStamp: null,
          currentPainted: false,
        };
      }
      return safeClone(hitOracle);
    },
    snapshot() {
      const finalRaw = readRaw();
      const finalCounters = readCounters(finalRaw);
      return {
        started: true,
        fallbackRequested,
        backpressureDelayMs,
        runtime: normalizeRuntime(finalRaw, finalCounters),
        hitOracle: safeClone(hitOracle),
      };
    },
    stop() {
      if (stopped) return controller.snapshot();
      stopped = true;
      return controller.snapshot();
    },
  };
  window.__CANDLESCOPE_PHASE6_PROBE__ = controller;
  return {
    started: true,
    fallbackRequested,
    backpressureDelayMs,
    initialRuntimeSummary: safeClone(initialRaw.runtimeSummary),
  };
}
