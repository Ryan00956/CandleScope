import crypto from "node:crypto";

const DRAWING_RENDER_STAMP_KEYS = Object.freeze([
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
]);

const CONFIGURED_WORKER_REQUEST = Object.freeze({
  engineMode: "scene-canary",
  backend: "worker",
  engineModeSource: "environment",
  backendSource: "environment",
});

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

function sameStamp(left, right) {
  return left && right && DRAWING_RENDER_STAMP_KEYS.every((key) => left[key] === right[key]);
}

function runtimeCurrent(runtime) {
  return runtime
    && runtime.queueDepthCurrent === 0
    && runtime.inFlightCurrent === 0
    && sameStamp(runtime.lastRequestedStamp, runtime.lastPublishedStamp)
    && sameStamp(runtime.lastPublishedStamp, runtime.lastPaintedStamp)
    && runtime.paintReceipt?.kind === "drawing-scene-bridge-paint-ack"
    && sameStamp(runtime.paintReceipt.stamp, runtime.lastPaintedStamp)
    && Number.isSafeInteger(runtime.paintReceipt.paintSequence)
    && runtime.paintReceipt.paintSequence > 0;
}

function runtimeSignature(bundle) {
  const runtime = bundle?.runtime;
  return JSON.stringify({
    workerJobDelta: runtime?.workerJobDelta,
    workerResultDelta: runtime?.workerResultDelta,
    pendingDropDelta: runtime?.pendingDropDelta,
    staleResultDropDelta: runtime?.staleResultDropDelta,
    queueDepthCurrent: runtime?.queueDepthCurrent,
    inFlightCurrent: runtime?.inFlightCurrent,
    lastRequestedStamp: runtime?.lastRequestedStamp,
    lastPublishedStamp: runtime?.lastPublishedStamp,
    lastPaintedStamp: runtime?.lastPaintedStamp,
    paintSequence: runtime?.paintReceipt?.paintSequence,
    latestSubmittedWorkerIdentity: runtime?.latestSubmittedWorkerIdentity,
    returnedWorkerIdentity: runtime?.returnedWorkerIdentity,
    acceptedWorkerIdentity: runtime?.acceptedWorkerIdentity,
    publishedWorkerIdentity: runtime?.publishedWorkerIdentity,
  });
}

async function waitForSample(
  reader,
  predicate,
  { timeoutMs, description, stableMs = 0, signature = null },
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableSince = null;
  let stableSignature = null;
  let attempts = 0;
  while (Date.now() <= deadline) {
    attempts += 1;
    last = await reader();
    if (predicate(last)) {
      const nextSignature = signature ? signature(last) : "accepted";
      if (stableSince === null || nextSignature !== stableSignature) {
        stableSince = Date.now();
        stableSignature = nextSignature;
      }
      if (Date.now() - stableSince >= stableMs) {
        return Object.freeze({ value: last, attempts, stableMs, observedAt: new Date().toISOString() });
      }
    } else {
      stableSince = null;
      stableSignature = null;
    }
    await wait(40);
  }
  throw new Error(`${description} timed out: ${JSON.stringify({ attempts, last })}`);
}

async function readRuntimeBundle(session) {
  return session.cdp.evaluateJson(`(() => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    return {
      runtime: handle && typeof handle.readPhase6Runtime === 'function'
        ? handle.readPhase6Runtime()
        : null,
      summary: handle && typeof handle.readRuntimeSummary === 'function'
        ? handle.readRuntimeSummary()
        : null
    };
  })()`);
}

async function readRollbackState(session) {
  return session.cdp.evaluateJson(`(() => {
    const handle = window.__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__;
    return handle && typeof handle.snapshot === 'function' ? handle.snapshot() : null;
  })()`);
}

async function readCanonicalDocumentEvidence(session, scopeKey) {
  const expression = `(async () => {
    const scopeKey = ${JSON.stringify(scopeKey)};
    if (typeof indexedDB.databases !== 'function') return null;
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database?.name === 'candlescope-drawings-v2')) return null;
    const request = indexedDB.open('candlescope-drawings-v2');
    const database = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('drawing database open failed'));
      request.onblocked = () => reject(new Error('drawing database open blocked'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const transaction = database.transaction('documents', 'readonly');
      const store = transaction.objectStore('documents');
      const get = store.get(scopeKey);
      const record = await new Promise((resolve, reject) => {
        get.onerror = () => reject(get.error || new Error('drawing record read failed'));
        get.onsuccess = () => resolve(get.result || null);
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('drawing read transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('drawing read transaction aborted'));
      });
      if (!record || record.scopeKey !== scopeKey || !Array.isArray(record.entities)) return null;
      const canonicalize = (value) => {
        if (value === null || typeof value !== 'object') return value;
        if (ArrayBuffer.isView(value)) return Array.from(value);
        if (Array.isArray(value)) return value.map(canonicalize);
        const output = {};
        for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
        return output;
      };
      const serialized = JSON.stringify(canonicalize(record));
      const bytes = new TextEncoder().encode(serialized);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      return {
        scopeKey: record.scopeKey,
        documentRevision: record.documentRevision,
        entityCount: record.entities.length,
        updatedAt: record.updatedAt,
        serializedLength: serialized.length,
        digest: 'sha256:' + hex
      };
    } finally {
      database.close();
    }
  })()`;
  return session.cdp.evaluateJson(expression);
}

async function readPlotRect(session) {
  return session.cdp.evaluateJson(`(() => {
    const chart = document.querySelector(
      '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]'
    );
    if (!(chart instanceof HTMLElement)) return null;
    const rect = chart.getBoundingClientRect();
    return rect.width > 200 && rect.height > 160
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  })()`);
}

async function waitNextAnimationFrame(session) {
  const arrived = await session.cdp.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
  );
  if (arrived !== true) throw new Error("controlled rollback drill missed animation frame");
}

async function dispatchWheel(session, rect, index = 0) {
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(rect.x + rect.width * 0.56),
    y: Math.round(rect.y + rect.height * 0.52),
    deltaX: 0,
    deltaY: index % 2 === 0 ? -92 : 92,
  });
}

async function createPersistedFreehand(session, timeoutMs) {
  const setup = await session.cdp.evaluateJson(`(() => {
    const button = document.querySelector('[data-drawing-tool="pen"]');
    const chart = document.querySelector(
      '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]'
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled || !(chart instanceof HTMLElement)) {
      return { ready: false, buttonFound: Boolean(button), chartFound: Boolean(chart) };
    }
    button.click();
    const rect = chart.getBoundingClientRect();
    return {
      ready: rect.width > 200 && rect.height > 160,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  })()`);
  if (setup?.ready !== true) {
    throw new Error(`controlled rollback drill could not arm freehand: ${JSON.stringify(setup)}`);
  }
  const armed = await waitForSample(
    () => session.cdp.evaluate(
      "Boolean(document.querySelector('[data-drawing-tool=\"pen\"].active'))",
    ),
    (value) => value === true,
    { timeoutMs: Math.min(timeoutMs, 5_000), description: "freehand tool activation" },
  );
  if (armed.value !== true) throw new Error("controlled rollback drill freehand tool did not activate");
  await wait(150);
  const start = {
    x: Math.round(setup.rect.x + setup.rect.width * 0.35),
    y: Math.round(setup.rect.y + setup.rect.height * 0.45),
  };
  const end = {
    x: Math.round(setup.rect.x + setup.rect.width * 0.58),
    y: Math.round(setup.rect.y + setup.rect.height * 0.38),
  };
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 8; step += 1) {
    await session.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(start.x + ((end.x - start.x) * step) / 8),
      y: Math.round(start.y + ((end.y - start.y) * step) / 8),
      button: "none",
      buttons: 1,
    });
  }
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1,
  });
  const settled = await waitForSample(
    () => readRuntimeBundle(session),
    (bundle) => bundle?.summary?.entityCount > 0
      && bundle.summary.effectiveEngineMode === "scene-canary"
      && bundle.runtime?.backend === "worker"
      && bundle.runtime?.workerAvailability === "available"
      && runtimeCurrent(bundle.runtime),
    { timeoutMs, description: "persisted freehand worker publication", stableMs: 120, signature: runtimeSignature },
  );
  const scopeKey = settled.value.runtime.lastRequestedStamp.scopeKey;
  const stored = await waitForSample(
    () => readCanonicalDocumentEvidence(session, scopeKey),
    (value) => value?.entityCount === settled.value.summary.entityCount
      && value?.documentRevision === settled.value.runtime.lastRequestedStamp.documentRevision,
    { timeoutMs, description: "canonical drawing IndexedDB persistence", stableMs: 80, signature: JSON.stringify },
  );
  return Object.freeze({
    setup,
    start,
    end,
    runtime: settled.value.runtime,
    summary: settled.value.summary,
    document: stored.value,
  });
}

function diagnosticsReceipt(session) {
  const page = session.diagnostics().pageAndWorker;
  return Object.freeze({
    crashCount: page?.crashCount ?? null,
    runtimeExceptions: Object.freeze([...(page?.runtimeExceptions ?? [])]),
    unhandledRejections: Object.freeze([...(page?.unhandledRejections ?? [])]),
    unexpectedConsoleErrors: Object.freeze([...(page?.unexpectedConsoleErrors ?? [])]),
  });
}

function prefixedSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : null;
}

async function captureDrillBuildAuthority(session, drillId) {
  const allowDetachedWorker = drillId === "offscreen-canvas-unsupported";
  const evidence = await session.readBrowserBuildEvidence({
    requireActiveWorkers: !allowDetachedWorker,
  });
  const expectedDrawingWorkerPaths = new Set(evidence?.networkAssets?.expectedDrawingWorkerPaths ?? []);
  const drawingWorkerTargets = (evidence?.networkAssets?.workerTargets ?? []).filter((target) => (
    target?.type === "worker" && expectedDrawingWorkerPaths.has(target.path)
  ));
  const workerTargets = Object.freeze(drawingWorkerTargets.map((target) => Object.freeze({
    targetId: target.targetId ?? null,
    path: target.path ?? null,
    active: target.active === true,
    manifestBacked: target.manifestBacked === true,
    constructorProvenanceAccepted: target.constructorProvenanceAccepted === true,
    networkProvenanceAccepted: target.networkProvenanceAccepted === true,
    assetAccepted: target.assetAccepted === true,
    assetDigest: prefixedSha256(target.assetSha256),
    expectedAssetDigest: prefixedSha256(target.expectedAssetSha256),
  })));
  const activeDrawingWorkerTargetCount = workerTargets.filter((target) => target.active).length;
  const constructionFaultCount = evidence?.networkAssets?.workerConstructionFaults?.length ?? -1;
  const workerLifecycleKind = allowDetachedWorker
    ? "detached-after-typed-fallback"
    : drillId === "worker-init-failure"
      ? "construction-failed-before-target"
      : "active-worker";
  const workerLifecycleAccepted = allowDetachedWorker
    ? workerTargets.length === 1
      && activeDrawingWorkerTargetCount === 0
      && constructionFaultCount === 0
    : drillId === "worker-init-failure"
      ? evidence?.authoritative === true
        && workerTargets.length === 0
        && constructionFaultCount === 1
      : evidence?.authoritative === true
        && workerTargets.length === 1
        && activeDrawingWorkerTargetCount === 1
        && constructionFaultCount === 0;
  const workerAssetAuthorityAccepted = workerTargets.every((target) => (
    target.manifestBacked
      && target.constructorProvenanceAccepted
      && target.networkProvenanceAccepted
      && target.assetAccepted
      && target.assetDigest !== null
      && target.assetDigest === target.expectedAssetDigest
  ));
  const authoritative = evidence?.assetAuthoritative === true
    && workerLifecycleAccepted
    && workerAssetAuthorityAccepted;
  const receipt = Object.freeze({
    kind: "controlled-browser-build-authority",
    drillId,
    capturedAt: new Date().toISOString(),
    authoritative,
    fullBuildAuthoritative: evidence?.authoritative === true,
    assetBuildAuthoritative: evidence?.assetAuthoritative === true,
    buildId: evidence?.buildId ?? null,
    buildFingerprint: prefixedSha256(evidence?.buildFingerprint?.sha256),
    assetDigest: prefixedSha256(evidence?.assetFingerprint?.sha256),
    currentAssetDigest: prefixedSha256(evidence?.currentAssetSha256),
    buildInputDigest: prefixedSha256(session.buildReceipt?.inputFingerprint?.sha256),
    currentBuildInputDigest: prefixedSha256(evidence?.currentBuildInputSha256),
    gitRevision: evidence?.currentGit?.commit ?? null,
    managedOrigin: evidence?.managedOrigin ?? null,
    observedOrigin: evidence?.observedOrigin ?? null,
    href: evidence?.href ?? null,
    matchesManagedOrigin: evidence?.matchesManagedOrigin === true,
    matchesManagedDocument: evidence?.matchesManagedDocument === true,
    entryAssetsLoaded: Array.isArray(evidence?.networkAssets?.entryAssets)
      && evidence.networkAssets.entryAssets.length === evidence.networkAssets.expectedEntryCount
      && evidence.networkAssets.entryAssets.every((entry) => entry.accepted === true),
    networkAssetsPassed: evidence?.networkAssetsPassed === true,
    networkAssetAuthorityPassed: evidence?.networkAssetAuthorityPassed === true,
    networkQuiescencePassed: evidence?.networkAssets?.quiescence?.passed === true,
    browserLoadedAssetsAccepted: evidence?.browserLoadedAssetsAccepted === true,
    domLoadedAssetsAccepted: evidence?.domLoadedAssetsAccepted === true,
    expectedEntriesPresentInDom: evidence?.expectedEntriesPresentInDom === true,
    distMatchesBuild: evidence?.distMatchesBuild === true,
    buildInputsMatch: evidence?.buildInputsMatch === true,
    gitMatchesBuild: evidence?.gitMatchesBuild === true,
    managedOriginGuardPassed: evidence?.managedOriginEvidence?.passed === true,
    workerDiagnosticsPassed: evidence?.workerDiagnostics?.passed === true,
    handlerSettlementsPassed: evidence?.cdpHandlerSettlements?.beforeCapture?.passed === true
      && evidence?.cdpHandlerSettlements?.afterCapture?.passed === true,
    workerLifecycle: Object.freeze({
      kind: workerLifecycleKind,
      accepted: workerLifecycleAccepted,
      drawingWorkerTargetCount: workerTargets.length,
      activeDrawingWorkerTargetCount,
      detachedDrawingWorkerTargetCount: workerTargets.length - activeDrawingWorkerTargetCount,
      constructionFaultCount,
      assetAuthorityAccepted: workerAssetAuthorityAccepted,
      targets: workerTargets,
    }),
  });
  if (!receipt.authoritative) {
    throw new Error(`${drillId} build authority failed: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

function commonArtifact(
  session,
  drillId,
  startedAt,
  windowEvidence,
  buildAuthority,
  injection,
  fields,
) {
  return Object.freeze({
    schemaVersion: "drawing-rollback-drill/v2",
    drillId,
    environment: Object.freeze({
      productionBuild: session.initialBuildEvidence?.authoritative === true,
      headed: windowEvidence?.headed === true,
      visibilityState: windowEvidence?.visibilityState ?? null,
      windowState: windowEvidence?.windowState ?? null,
      browserVersion: windowEvidence?.browserProduct ?? session.browserVersion?.product ?? "",
    }),
    provenance: Object.freeze({
      buildRevision: session.buildReceipt?.git?.commit ?? "",
      runId: session.runId,
      startedAt,
      completedAt: new Date().toISOString(),
    }),
    buildAuthority,
    injection: Object.freeze(injection),
    diagnostics: diagnosticsReceipt(session),
    ...fields,
  });
}

function outcome(beforeDocument, afterDocument, runtime) {
  return Object.freeze({
    beforeDigest: beforeDocument.digest,
    afterDigest: afterDocument.digest,
    beforeEntityCount: beforeDocument.entityCount,
    afterEntityCount: afterDocument.entityCount,
    beforeDocumentRevision: beforeDocument.documentRevision,
    afterDocumentRevision: afterDocument.documentRevision,
    scopeKey: afterDocument.scopeKey,
    queueDepthCurrent: runtime.queueDepthCurrent,
    lastRequestedStamp: runtime.lastRequestedStamp,
    lastPublishedStamp: runtime.lastPublishedStamp,
    lastPaintedStamp: runtime.lastPaintedStamp,
    paintReceipt: runtime.paintReceipt,
  });
}

function requestId(prefix, identity) {
  return `${prefix}:${identity?.jobId ?? "none"}:${identity?.generation ?? "none"}`;
}

async function waitForPreservedDocument(session, runtime, expected, timeoutMs, description) {
  const scopeKey = runtime?.lastRequestedStamp?.scopeKey;
  const observed = await waitForSample(
    () => readCanonicalDocumentEvidence(session, scopeKey),
    (document) => document?.scopeKey === expected.scopeKey
      && document?.documentRevision === expected.documentRevision
      && document?.entityCount === expected.entityCount,
    { timeoutMs, description, stableMs: 80, signature: JSON.stringify },
  );
  return observed.value;
}

async function runWorkerInitFailure(session, beforeDocument, timeoutMs) {
  const startedAt = new Date().toISOString();
  const navigation = await session.navigateRollbackDrill("worker-init-failure");
  const first = await waitForSample(
    () => readRuntimeBundle(session),
    (bundle) => bundle?.summary?.entityCount === beforeDocument.entityCount
      && bundle.runtime?.engineMode === "scene-canary"
      && bundle.runtime?.backend === "main-thread"
      && bundle.runtime?.workerUnavailableReason === "construction-failed"
      && bundle.runtime?.workerJobDelta === 0
      && runtimeCurrent(bundle.runtime),
    { timeoutMs, description: "worker construction fallback", stableMs: 120, signature: runtimeSignature },
  );
  const rect = await readPlotRect(session);
  if (!rect) throw new Error("worker-init rollback drill plot rect is unavailable");
  await dispatchWheel(session, rect, 0);
  const final = await waitForSample(
    () => readRuntimeBundle(session),
    (bundle) => bundle?.runtime?.lastRequestedStamp?.viewportRevision
        > first.value.runtime.lastRequestedStamp.viewportRevision
      && bundle.runtime?.paintReceipt?.paintSequence > first.value.runtime.paintReceipt.paintSequence
      && bundle.runtime?.backend === "main-thread"
      && bundle.runtime?.workerUnavailableReason === "construction-failed"
      && bundle.runtime?.workerJobDelta === 0
      && runtimeCurrent(bundle.runtime),
    { timeoutMs, description: "sticky worker construction fallback", stableMs: 300, signature: runtimeSignature },
  );
  const state = await readRollbackState(session);
  const afterDocument = await waitForPreservedDocument(
    session,
    final.value.runtime,
    beforeDocument,
    timeoutMs,
    "worker construction fallback document preservation",
  );
  const windowEvidence = await session.verifyWindow();
  const buildAuthority = await captureDrillBuildAuthority(session, "worker-init-failure");
  return Object.freeze({
    document: afterDocument,
    artifact: commonArtifact(session, "worker-init-failure", startedAt, windowEvidence, buildAuthority, {
      kind: "worker-constructor-throws",
      armed: navigation.bootstrap?.armed === true,
      observed: state?.observed === true,
      faultId: navigation.faultId,
      authorityTokenSha256: navigation.authorityTokenSha256,
      exactWorkerUrl: state?.constructionFailure?.url ?? null,
      workerType: state?.constructionFailure?.workerType ?? null,
      workerName: state?.constructionFailure?.workerName ?? "candlescope-drawing-worker",
      errorName: state?.constructionFailure?.name ?? null,
      buildAuthorityCurrent: buildAuthority.authoritative,
    }, {
      observations: Object.freeze({
        configuredRequest: CONFIGURED_WORKER_REQUEST,
        runtime: final.value.runtime,
        workerConstructorAttempts: Object.freeze({ before: 0, after: state?.workerConstructorAttempts }),
        workerConstructionFailures: Object.freeze({ before: 0, after: state?.workerConstructionFailures }),
        fallbackBackend: final.value.runtime.backend,
        scenePublicationCountDelta: final.value.runtime.paintReceipt.paintSequence,
        firstPublishedStamp: first.value.runtime.lastPublishedStamp,
        finalPublishedStamp: final.value.runtime.lastPublishedStamp,
        workerJobs: Object.freeze({ before: 0, after: final.value.runtime.workerJobDelta }),
        stalePublishCount: Object.freeze({ before: 0, after: final.value.runtime.stalePublishCount }),
      }),
      outcome: outcome(beforeDocument, afterDocument, final.value.runtime),
    }),
  });
}

function offscreenInitializerExpression() {
  return `(() => {
    const beforeType = typeof globalThis.OffscreenCanvas;
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: undefined,
      configurable: false,
      enumerable: false,
      writable: false
    });
    const afterType = typeof globalThis.OffscreenCanvas;
    const lexicalType = typeof OffscreenCanvas;
    return {
      installed: beforeType === 'function' && afterType === 'undefined' && lexicalType === 'undefined',
      realm: 'drawing-worker-global',
      capability: 'OffscreenCanvas',
      beforeType,
      afterType,
      lexicalType,
      supported: false
    };
  })()`;
}

async function runOffscreenUnsupported(session, beforeDocument, timeoutMs) {
  const startedAt = new Date().toISOString();
  const workerPath = session.rollbackAuthority.drawingWorkerPaths[0];
  const workerUrl = new URL(workerPath, `${session.managedOrigin}/`).href;
  const expression = offscreenInitializerExpression();
  const lease = session.registerPausedTargetInitializer({
    id: "offscreen-canvas-unsupported",
    targetType: "worker",
    targetUrl: workerUrl,
    expression,
    timeoutMs: Math.min(timeoutMs, 10_000),
  });
  const navigation = await session.navigateRollbackDrill("offscreen-canvas-unsupported");
  const initializer = await lease.waitForReceipt(Math.min(timeoutMs, 10_000));
  lease.assertConsumedExactlyOnce();
  const first = await waitForSample(
    async () => ({ bundle: await readRuntimeBundle(session), state: await readRollbackState(session) }),
    ({ bundle, state }) => initializer?.receipt?.result?.installed === true
      && state?.workerCreations === 1
      && state?.renderRequestCount === 1
      && state?.renderResultCount === 1
      && state?.typedResultCount === 1
      && state?.bitmapResultCount === 0
      && bundle?.summary?.entityCount === beforeDocument.entityCount
      && bundle?.runtime?.backend === "main-thread"
      && bundle?.runtime?.workerJobDelta === 1
      && bundle?.runtime?.workerResultDelta === 1
      && runtimeCurrent(bundle.runtime),
    {
      timeoutMs,
      description: "worker-global OffscreenCanvas typed fallback",
      stableMs: 120,
      signature: ({ bundle, state }) => `${runtimeSignature(bundle)}:${state?.renderResultCount}`,
    },
  );
  const rect = await readPlotRect(session);
  if (!rect) throw new Error("offscreen rollback drill plot rect is unavailable");
  await dispatchWheel(session, rect, 1);
  const final = await waitForSample(
    async () => ({ bundle: await readRuntimeBundle(session), state: await readRollbackState(session) }),
    ({ bundle, state }) => bundle?.runtime?.lastRequestedStamp?.viewportRevision
        > first.value.bundle.runtime.lastRequestedStamp.viewportRevision
      && bundle.runtime?.paintReceipt?.paintSequence > first.value.bundle.runtime.paintReceipt.paintSequence
      && bundle.runtime?.backend === "main-thread"
      && bundle.runtime?.workerJobDelta === first.value.bundle.runtime.workerJobDelta
      && bundle.runtime?.workerResultDelta === first.value.bundle.runtime.workerResultDelta
      && state?.renderRequestCount === first.value.state.renderRequestCount
      && state?.renderResultCount === first.value.state.renderResultCount
      && runtimeCurrent(bundle.runtime),
    {
      timeoutMs,
      description: "sticky main-thread OffscreenCanvas fallback",
      stableMs: 300,
      signature: ({ bundle, state }) => `${runtimeSignature(bundle)}:${state?.renderRequestCount}`,
    },
  );
  const firstRuntime = first.value.bundle.runtime;
  const finalRuntime = final.value.bundle.runtime;
  const state = final.value.state;
  const firstHeader = state.renderRequests[0]?.header ?? null;
  const afterDocument = await waitForPreservedDocument(
    session,
    finalRuntime,
    beforeDocument,
    timeoutMs,
    "OffscreenCanvas fallback document preservation",
  );
  const windowEvidence = await session.verifyWindow();
  const buildAuthority = await captureDrillBuildAuthority(session, "offscreen-canvas-unsupported");
  const capability = initializer.receipt.result;
  return Object.freeze({
    document: afterDocument,
    artifact: commonArtifact(
      session,
      "offscreen-canvas-unsupported",
      startedAt,
      windowEvidence,
      buildAuthority,
      {
      kind: "offscreen-canvas-unavailable",
      armed: navigation.bootstrap?.armed === true && initializer.state === "consumed",
      observed: capability?.installed === true && state.typedResultCount === 1,
      faultId: navigation.faultId,
      authorityTokenSha256: navigation.authorityTokenSha256,
      targetUrl: workerUrl,
      initializer: initializer.receipt,
      capabilityReceipt: Object.freeze({
        realm: capability?.realm,
        capability: capability?.capability,
        supported: capability?.supported,
        beforeType: capability?.beforeType,
        afterType: capability?.afterType,
        lexicalType: capability?.lexicalType,
      }),
      buildAuthorityCurrent: buildAuthority.authoritative,
    }, {
      observations: Object.freeze({
        configuredRequest: CONFIGURED_WORKER_REQUEST,
        runtime: finalRuntime,
        workerCreations: Object.freeze({ before: 0, after: state.workerCreations }),
        offscreenSupported: capability?.supported,
        firstRequest: Object.freeze({
          requestId: requestId("worker", firstHeader),
          header: firstHeader,
          backendBefore: "worker",
          resultKind: state.renderResults[0]?.resultKind === "typed-draw-result"
            ? "typed-fallback"
            : state.renderResults[0]?.resultKind,
          backendAfter: firstRuntime.backend,
        }),
        secondRequest: Object.freeze({
          requestId: `main:${finalRuntime.lastRequestedStamp.viewportRevision}:${finalRuntime.paintReceipt.paintSequence}`,
          backendBefore: firstRuntime.backend,
          resultKind: "main-thread",
          backendAfter: finalRuntime.backend,
        }),
        finalBackend: finalRuntime.backend,
        workerRoundTrips: Object.freeze({
          before: 0,
          afterFirstRequest: firstRuntime.workerResultDelta,
          afterSecondRequest: finalRuntime.workerResultDelta,
        }),
        typedResults: Object.freeze({ before: 0, after: state.typedResultCount }),
        bitmapResults: Object.freeze({ before: 0, after: state.bitmapResultCount }),
        scenePublications: Object.freeze({ before: 0, after: finalRuntime.paintReceipt.paintSequence }),
      }),
      outcome: outcome(beforeDocument, afterDocument, finalRuntime),
    }),
  });
}

async function runStaleGeneration(session, beforeDocument, timeoutMs) {
  const startedAt = new Date().toISOString();
  const navigation = await session.navigateRollbackDrill("worker-stale-generation");
  const baseline = await waitForSample(
    () => readRuntimeBundle(session),
    (bundle) => bundle?.summary?.entityCount === beforeDocument.entityCount
      && bundle.runtime?.workerResultDelayMs === 96
      && bundle.runtime?.backend === "worker"
      && bundle.runtime?.workerAvailability === "available"
      && runtimeCurrent(bundle.runtime),
    { timeoutMs, description: "stale-generation delayed worker baseline", stableMs: 80, signature: runtimeSignature },
  );
  const baselineRuntime = baseline.value.runtime;
  const baselineJobId = baselineRuntime.latestSubmittedWorkerIdentity?.jobId ?? 0;
  const rect = await readPlotRect(session);
  if (!rect) throw new Error("stale-generation rollback drill plot rect is unavailable");
  for (let index = 0; index < 96; index += 1) {
    await dispatchWheel(session, rect, index);
    await waitNextAnimationFrame(session);
  }
  const final = await waitForSample(
    () => readRuntimeBundle(session),
    (bundle) => {
      const runtime = bundle?.runtime;
      const returned = runtime?.returnedWorkerIdentity;
      const latest = runtime?.latestSubmittedWorkerIdentity;
      return runtime?.workerResultDelayMs === 96
        && runtime?.backend === "worker"
        && runtime?.workerAvailability === "available"
        && runtime?.queueDepthMax === 2
        && runtime?.inFlightMax === 1
        && runtime?.pendingDropDelta > baselineRuntime.pendingDropDelta
        && runtime?.staleResultDropDelta > baselineRuntime.staleResultDropDelta
        && runtime?.workerJobDelta - baselineRuntime.workerJobDelta
          > runtime?.workerResultDelta - baselineRuntime.workerResultDelta
        && returned?.jobId > baselineJobId
        && latest?.jobId > returned.jobId
        && runtime?.stalePublishCount === 0
        && runtimeCurrent(runtime);
    },
    {
      timeoutMs,
      description: "stale worker generation convergence",
      stableMs: 300,
      signature: runtimeSignature,
    },
  );
  const runtime = final.value.runtime;
  const submittedHeaders = runtime.submittedWorkerHeaders.filter((header) => header.jobId > baselineJobId);
  const afterDocument = await waitForPreservedDocument(
    session,
    runtime,
    beforeDocument,
    timeoutMs,
    "stale generation document preservation",
  );
  const state = await readRollbackState(session);
  const windowEvidence = await session.verifyWindow();
  const buildAuthority = await captureDrillBuildAuthority(session, "worker-stale-generation");
  return Object.freeze({
    document: afterDocument,
    artifact: commonArtifact(session, "worker-stale-generation", startedAt, windowEvidence, buildAuthority, {
      kind: "worker-stale-generation",
      armed: navigation.bootstrap?.armed === true,
      observed: state?.observed === true
        && runtime.staleResultDropDelta > baselineRuntime.staleResultDropDelta,
      delayMs: 96,
      faultId: navigation.faultId,
      authorityTokenSha256: navigation.authorityTokenSha256,
      buildAuthorityCurrent: buildAuthority.authoritative,
    }, {
      observations: Object.freeze({
        runtime,
        workerResultDelayMs: runtime.workerResultDelayMs,
        finalBackend: runtime.backend,
        workerAvailability: runtime.workerAvailability,
        workerJobDelta: runtime.workerJobDelta,
        workerResultDelta: runtime.workerResultDelta,
        pendingDropDelta: runtime.pendingDropDelta,
        staleResultDropDelta: runtime.staleResultDropDelta,
        stalePublishDelta: runtime.stalePublishCount - baselineRuntime.stalePublishCount,
        stalePublishCount: Object.freeze({
          before: baselineRuntime.stalePublishCount,
          after: runtime.stalePublishCount,
        }),
        stalePublishCountBefore: baselineRuntime.stalePublishCount,
        stalePublishCountAfter: runtime.stalePublishCount,
        queueDepthMax: runtime.queueDepthMax,
        queueDepthCurrent: runtime.queueDepthCurrent,
        inFlightMax: runtime.inFlightMax,
        inFlightCurrent: runtime.inFlightCurrent,
        sceneFallbackDelta: runtime.sceneFallbackCount - baselineRuntime.sceneFallbackCount,
        runtimeFaultDelta: runtime.sceneRuntimeFaultCount - baselineRuntime.sceneRuntimeFaultCount,
        legacyFallbackDelta: runtime.legacyFallbackSucceededCount
          - baselineRuntime.legacyFallbackSucceededCount,
      }),
      identities: Object.freeze({
        returned: runtime.returnedWorkerIdentity,
        accepted: runtime.acceptedWorkerIdentity,
        published: runtime.publishedWorkerIdentity,
        latestSubmitted: runtime.latestSubmittedWorkerIdentity,
      }),
      submittedHeaders: Object.freeze(submittedHeaders),
      outcome: outcome(beforeDocument, afterDocument, runtime),
    }),
  });
}

export async function runControlledWorkerRollbackDrills(session, { timeoutMs = 45_000 } = {}) {
  const baseline = await createPersistedFreehand(session, timeoutMs);
  const initFailure = await runWorkerInitFailure(session, baseline.document, timeoutMs);
  const offscreen = await runOffscreenUnsupported(session, initFailure.document, timeoutMs);
  const stale = await runStaleGeneration(session, offscreen.document, timeoutMs);
  return Object.freeze({
    baseline,
    drills: Object.freeze([
      initFailure.artifact,
      offscreen.artifact,
      stale.artifact,
    ]),
    finalDocument: stale.document,
  });
}

export function canonicalArtifactSha256(artifact) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`;
}
