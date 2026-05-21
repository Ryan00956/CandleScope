export function buildIndicatorPaneData(indicators = []) {
  const overlayLines = [];
  const paneMap = new Map();

  for (const indicator of indicators) {
    if (!indicator.visible || !indicator.lines || indicator.lines.length === 0) continue;

    for (const line of indicator.lines) {
      const pane = line.pane || "main";
      const lineWithId = { ...line, indicatorId: indicator.id };

      if (pane === "main") {
        overlayLines.push(lineWithId);
        continue;
      }

      const paneId = `${pane}-${indicator.id}`;
      if (!paneMap.has(paneId)) {
        paneMap.set(paneId, {
          id: paneId,
          label: indicator.name || indicator.id,
          lines: [],
        });
      }
      paneMap.get(paneId).lines.push(lineWithId);
    }
  }

  return {
    mainOverlayLines: overlayLines,
    subPanes: Array.from(paneMap.values()),
  };
}
