import {
  captureDrillBuildAuthority,
  commonArtifact,
  runtimeCurrent,
  runtimeSignature,
  waitForSample,
} from "./drawing-rollback-worker-browser.mjs";
import {
  canonicalDocumentReceipt,
  switchChartType,
} from "./drawing-rollback-lifecycle-browser.mjs";

const DRILL_ID = "series-rebuild-before-export";
const PIXEL_CACHE = "__CANDLESCOPE_SERIES_REBUILD_EXPORT_PIXELS__";
const CHECKPOINT_TYPES = Object.freeze([
  "old-export-prepare",
  "series-rebuild-start",
  "series-rebuild-complete",
  "stale-export-pixels-fixed",
  "stale-lease-revalidate",
  "stale-lease-restored",
  "visible-export-prepare",
  "visible-export-pixels-fixed",
  "visible-lease-revalidate",
  "visible-lease-restored",
  "visible-export-encoded",
  "hidden-export-prepare",
  "hidden-export-pixels-fixed",
  "hidden-lease-revalidate",
  "hidden-lease-restored",
  "hidden-export-encoded",
  "pixel-oracle-complete",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameCanonical(left, right) {
  return left?.scopeKey === right?.scopeKey
    && left?.digest === right?.digest
    && left?.documentRevision === right?.documentRevision
    && left?.entityCount === right?.entityCount;
}

function stateCanonical(state) {
  try {
    return canonicalDocumentReceipt(state?.record);
  } catch {
    return null;
  }
}

function exactEvents(transaction, expected) {
  const events = Array.isArray(transaction?.events) ? transaction.events : [];
  return events.length === expected.length
    && events.every((event, index) => event?.type === expected[index]);
}

function transactionEvent(transaction, type) {
  return transaction?.events?.find((event) => event?.type === type) ?? null;
}

function exactProductTransactions(lifecycle) {
  const transactions = Array.isArray(lifecycle?.transactions) ? lifecycle.transactions : [];
  return lifecycle?.schemaVersion === 1
    && lifecycle.transactionCount === 3
    && transactions.length === 3
    && exactEvents(transactions[0], [
      "lease-prepared",
      "capture-source-fixed",
      "post-capture-revalidate",
      "lease-restored",
    ])
    && transactionEvent(transactions[0], "post-capture-revalidate")?.valid === false
    && exactEvents(transactions[1], [
      "lease-prepared",
      "capture-source-fixed",
      "post-capture-revalidate",
      "lease-restored",
      "image-encoded",
      "preview-published",
    ])
    && transactionEvent(transactions[1], "post-capture-revalidate")?.valid === true
    && exactEvents(transactions[2], [
      "lease-prepared",
      "capture-source-fixed",
      "post-capture-revalidate",
      "lease-restored",
      "image-encoded",
      "preview-published",
    ])
    && transactionEvent(transactions[2], "post-capture-revalidate")?.valid === true;
}

function exportBrowserStateExpression() {
  return `(() => {
    const perf = window.__CANDLESCOPE_DRAWING_PERF__;
    const controlled = window.__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__;
    const image = document.querySelector('.export-preview-image');
    const scale = Array.from(document.querySelectorAll('.export-segmented button'))
      .find((button) => button.classList.contains('active'))?.textContent?.trim() || null;
    return {
      observedAt: new Date().toISOString(),
      controlled: controlled && typeof controlled.snapshot === 'function'
        ? controlled.snapshot()
        : null,
      exportLifecycle: perf && typeof perf.readExportLifecycle === 'function'
        ? perf.readExportLifecycle()
        : null,
      runtime: perf && typeof perf.readPhase6Runtime === 'function'
        ? perf.readPhase6Runtime()
        : null,
      summary: perf && typeof perf.readRuntimeSummary === 'function'
        ? perf.readRuntimeSummary()
        : null,
      record: perf && typeof perf.readActivePersistenceDocumentRecord === 'function'
        ? perf.readActivePersistenceDocumentRecord()
        : null,
      chartType: document.querySelector('[data-pane-id="single-chart"]')?.dataset?.chartType || null,
      drawingsHidden: document.querySelector('[data-drawing-action="toggle-hidden"]')
        ?.classList.contains('active') === true,
      panel: {
        open: Boolean(document.querySelector('.export-panel')),
        loading: document.querySelector('.export-preview-frame')?.classList.contains('loading') === true,
        error: document.querySelector('.export-preview-error span')?.textContent?.trim()
          || document.querySelector('.export-panel-message.error')?.textContent?.trim()
          || null,
        imagePresent: image instanceof HTMLImageElement,
        imageSrc: image instanceof HTMLImageElement ? image.currentSrc || image.src : null,
        imageComplete: image instanceof HTMLImageElement ? image.complete && image.naturalWidth > 0 : false,
        hideDrawings: document.querySelector('[data-export-option="hide-drawings"]')?.checked === true,
        watermarkEnabled: document.querySelector('[data-export-option="watermark-enabled"]')?.checked === true,
        scope: document.querySelector('[data-export-scope].active')?.dataset?.exportScope || null,
        format: document.querySelector('[data-export-format].active')?.dataset?.exportFormat || null,
        scale,
        background: document.querySelector('[data-export-option="background"]')?.value || null
      }
    };
  })()`;
}

async function readState(session) {
  return session.cdp.evaluateJson(exportBrowserStateExpression());
}

function exactExportOptions(panel, hideDrawings) {
  return panel?.scope === "chart"
    && panel?.format === "png"
    && panel?.scale === "1x"
    && panel?.background === "auto"
    && panel?.watermarkEnabled === false
    && panel?.hideDrawings === hideDrawings;
}

async function installFixedExportPreferences(session) {
  const installed = await session.cdp.evaluateJson(`(() => {
    const key = 'candlescope-user-prefs';
    let prefs = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed;
    } catch {}
    prefs.chartExportOptions = {
      scope: 'chart',
      format: 'png',
      scale: 1,
      quality: 0.92,
      backgroundColor: 'auto',
      hideDrawings: false,
      watermarkEnabled: false,
      watermarkText: '',
      filenamePrefix: 'candlescope-phase9'
    };
    localStorage.setItem(key, JSON.stringify(prefs));
    return { stored: JSON.parse(localStorage.getItem(key) || '{}').chartExportOptions };
  })()`);
  if (installed?.stored?.scope !== "chart"
    || installed.stored.format !== "png"
    || installed.stored.scale !== 1
    || installed.stored.hideDrawings !== false
    || installed.stored.watermarkEnabled !== false) {
    throw new Error(`series-rebuild export preferences were not fixed: ${JSON.stringify(installed)}`);
  }
}

async function waitForSettledState(session, expectedDocument, timeoutMs, description) {
  return waitForSample(
    () => readState(session),
    (state) => sameCanonical(stateCanonical(state), expectedDocument)
      && state?.summary?.entityCount === expectedDocument.entityCount
      && state.summary.entityCount > 0
      && state.summary.effectiveEngineMode === "scene-canary"
      && state.summary.scenePublicationReady === true
      && state.drawingsHidden === false
      && runtimeCurrent(state.runtime),
    {
      timeoutMs,
      description,
      stableMs: 120,
      signature: (state) => `${runtimeSignature(state)}:${stateCanonical(state)?.digest}`,
    },
  );
}

async function openExportPanel(session) {
  const opened = await session.cdp.evaluate(`(() => {
    const button = document.querySelector('[data-drawing-action="export"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    if (!document.querySelector('.export-panel')) button.click();
    return true;
  })()`);
  if (opened !== true) throw new Error("series-rebuild export panel could not open");
}

async function clickPreviewRefresh(session) {
  const clicked = await session.cdp.evaluate(`(() => {
    const button = document.querySelector('.export-preview-refresh');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error("series-rebuild export preview refresh was unavailable");
}

async function setHideDrawingsOption(session, hidden) {
  const changed = await session.cdp.evaluate(`(() => {
    const input = document.querySelector('[data-export-option="hide-drawings"]');
    if (!(input instanceof HTMLInputElement) || input.disabled) return false;
    if (input.checked !== ${hidden ? "true" : "false"}) input.click();
    return input.checked === ${hidden ? "true" : "false"};
  })()`);
  if (changed !== true) throw new Error(`series-rebuild export hide-drawings=${hidden} was unavailable`);
}

async function releaseOldCaptureGate(session, controlled) {
  const gate = controlled?.seriesRebuildExport;
  const checkpointId = gate?.activeCheckpointId;
  const faultId = controlled?.faultId;
  if (!nonEmptyString(checkpointId) || !nonEmptyString(faultId)) {
    throw new Error(`series-rebuild export gate receipt is invalid: ${JSON.stringify(gate)}`);
  }
  const released = await session.cdp.evaluateJson(`(() => {
    const handle = window.__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__;
    return handle.releaseSeriesRebuildExportCapture({
      faultId: ${JSON.stringify(faultId)},
      checkpointId: ${JSON.stringify(checkpointId)}
    });
  })()`);
  if (released?.observed !== true
    || released?.seriesRebuildExport?.releaseCount !== 1
    || released?.seriesRebuildExport?.activeCheckpointId !== null
    || released?.seriesRebuildExport?.checkpoints?.[0]?.releaseReason !== "harness-release") {
    throw new Error(`series-rebuild export gate did not release exactly once: ${JSON.stringify(released)}`);
  }
}

async function closeExportPanelAndClearCache(session, timeoutMs) {
  await session.cdp.evaluate(`(() => {
    const close = document.querySelector('.export-panel-close');
    if (close instanceof HTMLButtonElement && !close.disabled) close.click();
    return true;
  })()`);

  let closed;
  try {
    closed = await waitForSample(
      () => readState(session),
      (state) => state?.panel?.open === false
        && state?.controlled?.seriesRebuildExport?.activeCheckpointId === null,
      {
        timeoutMs: Math.min(timeoutMs, 3_000),
        description: "series-rebuild export panel and capture gate cleanup",
        stableMs: 40,
      },
    );
  } catch (error) {
    const current = await readState(session);
    const gate = current?.controlled?.seriesRebuildExport;
    if (!nonEmptyString(gate?.activeCheckpointId) || !nonEmptyString(current?.controlled?.faultId)) {
      throw error;
    }
    await session.cdp.evaluateJson(`(() => {
      const handle = window.__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__;
      return handle.releaseSeriesRebuildExportCapture({
        faultId: ${JSON.stringify(current.controlled.faultId)},
        checkpointId: ${JSON.stringify(gate.activeCheckpointId)}
      });
    })()`);
    closed = await waitForSample(
      () => readState(session),
      (state) => state?.panel?.open === false
        && state?.controlled?.seriesRebuildExport?.activeCheckpointId === null,
      {
        timeoutMs: Math.min(timeoutMs, 3_000),
        description: "forced series-rebuild export gate cleanup",
        stableMs: 40,
      },
    );
  }

  const cacheCleared = await session.cdp.evaluate(`(() => {
    const cacheName = ${JSON.stringify(PIXEL_CACHE)};
    const cache = window[cacheName];
    if (cache && typeof cache === 'object') {
      for (const value of Object.values(cache)) {
        try { value?.pixels?.fill?.(0); } catch {}
      }
    }
    try { delete window[cacheName]; } catch {}
    return !Object.prototype.hasOwnProperty.call(window, cacheName);
  })()`);
  if (cacheCleared !== true || closed.value?.panel?.open !== false) {
    throw new Error("series-rebuild export page cleanup did not complete");
  }
  return Object.freeze({
    panelClosed: true,
    gateReleased: closed.value?.controlled?.seriesRebuildExport?.activeCheckpointId === null,
    pixelCacheCleared: true,
  });
}

function previewCaptureExpression(label) {
  return `(async () => {
    const label = ${JSON.stringify(label)};
    const cacheName = ${JSON.stringify(PIXEL_CACHE)};
    let cache = window[cacheName];
    if (!cache) {
      cache = Object.create(null);
      Object.defineProperty(window, cacheName, {
        value: cache,
        configurable: true,
        enumerable: false,
        writable: false
      });
    }
    const image = document.querySelector('.export-preview-image');
    const root = document.querySelector('[data-pane-id="single-chart"]');
    const perf = window.__CANDLESCOPE_DRAWING_PERF__;
    if (!(image instanceof HTMLImageElement) || !(root instanceof HTMLElement) || !perf) return null;
    if (!image.complete || image.naturalWidth <= 0) await image.decode();
    const response = await fetch(image.currentSrc || image.src);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = 'sha256:' + Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const lifecycle = perf.readExportLifecycle?.() || null;
    const transaction = lifecycle?.transactions?.at(-1) || null;
    const summary = perf.readRuntimeSummary?.() || null;
    const rootRectValue = root.getBoundingClientRect();
    const rootRect = {
      width: rootRectValue.width,
      height: rootRectValue.height
    };
    const receipt = {
      label,
      capturedAt: new Date().toISOString(),
      digest,
      bytes: bytes.byteLength,
      widthPx: canvas.width,
      heightPx: canvas.height,
      mimeType: blob.type,
      magicHex: Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      transactionId: transaction?.transactionId || null,
      leaseId: transaction?.leaseId ?? null,
      scopeKey: transaction?.scopeKey || null,
      documentRevision: transaction?.documentRevision ?? null,
      surfaceGeneration: transaction?.surfaceGeneration ?? null,
      sceneKind: transaction?.sceneKind || null,
      drawableEntityCount: transaction?.drawableEntityCount ?? null,
      optionsKey: transaction?.events?.find((event) => event.type === 'image-encoded')?.optionsKey || null,
      rootRect,
      mainPanePlotRect: summary?.mainPanePlotRect || null
    };
    cache[label] = { pixels, receipt, transaction, rootRect, summary };
    if (label !== 'hidden') return { receipt, comparison: null };
    const visible = cache.visible;
    if (!visible || visible.receipt.widthPx !== receipt.widthPx || visible.receipt.heightPx !== receipt.heightPx) {
      return { receipt, comparison: null };
    }
    const width = receipt.widthPx;
    const height = receipt.heightPx;
    const totalPixels = width * height;
    const scaleX = width / visible.rootRect.width;
    const scaleY = height / visible.rootRect.height;
    const mask = new Uint8Array(totalPixels);
    const drawingBounds = Array.isArray(visible.transaction?.drawingBounds)
      ? visible.transaction.drawingBounds
      : [];
    for (const bounds of drawingBounds) {
      const padding = Number(bounds.paddingCssPx) || 0;
      const left = Math.max(0, Math.floor((Number(bounds.leftCssPx) - padding) * scaleX));
      const top = Math.max(0, Math.floor((Number(bounds.topCssPx) - padding) * scaleY));
      const right = Math.min(width, Math.ceil((Number(bounds.rightCssPx) + padding) * scaleX));
      const bottom = Math.min(height, Math.ceil((Number(bounds.bottomCssPx) + padding) * scaleY));
      for (let y = top; y < bottom; y += 1) {
        mask.fill(1, y * width + left, y * width + right);
      }
    }
    let drawingPixelSampleCount = 0;
    let drawingPixelDiffCount = 0;
    let controlPixelSampleCount = 0;
    let controlPixelDiffCount = 0;
    let totalPixelDiffCount = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      const offset = pixel * 4;
      const differs = visible.pixels[offset] !== pixels[offset]
        || visible.pixels[offset + 1] !== pixels[offset + 1]
        || visible.pixels[offset + 2] !== pixels[offset + 2]
        || visible.pixels[offset + 3] !== pixels[offset + 3];
      if (mask[pixel] === 1) {
        drawingPixelSampleCount += 1;
        if (differs) drawingPixelDiffCount += 1;
      } else {
        controlPixelSampleCount += 1;
        if (differs) controlPixelDiffCount += 1;
      }
      if (differs) {
        totalPixelDiffCount += 1;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const plot = visible.summary?.mainPanePlotRect;
    let fixedControlPixelSampleCount = 0;
    let fixedControlPixelDiffCount = 0;
    if (plot && Number.isFinite(plot.x) && Number.isFinite(plot.width)
      && Number.isFinite(plot.y) && Number.isFinite(plot.height)) {
      const left = Math.max(0, Math.ceil((plot.x + plot.width + 2) * scaleX));
      const right = Math.min(width, Math.floor(visible.rootRect.width * scaleX));
      const top = Math.max(0, Math.ceil(plot.y * scaleY));
      const bottom = Math.min(height, Math.floor((plot.y + plot.height) * scaleY));
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * 4;
          fixedControlPixelSampleCount += 1;
          if (visible.pixels[offset] !== pixels[offset]
            || visible.pixels[offset + 1] !== pixels[offset + 1]
            || visible.pixels[offset + 2] !== pixels[offset + 2]
            || visible.pixels[offset + 3] !== pixels[offset + 3]) {
            fixedControlPixelDiffCount += 1;
          }
        }
      }
    }
    const boundsBytes = new TextEncoder().encode(JSON.stringify(drawingBounds));
    const boundsHash = new Uint8Array(await crypto.subtle.digest('SHA-256', boundsBytes));
    return {
      receipt,
      comparison: {
        algorithm: 'complete-frame-drawing-bounds-v1',
        completedAt: new Date().toISOString(),
        widthPx: width,
        heightPx: height,
        totalPixelCount: totalPixels,
        partitionPixelCount: drawingPixelSampleCount + controlPixelSampleCount,
        drawingBoundsCount: drawingBounds.length,
        drawingBoundsDigest: 'sha256:' + Array.from(boundsHash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        drawingPixelSampleCount,
        drawingPixelDiffCount,
        controlPixelSampleCount,
        controlPixelDiffCount,
        fixedControlKind: 'right-price-scale',
        fixedControlPixelSampleCount,
        fixedControlPixelDiffCount,
        totalPixelDiffCount,
        diffBounds: totalPixelDiffCount > 0
          ? { leftPx: minX, topPx: minY, rightPx: maxX, bottomPx: maxY }
          : null
      }
    };
  })()`;
}

async function capturePreview(session, label) {
  const capture = await session.cdp.evaluateJson(previewCaptureExpression(label));
  if (!capture?.receipt
    || !nonEmptyString(capture.receipt.digest)
    || capture.receipt.mimeType !== "image/png"
    || capture.receipt.magicHex !== "89504e470d0a1a0a"
    || !Number.isSafeInteger(capture.receipt.bytes)
    || capture.receipt.bytes <= 0
    || !Number.isSafeInteger(capture.receipt.widthPx)
    || capture.receipt.widthPx <= 0
    || !Number.isSafeInteger(capture.receipt.heightPx)
    || capture.receipt.heightPx <= 0) {
    throw new Error(`series-rebuild ${label} PNG capture is invalid: ${JSON.stringify(capture)}`);
  }
  return Object.freeze(capture);
}

function transactionFields(transaction) {
  return {
    transactionId: transaction.transactionId,
    leaseId: transaction.leaseId,
    scopeKey: transaction.scopeKey,
    documentRevision: transaction.documentRevision,
    surfaceGeneration: transaction.surfaceGeneration,
    sceneKind: transaction.sceneKind,
  };
}

function checkpointEvents(
  lifecycle,
  rebuild,
  visiblePng,
  hiddenPng,
  comparison,
) {
  const [oldAttempt, visibleAttempt, hiddenAttempt] = lifecycle.transactions;
  const oldPrepared = transactionEvent(oldAttempt, "lease-prepared");
  const oldFixed = transactionEvent(oldAttempt, "capture-source-fixed");
  const oldRevalidate = transactionEvent(oldAttempt, "post-capture-revalidate");
  const oldRestored = transactionEvent(oldAttempt, "lease-restored");
  const visiblePrepared = transactionEvent(visibleAttempt, "lease-prepared");
  const visibleFixed = transactionEvent(visibleAttempt, "capture-source-fixed");
  const visibleRevalidate = transactionEvent(visibleAttempt, "post-capture-revalidate");
  const visibleRestored = transactionEvent(visibleAttempt, "lease-restored");
  const visibleEncoded = transactionEvent(visibleAttempt, "image-encoded");
  const hiddenPrepared = transactionEvent(hiddenAttempt, "lease-prepared");
  const hiddenFixed = transactionEvent(hiddenAttempt, "capture-source-fixed");
  const hiddenRevalidate = transactionEvent(hiddenAttempt, "post-capture-revalidate");
  const hiddenRestored = transactionEvent(hiddenAttempt, "lease-restored");
  const hiddenEncoded = transactionEvent(hiddenAttempt, "image-encoded");
  const values = [
    { type: CHECKPOINT_TYPES[0], observedAt: oldPrepared.observedAt, ...transactionFields(oldAttempt), productEventSequence: oldPrepared.eventSequence },
    { type: CHECKPOINT_TYPES[1], observedAt: rebuild.startedAt, fromSurfaceGeneration: oldAttempt.surfaceGeneration, beforeChartType: rebuild.beforeChartType, afterChartType: rebuild.afterChartType },
    { type: CHECKPOINT_TYPES[2], observedAt: rebuild.completedAt, fromSurfaceGeneration: oldAttempt.surfaceGeneration, surfaceGeneration: rebuild.surfaceGeneration, beforeChartType: rebuild.beforeChartType, afterChartType: rebuild.afterChartType },
    { type: CHECKPOINT_TYPES[3], observedAt: oldFixed.observedAt, ...transactionFields(oldAttempt), capturedSurfaceGeneration: rebuild.surfaceGeneration, productEventSequence: oldFixed.eventSequence },
    { type: CHECKPOINT_TYPES[4], observedAt: oldRevalidate.observedAt, ...transactionFields(oldAttempt), valid: oldRevalidate.valid, productEventSequence: oldRevalidate.eventSequence },
    { type: CHECKPOINT_TYPES[5], observedAt: oldRestored.observedAt, ...transactionFields(oldAttempt), productEventSequence: oldRestored.eventSequence },
    { type: CHECKPOINT_TYPES[6], observedAt: visiblePrepared.observedAt, ...transactionFields(visibleAttempt), productEventSequence: visiblePrepared.eventSequence },
    { type: CHECKPOINT_TYPES[7], observedAt: visibleFixed.observedAt, ...transactionFields(visibleAttempt), productEventSequence: visibleFixed.eventSequence },
    { type: CHECKPOINT_TYPES[8], observedAt: visibleRevalidate.observedAt, ...transactionFields(visibleAttempt), valid: visibleRevalidate.valid, productEventSequence: visibleRevalidate.eventSequence },
    { type: CHECKPOINT_TYPES[9], observedAt: visibleRestored.observedAt, ...transactionFields(visibleAttempt), productEventSequence: visibleRestored.eventSequence },
    { type: CHECKPOINT_TYPES[10], observedAt: visibleEncoded.observedAt, ...transactionFields(visibleAttempt), png: visiblePng, productEventSequence: visibleEncoded.eventSequence },
    { type: CHECKPOINT_TYPES[11], observedAt: hiddenPrepared.observedAt, ...transactionFields(hiddenAttempt), productEventSequence: hiddenPrepared.eventSequence },
    { type: CHECKPOINT_TYPES[12], observedAt: hiddenFixed.observedAt, ...transactionFields(hiddenAttempt), productEventSequence: hiddenFixed.eventSequence },
    { type: CHECKPOINT_TYPES[13], observedAt: hiddenRevalidate.observedAt, ...transactionFields(hiddenAttempt), valid: hiddenRevalidate.valid, productEventSequence: hiddenRevalidate.eventSequence },
    { type: CHECKPOINT_TYPES[14], observedAt: hiddenRestored.observedAt, ...transactionFields(hiddenAttempt), productEventSequence: hiddenRestored.eventSequence },
    { type: CHECKPOINT_TYPES[15], observedAt: hiddenEncoded.observedAt, ...transactionFields(hiddenAttempt), png: hiddenPng, productEventSequence: hiddenEncoded.eventSequence },
    { type: CHECKPOINT_TYPES[16], observedAt: comparison.completedAt, comparison },
  ];
  return Object.freeze(values.map((event, index) => Object.freeze({
    eventSequence: index + 1,
    ...event,
  })));
}

function runtimeOutcome(before, after, state, rebuildGeneration) {
  const runtime = state.runtime;
  return Object.freeze({
    scopeKey: after.scopeKey,
    beforeDigest: before.digest,
    afterDigest: after.digest,
    beforeDocumentRevision: before.documentRevision,
    afterDocumentRevision: after.documentRevision,
    beforeEntityCount: before.entityCount,
    afterEntityCount: after.entityCount,
    surfaceGeneration: rebuildGeneration,
    backend: runtime?.backend ?? null,
    workerAvailability: runtime?.workerAvailability ?? null,
    queueDepthCurrent: runtime?.queueDepthCurrent ?? null,
    inFlightCurrent: runtime?.inFlightCurrent ?? null,
    stalePublishCount: runtime?.stalePublishCount ?? null,
    lastRequestedStamp: runtime?.lastRequestedStamp ?? null,
    lastPublishedStamp: runtime?.lastPublishedStamp ?? null,
    lastPaintedStamp: runtime?.lastPaintedStamp ?? null,
    paintReceipt: runtime?.paintReceipt ?? null,
    submittedWorkerHeaders: Array.isArray(runtime?.submittedWorkerHeaders)
      ? runtime.submittedWorkerHeaders
      : null,
    latestSubmittedWorkerIdentity: runtime?.latestSubmittedWorkerIdentity ?? null,
    returnedWorkerIdentity: runtime?.returnedWorkerIdentity ?? null,
    acceptedWorkerIdentity: runtime?.acceptedWorkerIdentity ?? null,
    publishedWorkerIdentity: runtime?.publishedWorkerIdentity ?? null,
    exportLifecycleActiveCount: state.exportLifecycle?.transactions?.filter((transaction) => (
      !transaction.events?.some((event) => event.type === "lease-restored")
    )).length ?? null,
    drawingsHidden: state.drawingsHidden === true,
    scenePublicationReady: state.summary?.scenePublicationReady === true,
  });
}

function injectionReceipt(navigation, controlled, buildAuthorityCurrent) {
  const gate = controlled?.seriesRebuildExport;
  const checkpoints = Array.isArray(gate?.checkpoints) ? gate.checkpoints : [];
  return Object.freeze({
    kind: "series-rebuild-before-export-capture",
    armed: navigation?.bootstrap?.armed === true
      && navigation.bootstrap?.authorityAccepted === true,
    observed: controlled?.observed === true
      && gate?.pauseConsumed === true
      && gate?.releaseCount === 1
      && checkpoints.length === 3
      && checkpoints[0]?.paused === true
      && checkpoints[0]?.releaseReason === "harness-release"
      && checkpoints.slice(1).every((checkpoint) => checkpoint?.paused === false),
    buildAuthorityCurrent: buildAuthorityCurrent === true,
    runId: controlled?.runId ?? null,
    authorityTokenSha256: controlled?.authorityTokenSha256
      ? `sha256:${controlled.authorityTokenSha256}`
      : null,
    documentInstanceId: controlled?.documentInstanceId ?? null,
    faultId: controlled?.faultId ?? null,
    sequence: controlled?.sequence ?? null,
    navigation: Object.freeze({
      kind: navigation?.kind ?? null,
      runId: navigation?.runId ?? null,
      drillId: navigation?.drillId ?? null,
      variant: navigation?.variant ?? null,
      faultId: navigation?.faultId ?? null,
      sequence: navigation?.sequence ?? null,
      authorityTokenSha256: navigation?.authorityTokenSha256
        ? `sha256:${navigation.authorityTokenSha256}`
        : null,
      authorityAccepted: navigation?.bootstrap?.authorityAccepted === true,
      tokenRemoved: navigation?.bootstrap?.tokenRemoved === true,
      documentInstanceId: navigation?.bootstrap?.documentInstanceId ?? null,
    }),
    gate: Object.freeze({
      checkpointCount: gate?.checkpointCount ?? null,
      pauseConsumed: gate?.pauseConsumed === true,
      releaseCount: gate?.releaseCount ?? null,
      activeCheckpointId: gate?.activeCheckpointId ?? null,
      checkpoints: Object.freeze(checkpoints.map((checkpoint) => Object.freeze({ ...checkpoint }))),
    }),
  });
}

export async function runControlledExportRollbackDrills(
  session,
  { timeoutMs = 45_000, beforeDocument } = {},
) {
  if (!beforeDocument
    || !nonEmptyString(beforeDocument.scopeKey)
    || !nonEmptyString(beforeDocument.digest)
    || !Number.isSafeInteger(beforeDocument.documentRevision)
    || !Number.isSafeInteger(beforeDocument.entityCount)
    || beforeDocument.entityCount <= 0) {
    throw new TypeError("controlled series-rebuild export requires a non-empty authoritative document");
  }
  const startedAt = new Date().toISOString();
  let stage = "install-export-preferences";
  let pageCleanup = null;
  let pageCleanupComplete = false;
  try {
    await installFixedExportPreferences(session);
    stage = "navigate";
    const navigation = await session.navigateRollbackDrill(DRILL_ID);
    stage = "baseline";
    let baseline = await waitForSettledState(
      session,
      beforeDocument,
      timeoutMs,
      "series-rebuild export navigation baseline",
    );
    if (baseline.value.chartType !== "candlestick") {
      stage = "normalize-chart-type";
      await switchChartType(session, "candlestick", timeoutMs);
      baseline = await waitForSettledState(
        session,
        beforeDocument,
        timeoutMs,
        "series-rebuild export candlestick baseline",
      );
    }
    const canonicalBefore = stateCanonical(baseline.value);
    if (!sameCanonical(canonicalBefore, beforeDocument)) {
      throw new Error("series-rebuild export canonical baseline drifted");
    }

    stage = "open-export-panel";
    await openExportPanel(session);
    stage = "await-old-prepare-gate";
    const gated = await waitForSample(
      () => readState(session),
      (state) => {
        const transactions = state?.exportLifecycle?.transactions;
        const old = transactions?.[0];
        const gate = state?.controlled?.seriesRebuildExport;
        return state?.panel?.open === true
          && exactExportOptions(state.panel, false)
          && state.panel.imagePresent === false
          && state.exportLifecycle?.transactionCount === 1
          && Array.isArray(transactions)
          && transactions.length === 1
          && exactEvents(old, ["lease-prepared"])
          && old.sceneKind === "settled-exact"
          && Number.isSafeInteger(old.surfaceGeneration)
          && old.surfaceGeneration > 0
          && old.drawableEntityCount > 0
          && gate?.checkpointCount === 1
          && gate.pauseConsumed === true
          && gate.releaseCount === 0
          && nonEmptyString(gate.activeCheckpointId)
          && gate.checkpoints?.[0]?.transactionId === old.transactionId
          && gate.checkpoints?.[0]?.leaseId === old.leaseId
          && sameCanonical(stateCanonical(state), canonicalBefore)
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: "old export lease capture gate",
        stableMs: 80,
        signature: (state) => JSON.stringify({
          lifecycle: state?.exportLifecycle,
          gate: state?.controlled?.seriesRebuildExport,
          runtime: runtimeSignature(state),
        }),
      },
    );
    const oldAttempt = gated.value.exportLifecycle.transactions[0];
    const oldGeneration = oldAttempt.surfaceGeneration;

    stage = "series-rebuild-start";
    const rebuildStartedAt = await session.cdp.evaluate("new Date().toISOString()");
    const chartTransition = await switchChartType(session, "line", timeoutMs);
    if (chartTransition.beforeValue !== "candlestick"
      || chartTransition.afterValue !== "line"
      || chartTransition.changed !== true) {
      throw new Error(`series-rebuild export chart transition is invalid: ${JSON.stringify(chartTransition)}`);
    }
    stage = "series-rebuild-convergence";
    const rebuilt = await waitForSample(
      () => readState(session),
      (state) => {
        const stamp = state?.runtime?.lastPaintedStamp;
        return state?.chartType === "line"
          && Number.isSafeInteger(stamp?.surfaceGeneration)
          && stamp.surfaceGeneration > oldGeneration
          && state.exportLifecycle?.transactionCount === 1
          && exactEvents(state.exportLifecycle.transactions?.[0], ["lease-prepared"])
          && state.controlled?.seriesRebuildExport?.activeCheckpointId
            === gated.value.controlled.seriesRebuildExport.activeCheckpointId
          && sameCanonical(stateCanonical(state), canonicalBefore)
          && state.summary?.entityCount === canonicalBefore.entityCount
          && state.summary?.scenePublicationReady === true
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: "series replacement exact drawing convergence",
        stableMs: 140,
        signature: (state) => `${state?.chartType}:${runtimeSignature(state)}`,
      },
    );
    const rebuildGeneration = rebuilt.value.runtime.lastPaintedStamp.surfaceGeneration;
    const rebuildCompletedAt = rebuilt.value.observedAt;

    stage = "release-old-capture";
    await releaseOldCaptureGate(session, rebuilt.value.controlled);
    stage = "stale-preview-discard";
    const stale = await waitForSample(
      () => readState(session),
      (state) => {
        const transaction = state?.exportLifecycle?.transactions?.[0];
        return state?.exportLifecycle?.transactionCount === 1
          && exactEvents(transaction, [
            "lease-prepared",
            "capture-source-fixed",
            "post-capture-revalidate",
            "lease-restored",
          ])
          && transactionEvent(transaction, "post-capture-revalidate")?.valid === false
          && state.panel?.loading === false
          && state.panel.imagePresent === false
          && /绘图在截图期间发生变化/.test(state.panel.error || "")
          && state.controlled?.seriesRebuildExport?.releaseCount === 1
          && state.controlled.seriesRebuildExport.activeCheckpointId === null
          && sameCanonical(stateCanonical(state), canonicalBefore)
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: "stale export preview rejection",
        stableMs: 100,
        signature: (state) => JSON.stringify({
          lifecycle: state?.exportLifecycle,
          panel: state?.panel,
          runtime: runtimeSignature(state),
        }),
      },
    );
    const staleDiscard = Object.freeze({
      observedAt: stale.value.observedAt,
      error: stale.value.panel.error,
      previewPublished: stale.value.panel.imagePresent,
      encoded: transactionEvent(stale.value.exportLifecycle.transactions[0], "image-encoded") !== null,
      productPreviewPublished: transactionEvent(
        stale.value.exportLifecycle.transactions[0],
        "preview-published",
      ) !== null,
    });

    stage = "fresh-visible-preview";
    await clickPreviewRefresh(session);
    await waitForSample(
      () => readState(session),
      (state) => {
        const transactions = state?.exportLifecycle?.transactions;
        const old = transactions?.[0];
        const transaction = transactions?.[1];
        return state.exportLifecycle?.transactionCount === 2
          && exactEvents(old, [
            "lease-prepared",
            "capture-source-fixed",
            "post-capture-revalidate",
            "lease-restored",
          ])
          && transactionEvent(old, "post-capture-revalidate")?.valid === false
          && exactEvents(transaction, [
            "lease-prepared",
            "capture-source-fixed",
            "post-capture-revalidate",
            "lease-restored",
            "image-encoded",
            "preview-published",
          ])
          && transactionEvent(transaction, "post-capture-revalidate")?.valid === true
          && transaction.hideDrawings === false
          && transaction.surfaceGeneration === rebuildGeneration
          && transaction.sceneKind === "settled-exact"
          && transaction.drawableEntityCount > 0
          && transaction.leaseId !== transactions?.[0]?.leaseId
          && state.panel?.loading === false
          && state.panel.error === null
          && state.panel.imagePresent === true
          && state.panel.imageComplete === true
          && exactExportOptions(state.panel, false)
          && sameCanonical(stateCanonical(state), canonicalBefore)
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: "fresh visible export preview",
        stableMs: 100,
        signature: (state) => JSON.stringify({
          lifecycle: state?.exportLifecycle,
          panel: state?.panel,
          runtime: runtimeSignature(state),
        }),
      },
    );
    const visibleCapture = await capturePreview(session, "visible");

    stage = "fresh-hidden-preview";
    await setHideDrawingsOption(session, true);
    await waitForSample(
      () => readState(session),
      (state) => {
        const transactions = state?.exportLifecycle?.transactions;
        const transaction = transactions?.[2];
        return exactProductTransactions(state.exportLifecycle)
          && transaction.hideDrawings === true
          && transaction.sceneKind === "hidden-frame"
          && transaction.drawableEntityCount === 0
          && new Set(transactions.map((value) => value.leaseId)).size === 3
          && state.controlled?.seriesRebuildExport?.checkpointCount === 3
          && state.controlled.seriesRebuildExport.releaseCount === 1
          && state.panel?.loading === false
          && state.panel.error === null
          && state.panel.imagePresent === true
          && state.panel.imageComplete === true
          && exactExportOptions(state.panel, true)
          && state.drawingsHidden === false
          && sameCanonical(stateCanonical(state), canonicalBefore)
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: "fresh hidden-drawing control preview",
        stableMs: 120,
        signature: (state) => JSON.stringify({
          lifecycle: state?.exportLifecycle,
          panel: state?.panel,
          gate: state?.controlled?.seriesRebuildExport,
          runtime: runtimeSignature(state),
        }),
      },
    );
    const hiddenCapture = await capturePreview(session, "hidden");
    const comparison = hiddenCapture.comparison;
    if (visibleCapture.receipt.digest === hiddenCapture.receipt.digest
      || comparison?.algorithm !== "complete-frame-drawing-bounds-v1"
      || comparison.drawingBoundsCount <= 0
      || comparison.partitionPixelCount !== comparison.totalPixelCount
      || comparison.drawingPixelSampleCount <= 0
      || comparison.drawingPixelDiffCount <= 0
      || comparison.controlPixelSampleCount <= 0
      || comparison.controlPixelDiffCount !== 0
      || comparison.fixedControlPixelSampleCount < 512
      || comparison.fixedControlPixelDiffCount !== 0
      || comparison.totalPixelDiffCount !== comparison.drawingPixelDiffCount) {
      throw new Error(`series-rebuild export pixel oracle failed: ${JSON.stringify(comparison)}`);
    }

    stage = "final-convergence";
    const final = await waitForSettledState(
      session,
      canonicalBefore,
      timeoutMs,
      "series-rebuild export final visible runtime",
    );
    if (final.value.runtime.lastPaintedStamp?.surfaceGeneration !== rebuildGeneration
      || final.value.chartType !== "line"
      || !exactProductTransactions(final.value.exportLifecycle)) {
      throw new Error("series-rebuild export final runtime or lifecycle drifted");
    }
    const canonicalAfter = stateCanonical(final.value);
    const productLifecycle = Object.freeze(final.value.exportLifecycle);
    const rebuild = Object.freeze({
      startedAt: rebuildStartedAt,
      completedAt: rebuildCompletedAt,
      beforeChartType: chartTransition.beforeValue,
      afterChartType: chartTransition.afterValue,
      fromSurfaceGeneration: oldGeneration,
      surfaceGeneration: rebuildGeneration,
      requestedStamp: rebuilt.value.runtime.lastRequestedStamp,
      publishedStamp: rebuilt.value.runtime.lastPublishedStamp,
      paintedStamp: rebuilt.value.runtime.lastPaintedStamp,
      paintReceipt: rebuilt.value.runtime.paintReceipt,
    });
    const events = checkpointEvents(
      productLifecycle,
      rebuild,
      Object.freeze(visibleCapture.receipt),
      Object.freeze(hiddenCapture.receipt),
      Object.freeze(comparison),
    );
    stage = "close-export-panel";
    pageCleanup = await closeExportPanelAndClearCache(session, timeoutMs);
    pageCleanupComplete = true;
    stage = "build-authority";
    const windowEvidence = await session.verifyWindow();
    const buildAuthority = await captureDrillBuildAuthority(session, DRILL_ID);
    const controlled = final.value.controlled;
    const artifact = commonArtifact(
      session,
      DRILL_ID,
      startedAt,
      windowEvidence,
      buildAuthority,
      injectionReceipt(navigation, controlled, buildAuthority.authoritative),
      {
        checkpointEvents: events,
        productLifecycle,
        rebuild,
        staleDiscard,
        pageCleanup,
        captures: Object.freeze({
          visible: Object.freeze(visibleCapture.receipt),
          hidden: Object.freeze(hiddenCapture.receipt),
          comparison: Object.freeze(comparison),
          options: Object.freeze({
            scope: "chart",
            format: "png",
            scale: 1,
            background: "auto",
            watermarkEnabled: false,
            visibleHideDrawings: false,
            hiddenHideDrawings: true,
          }),
          drawingBoundsDigest: comparison.drawingBoundsDigest,
        }),
        outcome: runtimeOutcome(canonicalBefore, canonicalAfter, final.value, rebuildGeneration),
      },
    );
    return Object.freeze({
      drills: Object.freeze([artifact]),
      finalDocument: Object.freeze(canonicalAfter),
    });
  } catch (error) {
    throw new Error(
      `series-rebuild export stage ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (!pageCleanupComplete) {
      try {
        await closeExportPanelAndClearCache(session, timeoutMs);
      } catch {
        // The outer controlled runner still owns browser/process/profile teardown.
      }
    }
  }
}

export {
  CHECKPOINT_TYPES as SERIES_REBUILD_EXPORT_CHECKPOINT_TYPES,
  checkpointEvents as buildSeriesRebuildExportCheckpointEvents,
  exactProductTransactions as seriesRebuildProductLifecycleAccepted,
  injectionReceipt as buildSeriesRebuildExportInjectionReceipt,
};
