import {
  captureDrillBuildAuthority,
  commonArtifact,
  readCanonicalDocumentEvidence,
  readRuntimeBundle,
  runtimeCurrent,
  runtimeSignature,
  waitForSample,
} from "./drawing-rollback-worker-browser.mjs";

const DRILL_ID = "continuous-dpr-resize";
const RESTORE_DEVICE_METRICS = Object.freeze({
  dpr: 1,
  viewport: Object.freeze({ width: 1440, height: 900 }),
});

/**
 * The first, third, and fifth requests change DPR without changing CSS viewport
 * size. The second, fourth, and sixth requests change CSS viewport size without
 * changing DPR. This prevents a resize notification from masking a missing DPR
 * invalidation path. The sixth request restores the controlled-run baseline.
 */
export const CONTINUOUS_DPR_RESIZE_MATRIX = Object.freeze([
  Object.freeze({ dpr: 1.5, viewport: Object.freeze({ width: 1440, height: 900 }) }),
  Object.freeze({ dpr: 1.5, viewport: Object.freeze({ width: 1200, height: 800 }) }),
  Object.freeze({ dpr: 2, viewport: Object.freeze({ width: 1200, height: 800 }) }),
  Object.freeze({ dpr: 2, viewport: Object.freeze({ width: 1000, height: 700 }) }),
  Object.freeze({ dpr: 1, viewport: Object.freeze({ width: 1000, height: 700 }) }),
  RESTORE_DEVICE_METRICS,
]);

const STAMP_FIELDS = Object.freeze([
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

const STABLE_STAMP_FIELDS = Object.freeze([
  "scopeKey",
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "themeRevision",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validDocumentReceipt(value) {
  return value
    && nonEmptyString(value.scopeKey)
    && Number.isSafeInteger(value.documentRevision)
    && value.documentRevision >= 0
    && Number.isSafeInteger(value.entityCount)
    && value.entityCount > 0
    && typeof value.digest === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value.digest);
}

function sameDocument(left, right) {
  return validDocumentReceipt(left)
    && validDocumentReceipt(right)
    && left.scopeKey === right.scopeKey
    && left.documentRevision === right.documentRevision
    && left.entityCount === right.entityCount
    && left.digest === right.digest;
}

function sameStamp(left, right) {
  return left && right && STAMP_FIELDS.every((field) => left[field] === right[field]);
}

function stableStampFieldsMatch(left, right) {
  return left && right && STABLE_STAMP_FIELDS.every((field) => left[field] === right[field]);
}

function sameWorkerIdentity(left, right) {
  return left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.jobId === right.jobId
    && left.generation === right.generation
    && sameStamp(left.stamp, right.stamp);
}

export function continuousDprWorkerResultCurrent(runtime) {
  const latest = runtime?.latestSubmittedWorkerIdentity;
  const accepted = runtime?.acceptedWorkerIdentity;
  const published = runtime?.publishedWorkerIdentity;
  return runtime?.backend === "worker"
    && runtime?.workerAvailability === "available"
    && sameWorkerIdentity(latest, accepted)
    && sameWorkerIdentity(accepted, published)
    && sameStamp(published?.stamp, runtime?.lastRequestedStamp);
}

function nearlyEqual(left, right, tolerance = 0.51) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function canvasMatchesPlot(canvas, hostRect, plotRect, dpr) {
  if (!canvas?.present || !canvas.cssRect || !canvas.bitmap || !hostRect || !plotRect) return false;
  const inlineStyle = canvas.style;
  if (![inlineStyle?.left, inlineStyle?.top, inlineStyle?.width, inlineStyle?.height]
    .every(Number.isFinite)) return false;
  const expectedBitmapWidth = Math.max(1, Math.round(inlineStyle.width * dpr));
  const expectedBitmapHeight = Math.max(1, Math.round(inlineStyle.height * dpr));
  return canvas.pointerEventsNone === true
    && nearlyEqual(canvas.cssRect.x, hostRect.x + plotRect.x)
    && nearlyEqual(canvas.cssRect.y, hostRect.y + plotRect.y)
    // Lightweight Charts exposes integer pane dimensions while the DOM can
    // retain the sub-pixel layout used to size the canvas. One CSS pixel is
    // the maximum representational gap; bitmap authority remains exact to the
    // inline dimensions written by the overlay controller.
    && nearlyEqual(canvas.cssRect.width, plotRect.width, 1.01)
    && nearlyEqual(canvas.cssRect.height, plotRect.height, 1.01)
    && nearlyEqual(inlineStyle.left, plotRect.x)
    && nearlyEqual(inlineStyle.top, plotRect.y)
    && nearlyEqual(inlineStyle.width, plotRect.width, 1.01)
    && nearlyEqual(inlineStyle.height, plotRect.height, 1.01)
    // CSSOM serializes sub-pixel inline dimensions before we can read them
    // back. At an exact .5 physical-pixel boundary that representation can
    // differ by one pixel from Math.round(originalDimension * dpr).
    && nearlyEqual(canvas.bitmap.width, expectedBitmapWidth, 1)
    && nearlyEqual(canvas.bitmap.height, expectedBitmapHeight, 1);
}

export function continuousDprOverlaySynchronized(surface, expectedDpr) {
  const plotRect = surface?.adapterPlotRect;
  const hostRect = surface?.hostRect;
  if (surface?.overlayCount !== 2
    || surface?.hostPresent !== true
    || surface?.hostPointerEventsNone !== true
    || !plotRect
    || !nearlyEqual(surface?.devicePixelRatio, expectedDpr, 0.001)
    || !nearlyEqual(plotRect.dpr, expectedDpr, 0.001)) return false;
  return canvasMatchesPlot(surface.dynamic, hostRect, plotRect, expectedDpr)
    && canvasMatchesPlot(surface.liveInk, hostRect, plotRect, expectedDpr)
    && nearlyEqual(surface.dynamic.cssRect.x, surface.liveInk.cssRect.x)
    && nearlyEqual(surface.dynamic.cssRect.y, surface.liveInk.cssRect.y)
    && nearlyEqual(surface.dynamic.cssRect.width, surface.liveInk.cssRect.width)
    && nearlyEqual(surface.dynamic.cssRect.height, surface.liveInk.cssRect.height);
}

export async function readContinuousDprOverlaySurface(session) {
  return session.cdp.evaluateJson(`(() => {
    const rectSnapshot = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom
    });
    const canvasSnapshot = (kind) => {
      const canvas = document.querySelector('[data-drawing-overlay="' + kind + '"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        return {
          present: false,
          pointerEventsNone: false,
          cssRect: null,
          bitmap: null,
          style: null
        };
      }
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      return {
        present: true,
        pointerEventsNone: style.pointerEvents === 'none',
        cssRect: rectSnapshot(rect),
        bitmap: { width: canvas.width, height: canvas.height },
        style: {
          left: Number.parseFloat(canvas.style.left),
          top: Number.parseFloat(canvas.style.top),
          width: Number.parseFloat(canvas.style.width),
          height: Number.parseFloat(canvas.style.height)
        },
        computedStyle: {
          left: Number.parseFloat(style.left),
          top: Number.parseFloat(style.top),
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height)
        }
      };
    };
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const summary = handle && typeof handle.readRuntimeSummary === 'function'
      ? handle.readRuntimeSummary()
      : null;
    const host = document.querySelector('.drawing-interaction-overlay');
    return {
      observedAt: new Date().toISOString(),
      overlayCount: document.querySelectorAll('[data-drawing-overlay]').length,
      hostPresent: host instanceof HTMLElement,
      hostPointerEventsNone: host instanceof HTMLElement
        && getComputedStyle(host).pointerEvents === 'none',
      hostRect: host instanceof HTMLElement ? rectSnapshot(host.getBoundingClientRect()) : null,
      devicePixelRatio: window.devicePixelRatio,
      adapterPlotRect: summary?.mainPanePlotRect ?? null,
      dynamic: canvasSnapshot('dynamic'),
      liveInk: canvasSnapshot('live-ink')
    };
  })()`);
}

async function readConvergenceBundle(session) {
  const runtimeBundle = await readRuntimeBundle(session);
  const overlay = await readContinuousDprOverlaySurface(session);
  return Object.freeze({
    runtime: runtimeBundle?.runtime ?? null,
    summary: runtimeBundle?.summary ?? null,
    overlay,
  });
}

function convergenceSignature(sample) {
  return `${runtimeSignature(sample)}:${JSON.stringify({
    adapterPlotRect: sample?.overlay?.adapterPlotRect,
    dynamic: sample?.overlay?.dynamic,
    liveInk: sample?.overlay?.liveInk,
  })}`;
}

function requestedMetricsConvergence(sample, request, previousStamp) {
  const runtime = sample?.runtime;
  const stamp = runtime?.lastRequestedStamp;
  const plotRect = sample?.overlay?.adapterPlotRect;
  const checks = Object.freeze({
    runtimeCurrent: runtimeCurrent(runtime),
    sceneCanary: sample?.summary?.effectiveEngineMode === "scene-canary",
    scenePublicationReady: sample?.summary?.scenePublicationReady === true,
    nonEmptyDocument: sample?.summary?.entityCount > 0,
    workerResultCurrent: continuousDprWorkerResultCurrent(runtime),
    overlaySynchronized: continuousDprOverlaySynchronized(sample?.overlay, request.dpr),
    stampDprMatches: nearlyEqual(stamp?.dpr, request.dpr, 0.001),
    stampWidthMatches: stamp?.widthCssPx === plotRect?.width,
    stampHeightMatches: stamp?.heightCssPx === plotRect?.height,
    viewportRevisionAdvanced: stamp?.viewportRevision > previousStamp?.viewportRevision,
    stableStampFieldsMatch: stableStampFieldsMatch(stamp, previousStamp),
  });
  return Object.freeze({
    passed: Object.values(checks).every((value) => value === true),
    checks,
  });
}

function browserMetricsMatchRequest(evidence, request) {
  return evidence?.headed === true
    && evidence?.windowState === "normal"
    && evidence?.visibilityState === "visible"
    && evidence?.hidden === false
    && evidence?.innerWidth === request.viewport.width
    && evidence?.innerHeight === request.viewport.height
    && nearlyEqual(evidence?.devicePixelRatio, request.dpr, 0.001);
}

export function continuousDprInjectionReceipt(
  navigation,
  transitions,
  buildAuthorityCurrent,
) {
  const values = Array.isArray(transitions) ? transitions : [];
  const bootstrap = navigation?.bootstrap;
  const navigationAccepted = navigation?.kind === "controlled-rollback-drill-navigation"
    && navigation?.drillId === DRILL_ID
    && navigation?.variant === null
    && navigation?.runId === bootstrap?.runId
    && navigation?.authorityTokenSha256 === bootstrap?.authorityTokenSha256
    && navigation?.faultId === bootstrap?.faultId
    && navigation?.sequence === bootstrap?.sequence
    && bootstrap?.authorityAccepted === true
    && bootstrap?.armed === true
    && bootstrap?.tokenRemoved === true
    && bootstrap?.drillId === DRILL_ID
    && bootstrap?.variant === null
    && nonEmptyString(bootstrap?.documentInstanceId);
  const observed = navigationAccepted
    && buildAuthorityCurrent === true
    && values.length === CONTINUOUS_DPR_RESIZE_MATRIX.length
    && values.every((transition, index) => (
      transition?.sequence === index + 1
        && transition?.overlayDprSynchronized === true
        && transition?.workerResultCurrent === true
        && transition?.queueDepthCurrent === 0
        && browserMetricsMatchRequest(
          transition?.observedWindow,
          transition?.requestedDeviceMetrics,
        )
    ));
  return Object.freeze({
    kind: DRILL_ID,
    armed: navigationAccepted,
    observed,
    buildAuthorityCurrent: buildAuthorityCurrent === true,
    runId: navigation?.runId ?? null,
    authorityTokenSha256: nonEmptyString(navigation?.authorityTokenSha256)
      ? `sha256:${navigation.authorityTokenSha256}`
      : null,
    documentInstanceId: bootstrap?.documentInstanceId ?? null,
    faultId: navigation?.faultId ?? null,
    sequence: navigation?.sequence ?? null,
    requestCount: values.length,
    navigation: Object.freeze({
      kind: navigation?.kind ?? null,
      runId: navigation?.runId ?? null,
      drillId: navigation?.drillId ?? null,
      variant: navigation?.variant ?? null,
      faultId: navigation?.faultId ?? null,
      sequence: navigation?.sequence ?? null,
      authorityTokenSha256: nonEmptyString(navigation?.authorityTokenSha256)
        ? `sha256:${navigation.authorityTokenSha256}`
        : null,
      authorityAccepted: bootstrap?.authorityAccepted === true,
      tokenRemoved: bootstrap?.tokenRemoved === true,
      documentInstanceId: bootstrap?.documentInstanceId ?? null,
    }),
  });
}

function transitionReceipt(index, request, requestedAt, browserEvidence, settled, document) {
  const runtime = settled.value.runtime;
  const stamp = runtime.lastRequestedStamp;
  const overlayEvidence = settled.value.overlay;
  const plotRect = overlayEvidence.adapterPlotRect;
  return Object.freeze({
    sequence: index + 1,
    kind: index % 2 === 0 ? "dpr-only" : "resize-only",
    requestedAt,
    observedAt: settled.observedAt,
    requestedDeviceMetrics: Object.freeze({
      dpr: request.dpr,
      viewport: Object.freeze({ ...request.viewport }),
    }),
    requestedDpr: request.dpr,
    requestedViewport: Object.freeze({ ...request.viewport }),
    observedWindow: Object.freeze({ ...browserEvidence }),
    browserEvidence: Object.freeze({ ...browserEvidence }),
    document: Object.freeze({ ...document }),
    overlay: Object.freeze({
      synchronized: true,
      devicePixelRatio: overlayEvidence.devicePixelRatio,
      widthCssPx: plotRect.width,
      heightCssPx: plotRect.height,
      backingWidthPx: overlayEvidence.dynamic.bitmap.width,
      backingHeightPx: overlayEvidence.dynamic.bitmap.height,
      evidence: overlayEvidence,
    }),
    runtime: Object.freeze({ ...runtime }),
    dpr: request.dpr,
    widthCssPx: stamp.widthCssPx,
    heightCssPx: stamp.heightCssPx,
    overlayDprSynchronized: true,
    workerResultCurrent: true,
    queueDepthCurrent: runtime.queueDepthCurrent,
    lastRequestedStamp: stamp,
    lastPublishedStamp: runtime.lastPublishedStamp,
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

function assertNavigationAuthority(session, navigation) {
  const bootstrap = navigation?.bootstrap;
  if (navigation?.kind !== "controlled-rollback-drill-navigation"
    || navigation?.runId !== session.runId
    || navigation?.drillId !== DRILL_ID
    || navigation?.variant !== null
    || !nonEmptyString(navigation?.authorityTokenSha256)
    || !nonEmptyString(navigation?.faultId)
    || !Number.isSafeInteger(navigation?.sequence)
    || navigation.sequence <= 0
    || bootstrap?.authorityAccepted !== true
    || bootstrap?.armed !== true
    || bootstrap?.tokenRemoved !== true
    || bootstrap?.runId !== navigation.runId
    || bootstrap?.authorityTokenSha256 !== navigation.authorityTokenSha256
    || bootstrap?.drillId !== DRILL_ID
    || bootstrap?.variant !== null
    || bootstrap?.faultId !== navigation.faultId
    || !nonEmptyString(bootstrap?.documentInstanceId)
    || bootstrap?.sequence !== navigation.sequence) {
    throw new Error(`continuous DPR/resize navigation authority is invalid: ${JSON.stringify(navigation)}`);
  }
}

export async function runControlledDprResizeRollbackDrills(
  session,
  { timeoutMs = 45_000, beforeDocument } = {},
) {
  if (!validDocumentReceipt(beforeDocument)) {
    throw new TypeError("continuous DPR/resize drill requires one non-empty canonical document receipt");
  }

  const startedAt = new Date().toISOString();
  let stage = "navigate";
  let restored = false;
  try {
    const navigation = await session.navigateRollbackDrill(DRILL_ID);
    assertNavigationAuthority(session, navigation);

    stage = "baseline-convergence";
    const initialWindow = await session.verifyWindow();
    if (!browserMetricsMatchRequest(initialWindow, RESTORE_DEVICE_METRICS)) {
      throw new Error(`continuous DPR/resize baseline device metrics are invalid: ${JSON.stringify({
        expected: RESTORE_DEVICE_METRICS,
        observed: initialWindow,
      })}`);
    }
    const baseline = await waitForSample(
      () => readConvergenceBundle(session),
      (sample) => runtimeCurrent(sample?.runtime)
        && sample?.summary?.effectiveEngineMode === "scene-canary"
        && sample?.summary?.scenePublicationReady === true
        && sample?.summary?.entityCount === beforeDocument.entityCount
        && continuousDprWorkerResultCurrent(sample?.runtime)
        && continuousDprOverlaySynchronized(sample?.overlay, initialWindow.devicePixelRatio),
      {
        timeoutMs,
        description: "continuous DPR/resize baseline convergence",
        stableMs: 120,
        signature: convergenceSignature,
      },
    );
    const canonicalBefore = await readCanonicalDocumentEvidence(session, beforeDocument.scopeKey);
    if (!sameDocument(beforeDocument, canonicalBefore)) {
      throw new Error(`continuous DPR/resize baseline document changed: ${JSON.stringify({
        expected: beforeDocument,
        observed: canonicalBefore,
      })}`);
    }

    const transitions = [];
    let previousStamp = baseline.value.runtime.lastRequestedStamp;
    for (const [index, request] of CONTINUOUS_DPR_RESIZE_MATRIX.entries()) {
      stage = `transition-${index + 1}-inject`;
      const requestedAt = new Date().toISOString();
      const browserEvidence = await session.setDeviceMetrics(request.viewport, request.dpr);
      if (!browserMetricsMatchRequest(browserEvidence, request)) {
        throw new Error(`continuous DPR/resize browser metrics mismatch: ${JSON.stringify({
          request,
          browserEvidence,
        })}`);
      }

      stage = `transition-${index + 1}-converge`;
      const settled = await waitForSample(
        async () => {
          const sample = await readConvergenceBundle(session);
          return Object.freeze({
            ...sample,
            convergence: requestedMetricsConvergence(sample, request, previousStamp),
          });
        },
        (sample) => sample?.convergence?.passed === true,
        {
          timeoutMs,
          description: `continuous DPR/resize transition ${index + 1}`,
          stableMs: 120,
          signature: convergenceSignature,
        },
      );
      const document = await readCanonicalDocumentEvidence(session, beforeDocument.scopeKey);
      if (!sameDocument(canonicalBefore, document)) {
        throw new Error(`continuous DPR/resize transition ${index + 1} changed the document`);
      }
      transitions.push(transitionReceipt(
        index,
        request,
        requestedAt,
        browserEvidence,
        settled,
        document,
      ));
      previousStamp = settled.value.runtime.lastRequestedStamp;
      if (index === CONTINUOUS_DPR_RESIZE_MATRIX.length - 1) restored = true;
    }

    stage = "final-document";
    const finalTransition = transitions.at(-1);
    const canonicalAfter = await readCanonicalDocumentEvidence(session, beforeDocument.scopeKey);
    if (!sameDocument(canonicalBefore, canonicalAfter)) {
      throw new Error("continuous DPR/resize final document changed");
    }

    stage = "build-authority";
    const windowEvidence = await session.verifyWindow();
    if (!browserMetricsMatchRequest(windowEvidence, RESTORE_DEVICE_METRICS)) {
      throw new Error(`continuous DPR/resize did not restore controlled device metrics: ${JSON.stringify(windowEvidence)}`);
    }
    const buildAuthority = await captureDrillBuildAuthority(session, DRILL_ID);
    const artifact = commonArtifact(
      session,
      DRILL_ID,
      startedAt,
      windowEvidence,
      buildAuthority,
      continuousDprInjectionReceipt(
        navigation,
        transitions,
        buildAuthority.authoritative,
      ),
      {
        baseline: Object.freeze({
          browserEvidence: Object.freeze({ ...initialWindow }),
          document: Object.freeze({ ...canonicalBefore }),
          overlay: baseline.value.overlay,
          runtime: Object.freeze({ ...baseline.value.runtime }),
        }),
        transitions: Object.freeze(transitions),
        outcome: outcome(canonicalBefore, canonicalAfter, finalTransition.runtime),
      },
    );
    return Object.freeze({
      drills: Object.freeze([artifact]),
      finalDocument: Object.freeze({ ...canonicalAfter }),
    });
  } catch (error) {
    throw new Error(
      `continuous DPR/resize stage ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (!restored) {
      try {
        await session.setDeviceMetrics(
          RESTORE_DEVICE_METRICS.viewport,
          RESTORE_DEVICE_METRICS.dpr,
        );
      } catch {
        // Preserve the original stage failure. The controlled session close
        // path remains authoritative for cleanup and diagnostics.
      }
    }
  }
}
