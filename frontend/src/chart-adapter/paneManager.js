export function ensurePane(chart, paneIndex, { preserveEmptyPane = true } = {}) {
  if (!chart || !Number.isInteger(paneIndex) || paneIndex < 0) return null;

  let panes = chart.panes?.() || [];
  while (panes.length <= paneIndex) {
    if (typeof chart.addPane !== "function") return null;
    chart.addPane(preserveEmptyPane);
    panes = chart.panes?.() || [];
  }

  const pane = panes[paneIndex] || null;
  if (pane && typeof pane.setPreserveEmptyPane === "function") {
    pane.setPreserveEmptyPane(preserveEmptyPane);
  }
  return pane;
}

export function setPaneHeights(chart, heightsPx = []) {
  if (!chart || !Array.isArray(heightsPx)) return;
  const panes = chart.panes?.() || [];

  // Lightweight Charts redistributes all other panes after every setHeight()
  // call. Replaying several saved pixel heights sequentially therefore drifts
  // (and can push later indicator panes down to the 30px minimum). Stretch
  // factors are applied independently, so the final ratios are deterministic
  // and also adapt when the container height changes.
  const stretchValues = panes.map((pane, index) => {
    const requested = heightsPx[index];
    if (Number.isFinite(requested) && requested > 0) return requested;
    const currentHeight = pane?.getHeight?.();
    return Number.isFinite(currentHeight) && currentHeight > 0
      ? currentHeight
      : null;
  });
  const canRestoreRatios = panes.length > 0
    && stretchValues.every((height) => Number.isFinite(height) && height > 0)
    && panes.every((pane) => typeof pane?.setStretchFactor === "function");
  if (canRestoreRatios) {
    for (let index = 0; index < panes.length; index += 1) {
      panes[index].setStretchFactor(stretchValues[index]);
    }
    return;
  }

  for (let index = 0; index < heightsPx.length; index += 1) {
    const height = heightsPx[index];
    if (!Number.isFinite(height) || height <= 0) continue;
    panes[index]?.setHeight?.(height);
  }
}

export function readPaneHeights(chart) {
  if (!chart) return [];
  const heights = (chart.panes?.() || []).map((pane) => pane.getHeight?.());
  return heights.every((height) => Number.isFinite(height) && height > 0)
    ? heights
    : [];
}

/**
 * Force Lightweight Charts to synchronously materialize pane widgets created
 * while autoSize is active. A normal resize() is ignored in autoSize mode, so
 * temporarily opt out, perform one forced public-API resize, then restore it.
 */
export function materializePaneLayout(chart, container, { nudgeAxis = "width" } = {}) {
  if (!chart
    || typeof chart.applyOptions !== "function"
    || typeof chart.resize !== "function"
    || !container) {
    return false;
  }

  const bounds = container.getBoundingClientRect?.();
  const width = Math.floor(Number(container.clientWidth) || Number(bounds?.width) || 0);
  const height = Math.floor(Number(container.clientHeight) || Number(bounds?.height) || 0);
  if (width <= 0 || height <= 0) return false;

  let restoreAutoSize = true;
  try {
    restoreAutoSize = chart.options?.()?.autoSize !== false;
  } catch {
    // Default to restoring the observer when options are unavailable.
  }
  let autoSizeDisabled = false;
  try {
    chart.applyOptions({ autoSize: false, height, width });
    autoSizeDisabled = true;
    // LWC returns before forceRepaint when the requested size is unchanged.
    // A two-pixel nudge survives its even-pixel size normalization; restoring
    // the target size in the same task materializes widgets without a painted
    // intermediate frame.
    const nudgeWidth = width > 2 ? width - 2 : width + 2;
    const nudgeHeight = height > 2 ? height - 2 : height + 2;
    if (nudgeAxis === "height") chart.resize(width, nudgeHeight, true);
    else chart.resize(nudgeWidth, height, true);
    chart.resize(width, height, true);
    if (restoreAutoSize) chart.applyOptions({ autoSize: true });
    return true;
  } catch {
    if (autoSizeDisabled && restoreAutoSize) {
      try { chart.applyOptions({ autoSize: true }); } catch { /* best-effort observer restore */ }
    }
    return false;
  }
}

export function trimPanes(chart, retainCount = 1) {
  if (!chart || typeof chart.removePane !== "function") return 0;
  const panes = chart.panes?.() || [];
  const safeRetainCount = Math.max(1, Math.floor(Number(retainCount) || 1));
  let removed = 0;
  for (let paneIndex = panes.length - 1; paneIndex >= safeRetainCount; paneIndex -= 1) {
    try {
      chart.removePane(paneIndex);
      removed += 1;
    } catch {
      // Pane cleanup is best-effort because series removal can collapse panes.
    }
  }
  return removed;
}

export function removePaneSeries(chart, entries = []) {
  if (!chart) return 0;
  let removed = 0;
  for (const entry of entries) {
    const series = entry?.series || entry;
    if (!series) continue;
    try {
      chart.removeSeries(series);
      removed += 1;
    } catch {
      // Series cleanup is best-effort because pane removal can detach entries.
    }
  }
  return removed;
}
