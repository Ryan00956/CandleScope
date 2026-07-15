export const PHASE7_DATABASE_NAME = "candlescope-drawings-v2";
export const PHASE7_DATABASE_VERSION = 1;
export const PHASE7_STORE_NAME = "documents";
export const PHASE7_ENTITY_COUNT = 512;
export const PHASE7_MIN_RUNS = 5;

export const PHASE7_BUDGETS = Object.freeze({
  restoreChunkMaxMs: 16,
  persistenceP95Ms: 500,
  attributableLongTaskCount: 0,
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeSamples(value) {
  return Array.isArray(value)
    ? value.map(finiteNonNegative).filter((sample) => sample !== null)
    : [];
}

export function nearestRankPercentile(values, percentile) {
  const samples = safeSamples(values).sort((left, right) => left - right);
  if (samples.length === 0) return null;
  const bounded = Math.max(0, Math.min(100, Number(percentile) || 0));
  const rank = Math.max(1, Math.ceil((bounded / 100) * samples.length));
  return samples[rank - 1] ?? null;
}

function recordEntity(savedDrawing) {
  if (!savedDrawing || typeof savedDrawing !== "object" || typeof savedDrawing.id !== "string") {
    throw new TypeError("Phase 7 fixture drawing is invalid");
  }

  let geometry;
  let style;
  if (savedDrawing.type === "line") {
    geometry = {
      kind: "line",
      ...(savedDrawing.lineType === undefined ? {} : { lineType: savedDrawing.lineType }),
      ...(savedDrawing.dataPoints === undefined ? {} : { dataPoints: savedDrawing.dataPoints }),
    };
    style = {
      kind: "line",
      ...(savedDrawing.color === undefined ? {} : { color: savedDrawing.color }),
      ...(savedDrawing.lineWidth === undefined ? {} : { lineWidth: savedDrawing.lineWidth }),
    };
  } else if (savedDrawing.type === "shape") {
    geometry = {
      kind: "shape",
      ...(savedDrawing.shapeType === undefined ? {} : { shapeType: savedDrawing.shapeType }),
      ...(savedDrawing.dataPoints === undefined ? {} : { dataPoints: savedDrawing.dataPoints }),
    };
    style = {
      kind: "shape",
      ...(savedDrawing.color === undefined ? {} : { color: savedDrawing.color }),
      ...(savedDrawing.lineWidth === undefined ? {} : { lineWidth: savedDrawing.lineWidth }),
      ...(savedDrawing.fillColor === undefined ? {} : { fillColor: savedDrawing.fillColor }),
      ...(savedDrawing.fillOpacity === undefined ? {} : { fillOpacity: savedDrawing.fillOpacity }),
      ...(savedDrawing.lineStyle === undefined ? {} : { lineStyle: savedDrawing.lineStyle }),
    };
  } else {
    throw new TypeError(`Phase 7 fixture does not support drawing type ${savedDrawing.type}`);
  }

  return Object.freeze({
    id: savedDrawing.id,
    kind: savedDrawing.type,
    geometryRevision: 1,
    styleRevision: 1,
    geometry: Object.freeze(geometry),
    style: Object.freeze(style),
    bounds: Object.freeze({ kind: "deferred" }),
  });
}

/**
 * Convert the deterministic 512 line/shape SavedDrawing fixture into the
 * production v2 IndexedDB record shape. This intentionally supports only the
 * fixture's two kinds so schema drift fails closed instead of being hidden by
 * a permissive benchmark codec.
 */
export function buildPhase7V2Record(scopeKey, savedDrawings, updatedAt = Date.now()) {
  if (typeof scopeKey !== "string" || scopeKey.length === 0) {
    throw new TypeError("Phase 7 scope key is required");
  }
  if (!Array.isArray(savedDrawings) || savedDrawings.length !== PHASE7_ENTITY_COUNT) {
    throw new RangeError(`Phase 7 fixture must contain exactly ${PHASE7_ENTITY_COUNT} drawings`);
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new TypeError("Phase 7 fixture timestamp is invalid");
  }
  const entities = savedDrawings.map(recordEntity);
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) {
    throw new TypeError("Phase 7 fixture contains duplicate drawing ids");
  }
  return Object.freeze({
    documentSchemaVersion: 1,
    scopeKey,
    documentRevision: 0,
    updatedAt,
    entities: Object.freeze(entities),
  });
}

/** Installed before application modules execute through Page.addScriptToEvaluateOnNewDocument. */
export function phase7BrowserProbeBootstrap(payload) {
  window.__CANDLESCOPE_DRAWING_PERF_CONFIG__ = Object.freeze({
    benchmarkRawCapture: true,
    rawCaptureCapacity: 20_000,
  });

  const manifestKey = String(payload?.manifestKey || "");
  const state = {
    storageReads: [],
    longTasks: [],
    windows: {},
    longTaskSupported: false,
  };
  const now = () => performance.now();
  const beginWindow = (name) => {
    const key = String(name || "");
    if (!key) return false;
    const current = state.windows[key];
    if (!current || current.endTime !== null) {
      state.windows[key] = { startTime: now(), endTime: null };
    }
    return true;
  };
  const endWindow = (name) => {
    const key = String(name || "");
    const current = state.windows[key];
    if (!current) return false;
    if (current.endTime === null) current.endTime = now();
    return true;
  };

  try {
    const nativeGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function phase7ObservedStorageRead(key) {
      const normalized = String(key);
      state.storageReads.push(normalized);
      if (state.storageReads.length > 2_000) state.storageReads.shift();
      if (manifestKey && normalized === manifestKey && !state.windows.restore) {
        beginWindow("restore");
      }
      return nativeGetItem.call(this, key);
    };
  } catch {
    // The acceptance report records missing manifest-read evidence explicitly.
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          attribution: Array.from(entry.attribution || [], (item) => ({
            name: item.name || null,
            containerName: item.containerName || null,
            containerType: item.containerType || null,
            containerSrc: item.containerSrc || null,
          })),
        });
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    state.longTaskSupported = true;
  } catch {
    state.longTaskSupported = false;
  }

  const report = () => ({
    storageReads: state.storageReads.slice(),
    longTasks: state.longTasks.map((entry) => ({ ...entry })),
    windows: Object.fromEntries(Object.entries(state.windows).map(([key, value]) => [
      key,
      { ...value },
    ])),
    longTaskSupported: state.longTaskSupported,
  });
  window.__CANDLESCOPE_PHASE7_PROBE__ = Object.freeze({
    beginWindow,
    endWindow,
    report,
  });
}

/** Serialized into the application page by the standalone CLI. */
export async function phase7SeedNativeIndexedDb(payload) {
  const databaseName = String(payload.databaseName);
  const storeName = String(payload.storeName);
  const databaseVersion = Number(payload.databaseVersion);
  const record = payload.record;

  localStorage.setItem("candlescope-settings", JSON.stringify({ chartType: "candlestick" }));
  localStorage.setItem("candlescope-user-prefs", JSON.stringify({
    lastExchange: "binance",
    lastMarketType: "spot",
    lastSymbol: "BTCUSDT",
    lastInterval: "1h",
  }));
  localStorage.setItem("candlescope-active-indicators", "[]");
  localStorage.setItem("candlescope-vol-initialized", "1");
  localStorage.removeItem(String(payload.manifestKey));
  localStorage.removeItem(String(payload.legacyKey));

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "scopeKey" });
      }
    };
    request.onerror = () => reject(request.error || new Error("Phase 7 IndexedDB open failed"));
    request.onblocked = () => reject(new Error("Phase 7 IndexedDB open was blocked"));
    request.onsuccess = () => resolve(request.result);
  });

  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error || new Error("Phase 7 IndexedDB seed failed"),
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Phase 7 IndexedDB seed aborted"),
      );
    });
    const stored = await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(record.scopeKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Phase 7 IndexedDB verify failed"));
    });
    return {
      nativeIndexedDb: typeof IDBFactory !== "undefined" && indexedDB instanceof IDBFactory,
      databaseName: database.name,
      databaseVersion: database.version,
      storeName,
      scopeKey: stored?.scopeKey ?? null,
      entityCount: Array.isArray(stored?.entities) ? stored.entities.length : null,
    };
  } finally {
    database.close();
  }
}

function runMetricSamples(run, metric) {
  return safeSamples(run?.metrics?.[metric]?.samples);
}

function validHeadedEvidence(run) {
  return run?.browser?.headed === true
    && run?.browser?.windowState === "normal"
    && run?.browser?.visibilityState === "visible"
    && run?.browser?.hidden === false;
}

export function buildPhase7Acceptance(report, options = {}) {
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const minimumRuns = Number.isSafeInteger(options.minimumRuns)
    ? Math.max(1, options.minimumRuns)
    : PHASE7_MIN_RUNS;
  const restoreSamples = runs.flatMap((run) => runMetricSamples(run, "restoreChunkMs"));
  const persistenceSamples = runs.flatMap((run) => runMetricSamples(run, "persistenceMs"));
  const restoreChunkMaxMs = restoreSamples.length > 0 ? Math.max(...restoreSamples) : null;
  const persistenceP95Ms = nearestRankPercentile(persistenceSamples, 95);
  const attributableLongTaskCount = runs.reduce(
    (sum, run) => sum + (finiteNonNegative(run?.longTasks?.attributableCount) ?? 0),
    0,
  );

  const runCoveragePassed = runs.length >= minimumRuns;
  const headedPassed = runCoveragePassed && runs.every(validHeadedEvidence);
  const indexedDbPassed = runCoveragePassed && runs.every((run) => (
    run?.seed?.nativeIndexedDb === true
    && run.seed.databaseName === PHASE7_DATABASE_NAME
    && run.seed.storeName === PHASE7_STORE_NAME
    && run.seed.entityCount === PHASE7_ENTITY_COUNT
  ));
  const restoreEntityCountPassed = runCoveragePassed && runs.every((run) => (
    run?.restore?.entityCount === PHASE7_ENTITY_COUNT
  ));
  const sceneEntityCountPassed = runCoveragePassed && runs.every((run) => (
    run?.restore?.sceneEntityCount === PHASE7_ENTITY_COUNT
  ));
  const manifestRepairPassed = runCoveragePassed && runs.every((run) => (
    run?.restore?.manifest?.count === PHASE7_ENTITY_COUNT
    && run.restore.manifest.scopeKey === run.seed.scopeKey
  ));
  const legacyBypassPassed = runCoveragePassed && runs.every((run) => (
    run?.restore?.legacyStorageRead === false
  ));
  const restoreMetricCoveragePassed = restoreSamples.length >= runs.length;
  const restoreBudgetPassed = restoreMetricCoveragePassed
    && restoreChunkMaxMs !== null
    && restoreChunkMaxMs <= PHASE7_BUDGETS.restoreChunkMaxMs;
  const persistenceMetricCoveragePassed = persistenceSamples.length >= runs.length;
  const persistenceBudgetPassed = persistenceMetricCoveragePassed
    && persistenceP95Ms !== null
    && persistenceP95Ms <= PHASE7_BUDGETS.persistenceP95Ms;
  const longTaskWindowCoveragePassed = runCoveragePassed && runs.every((run) => (
    Number(run?.longTasks?.windowCount) >= 2
  ));
  const longTaskInstrumentationPassed = longTaskWindowCoveragePassed && runs.every((run) => (
    run?.longTasks?.observerSupported === true
  ));
  const attributableLongTaskPassed = longTaskInstrumentationPassed
    && attributableLongTaskCount === PHASE7_BUDGETS.attributableLongTaskCount;

  const passed = runCoveragePassed
    && headedPassed
    && indexedDbPassed
    && restoreEntityCountPassed
    && sceneEntityCountPassed
    && manifestRepairPassed
    && legacyBypassPassed
    && restoreBudgetPassed
    && persistenceBudgetPassed
    && attributableLongTaskPassed;
  const failureReasons = [];
  if (!runCoveragePassed) failureReasons.push("phase7-run-coverage-incomplete");
  if (!headedPassed) failureReasons.push("phase7-headed-visible-window-required");
  if (!indexedDbPassed) failureReasons.push("phase7-native-indexeddb-fixture-invalid");
  if (!restoreEntityCountPassed) failureReasons.push("phase7-512-entity-restore-failed");
  if (!sceneEntityCountPassed) failureReasons.push("phase7-scene-entity-count-mismatch");
  if (!manifestRepairPassed) failureReasons.push("phase7-manifest-repair-failed");
  if (!legacyBypassPassed) failureReasons.push("phase7-v2-restore-read-legacy-storage");
  if (!restoreMetricCoveragePassed) failureReasons.push("phase7-restore-chunk-metric-missing");
  else if (!restoreBudgetPassed) failureReasons.push("phase7-restore-chunk-budget-exceeded");
  if (!persistenceMetricCoveragePassed) failureReasons.push("phase7-persistence-metric-missing");
  else if (!persistenceBudgetPassed) failureReasons.push("phase7-persistence-p95-budget-exceeded");
  if (!longTaskWindowCoveragePassed) failureReasons.push("phase7-long-task-window-coverage-missing");
  else if (!longTaskInstrumentationPassed) failureReasons.push("phase7-long-task-observer-unavailable");
  else if (!attributableLongTaskPassed) failureReasons.push("phase7-attributable-long-task-detected");

  return Object.freeze({
    passed,
    runCount: runs.length,
    minimumRuns,
    runCoveragePassed,
    headedPassed,
    indexedDbPassed,
    restoreEntityCountPassed,
    sceneEntityCountPassed,
    manifestRepairPassed,
    legacyBypassPassed,
    restoreMetricCoveragePassed,
    restoreChunkSampleCount: restoreSamples.length,
    restoreChunkMaxMs,
    restoreBudgetPassed,
    persistenceMetricCoveragePassed,
    persistenceSampleCount: persistenceSamples.length,
    persistenceP95Ms,
    persistenceBudgetPassed,
    longTaskWindowCoveragePassed,
    longTaskInstrumentationPassed,
    attributableLongTaskCount,
    attributableLongTaskPassed,
    failureReasons: Object.freeze(failureReasons),
  });
}
