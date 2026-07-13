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
  for (let index = 0; index < heightsPx.length; index += 1) {
    const height = heightsPx[index];
    if (!Number.isFinite(height) || height <= 0) continue;
    panes[index]?.setHeight?.(height);
  }
}

export function readPaneHeights(chart) {
  if (!chart) return [];
  return (chart.panes?.() || []).map((pane) => pane.getHeight?.()).filter(Number.isFinite);
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
