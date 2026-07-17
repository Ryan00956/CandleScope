/**
 * Installed in the benchmark page through CDP. Keep this function completely
 * self-contained: drawing-performance.mjs serializes it with toString().
 */
export function phase5BrowserProbeBootstrap() {
  window.__CANDLESCOPE_PHASE5_PROBE__?.stop?.();
  const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
  if (!drawingHandle?.report) {
    return { started: false, reason: "drawing-perf-handle-missing" };
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const finitePoint = (point) => point
    && Number.isFinite(point.x)
    && Number.isFinite(point.y);
  const canvasFor = (kind) => document.querySelector(
    `[data-drawing-overlay="${kind}"]`,
  );
  const chart = () => document.querySelector(
    ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
      + ".chart-pane[data-pane-id=\"single-chart\"]",
  );
  const rectSnapshot = (rect) => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  });
  const nearlyEqual = (left, right, tolerance = 0.51) => (
    Number.isFinite(left)
      && Number.isFinite(right)
      && Math.abs(left - right) <= tolerance
  );
  const canvasSnapshot = (kind) => {
    const canvas = canvasFor(kind);
    if (!(canvas instanceof HTMLCanvasElement)) {
      return {
        present: false,
        pointerEventsNone: false,
        dprSynchronized: false,
        cssRect: null,
        bitmap: null,
        opacity: null,
        mixBlendMode: null,
      };
    }
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const expectedWidth = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const expectedHeight = Math.max(1, Math.round(rect.height * devicePixelRatio));
    return {
      present: true,
      pointerEventsNone: style.pointerEvents === "none",
      dprSynchronized: rect.width > 0
        && rect.height > 0
        && canvas.width === expectedWidth
        && canvas.height === expectedHeight,
      cssRect: rectSnapshot(rect),
      bitmap: { width: canvas.width, height: canvas.height },
      opacity: Number.parseFloat(style.opacity),
      mixBlendMode: style.mixBlendMode || null,
    };
  };
  const surfaceSnapshot = () => {
    const host = document.querySelector(".drawing-interaction-overlay");
    const chartElement = chart();
    const dynamic = canvasSnapshot("dynamic");
    const liveInk = canvasSnapshot("live-ink");
    const chartRect = chartElement
      ? rectSnapshot(chartElement.getBoundingClientRect())
      : null;
    const hostRect = host ? rectSnapshot(host.getBoundingClientRect()) : null;
    const runtimeSummary = drawingHandle.readRuntimeSummary?.() || null;
    const adapterPlotRect = runtimeSummary?.mainPanePlotRect ?? null;
    const expectedPlotRect = hostRect && adapterPlotRect ? {
      x: hostRect.x + adapterPlotRect.x,
      y: hostRect.y + adapterPlotRect.y,
      width: adapterPlotRect.width,
      height: adapterPlotRect.height,
      right: hostRect.x + adapterPlotRect.x + adapterPlotRect.width,
      bottom: hostRect.y + adapterPlotRect.y + adapterPlotRect.height,
    } : null;
    const sameCssRect = Boolean(dynamic.cssRect && liveInk.cssRect
      && nearlyEqual(dynamic.cssRect.x, liveInk.cssRect.x)
      && nearlyEqual(dynamic.cssRect.y, liveInk.cssRect.y)
      && nearlyEqual(dynamic.cssRect.width, liveInk.cssRect.width)
      && nearlyEqual(dynamic.cssRect.height, liveInk.cssRect.height));
    const insideChartRect = Boolean(chartRect && dynamic.cssRect
      && dynamic.cssRect.width > 0
      && dynamic.cssRect.height > 0
      && dynamic.cssRect.x >= chartRect.x - 0.51
      && dynamic.cssRect.y >= chartRect.y - 0.51
      && dynamic.cssRect.right <= chartRect.right + 0.51
      && dynamic.cssRect.bottom <= chartRect.bottom + 0.51);
    const plotSized = Boolean(chartRect && dynamic.cssRect
      && dynamic.cssRect.width >= chartRect.width * 0.7
      && dynamic.cssRect.height >= chartRect.height * 0.7);
    const exactAdapterPlotRect = Boolean(expectedPlotRect && dynamic.cssRect
      && nearlyEqual(dynamic.cssRect.x, expectedPlotRect.x)
      && nearlyEqual(dynamic.cssRect.y, expectedPlotRect.y)
      && nearlyEqual(dynamic.cssRect.width, expectedPlotRect.width)
      && nearlyEqual(dynamic.cssRect.height, expectedPlotRect.height));
    const adapterDprMatches = Boolean(adapterPlotRect
      && nearlyEqual(adapterPlotRect.dpr, devicePixelRatio, 0.001));
    const sceneCanaryPublicationActive = runtimeSummary?.effectiveEngineMode === "scene-canary"
      && runtimeSummary?.scenePublicationReady === true;
    return {
      overlayCount: document.querySelectorAll("[data-drawing-overlay]").length,
      hostPresent: Boolean(host),
      hostPointerEventsNone: Boolean(host && getComputedStyle(host).pointerEvents === "none"),
      devicePixelRatio,
      chartRect,
      hostRect,
      adapterPlotRect,
      expectedPlotRect,
      runtimeSummary,
      dynamic,
      liveInk,
      sameCssRect,
      insideChartRect,
      plotSized,
      exactAdapterPlotRect,
      adapterDprMatches,
      sceneCanaryPublicationActive,
    };
  };

  const readCounters = () => {
    const report = drawingHandle.report() || {};
    const counters = report.counters || {};
    const count = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    return {
      requestUpdates: count(counters.requestUpdateCount),
      reactRenders: count(counters.reactRenderCount),
      sceneRebuilds: count(counters.sceneRebuildCount),
    };
  };
  const counterDelta = (current, baseline) => (
    Number.isFinite(current) && Number.isFinite(baseline) && current >= baseline
      ? current - baseline
      : null
  );
  const readHandoff = () => {
    const snapshot = drawingHandle.readInteractionHandoff?.() || {};
    return clone({
      prepared: snapshot.prepared ?? null,
      acknowledged: snapshot.acknowledged ?? null,
    });
  };
  const sameStamp = (left, right) => Boolean(left && right
    && left.scopeKey === right.scopeKey
    && left.documentRevision === right.documentRevision
    && left.surfaceGeneration === right.surfaceGeneration
    && left.viewportRevision === right.viewportRevision);

  const watchPoints = { dynamic: [], "live-ink": [] };
  const setWatchPoints = (kind, points) => {
    if (!(kind in watchPoints)) return false;
    watchPoints[kind] = Array.isArray(points)
      ? points.filter(finitePoint).slice(0, 32).map((point) => ({ x: point.x, y: point.y }))
      : [];
    return watchPoints[kind].length > 0;
  };
  const sampleCanvas = (kind) => {
    const canvas = canvasFor(kind);
    const points = watchPoints[kind] || [];
    if (!(canvas instanceof HTMLCanvasElement) || points.length === 0) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
      return false;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    for (const point of points) {
      const centerX = Math.round(((point.x - rect.x) / rect.width) * canvas.width);
      const centerY = Math.round(((point.y - rect.y) / rect.height) * canvas.height);
      const radius = Math.max(3, Math.ceil(devicePixelRatio * 6));
      const left = Math.max(0, centerX - radius);
      const top = Math.max(0, centerY - radius);
      const width = Math.min(canvas.width - left, radius * 2 + 1);
      const height = Math.min(canvas.height - top, radius * 2 + 1);
      if (width <= 0 || height <= 0) continue;
      const pixels = context.getImageData(left, top, width, height).data;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) return true;
      }
    }
    return false;
  };

  let active = true;
  let frameHandle = null;
  let frameCount = 0;
  let pointerMoveWindow = null;
  const pointerMoveWindows = [];
  const handoffs = [];
  let liveInkEverVisible = false;
  let dynamicOverlayEverVisible = false;
  let highlighterOpacityObserved = null;
  let liveInkOpacityObserved = null;
  let liveInkBlendModeObserved = null;
  const initialSurface = surfaceSnapshot();

  const tick = () => {
    if (!active) return;
    frameCount += 1;
    const liveVisible = sampleCanvas("live-ink");
    const dynamicVisible = sampleCanvas("dynamic");
    liveInkEverVisible ||= liveVisible;
    dynamicOverlayEverVisible ||= dynamicVisible;
    if (liveVisible) {
      const opacity = Number.parseFloat(getComputedStyle(canvasFor("live-ink")).opacity);
      const blendMode = getComputedStyle(canvasFor("live-ink")).mixBlendMode || "normal";
      if (Number.isFinite(opacity)) liveInkOpacityObserved = opacity;
      liveInkBlendModeObserved = blendMode;
      if (Number.isFinite(opacity) && opacity > 0 && opacity < 1) {
        highlighterOpacityObserved = highlighterOpacityObserved === null
          ? opacity
          : Math.min(highlighterOpacityObserved, opacity);
      }
    }
    for (const handoff of handoffs) {
      if (!handoff.tracking) continue;
      const visible = handoff.kind === "live-ink" ? liveVisible : dynamicVisible;
      if (visible) {
        handoff.retainedFrameCount += 1;
      } else {
        handoff.clearObserved = true;
        const acknowledged = readHandoff().acknowledged;
        if (acknowledged
          && acknowledged.sequence === handoff.preparedSequence
          && acknowledged.kind === handoff.kind
          && sameStamp(acknowledged.stamp, handoff.expectedTicket)) {
          handoff.paintAdvancedBeforeClear = true;
          handoff.exactAckBeforeClear = true;
          handoff.tracking = false;
          handoff.clearedAtFrame = frameCount;
        } else {
          handoff.blankFrameCount += 1;
        }
      }
    }
    frameHandle = requestAnimationFrame(tick);
  };
  frameHandle = requestAnimationFrame(tick);

  const controller = {
    setWatchPoints,
    async settleReactRenders() {
      if (!active) return false;
      let previous = readCounters().reactRenders;
      let stableFrames = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const current = readCounters().reactRenders;
        if (!Number.isFinite(current)) return false;
        if (current === previous) stableFrames += 1;
        else stableFrames = 0;
        previous = current;
        // Tool activation, lazy drawing-engine state and toolbar click timers
        // can commit after a couple of paints. Require a full 200 ms-equivalent
        // quiet window at 60 Hz before attributing renders to pointermove.
        if (stableFrames >= 12) return true;
      }
      return false;
    },
    beginPointerMoveWindow(label) {
      if (!active || pointerMoveWindow) return false;
      pointerMoveWindow = {
        label: String(label || "pointermove"),
        baseline: readCounters(),
        startedAtFrame: frameCount,
      };
      return true;
    },
    async endPointerMoveWindow() {
      if (!active || !pointerMoveWindow) return null;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const current = readCounters();
      const record = {
        label: pointerMoveWindow.label,
        observedFrameIntervals: Math.max(0, frameCount - pointerMoveWindow.startedAtFrame),
        requestUpdateDelta: counterDelta(
          current.requestUpdates,
          pointerMoveWindow.baseline.requestUpdates,
        ),
        reactRenderDelta: counterDelta(
          current.reactRenders,
          pointerMoveWindow.baseline.reactRenders,
        ),
        sceneRebuildDelta: counterDelta(
          current.sceneRebuilds,
          pointerMoveWindow.baseline.sceneRebuilds,
        ),
      };
      pointerMoveWindows.push(record);
      pointerMoveWindow = null;
      return clone(record);
    },
    prepareHandoff(kind, point) {
      if (!active || !(kind in watchPoints) || !finitePoint(point)) return false;
      setWatchPoints(kind, [point]);
      const visibleBeforeCommit = sampleCanvas(kind);
      const previousHandoff = readHandoff().prepared;
      handoffs.push({
        kind,
        visibleBeforeCommit,
        visibleImmediatelyAfterCommit: false,
        preparedSequenceBeforeCommit: Number(previousHandoff?.sequence) || 0,
        preparedSequence: null,
        expectedTicket: null,
        exactTicketObserved: false,
        exactAckBeforeClear: false,
        retainedFrameCount: 0,
        blankFrameCount: 0,
        clearObserved: false,
        paintAdvancedBeforeClear: false,
        tracking: false,
        committedAtFrame: null,
        clearedAtFrame: null,
      });
      return visibleBeforeCommit;
    },
    markCommitted() {
      const handoff = handoffs.at(-1);
      if (!handoff || handoff.tracking) return false;
      const prepared = readHandoff().prepared;
      handoff.visibleImmediatelyAfterCommit = sampleCanvas(handoff.kind);
      handoff.exactTicketObserved = Boolean(prepared
        && prepared.kind === handoff.kind
        && Number(prepared.sequence) > handoff.preparedSequenceBeforeCommit);
      handoff.preparedSequence = handoff.exactTicketObserved ? prepared.sequence : null;
      handoff.expectedTicket = handoff.exactTicketObserved ? prepared.stamp : null;
      handoff.tracking = handoff.exactTicketObserved;
      handoff.committedAtFrame = frameCount;
      return handoff.visibleImmediatelyAfterCommit && handoff.exactTicketObserved;
    },
    readSurface: surfaceSnapshot,
    readVisibility(kind) {
      const visible = sampleCanvas(kind);
      if (kind === "live-ink") liveInkEverVisible ||= visible;
      if (kind === "dynamic") dynamicOverlayEverVisible ||= visible;
      return visible;
    },
    stop() {
      if (active) {
        active = false;
        if (frameHandle !== null) cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      if (pointerMoveWindow) {
        const current = readCounters();
        pointerMoveWindows.push({
          label: pointerMoveWindow.label,
          observedFrameIntervals: Math.max(0, frameCount - pointerMoveWindow.startedAtFrame),
          requestUpdateDelta: counterDelta(
            current.requestUpdates,
            pointerMoveWindow.baseline.requestUpdates,
          ),
          reactRenderDelta: counterDelta(
            current.reactRenders,
            pointerMoveWindow.baseline.reactRenders,
          ),
          sceneRebuildDelta: counterDelta(
            current.sceneRebuilds,
            pointerMoveWindow.baseline.sceneRebuilds,
          ),
          incomplete: true,
        });
        pointerMoveWindow = null;
      }
      return {
        started: true,
        frameCount,
        initialSurface,
        surface: surfaceSnapshot(),
        pointerMoveWindows: clone(pointerMoveWindows),
        handoffs: clone(handoffs).map((handoff) => {
          delete handoff.tracking;
          return handoff;
        }),
        liveInkEverVisible,
        dynamicOverlayEverVisible,
        highlighterOpacityObserved,
        liveInkOpacityObserved,
        liveInkBlendModeObserved,
      };
    },
  };
  window.__CANDLESCOPE_PHASE5_PROBE__ = controller;
  return { started: true, initialSurface };
}
