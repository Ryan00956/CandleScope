const PANE_HEIGHTS_KEY = "candlescope-pane-heights";

export function buildPaneConfigKey(subPaneIds) {
  return [...subPaneIds].sort().join(",");
}

export function loadPaneHeights() {
  try {
    return JSON.parse(localStorage.getItem(PANE_HEIGHTS_KEY)) || {};
  } catch {
    return {};
  }
}

export function savePaneHeights(heights) {
  localStorage.setItem(PANE_HEIGHTS_KEY, JSON.stringify(heights));
}