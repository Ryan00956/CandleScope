import { createSeriesMarkers } from "lightweight-charts";
import { compareChartTimes } from "./chartTime.js";

const SHAPE_MAP = {
  triangleup: "arrowUp",
  triangle_up: "arrowUp",
  arrow_up: "arrowUp",
  triangledown: "arrowDown",
  triangle_down: "arrowDown",
  arrow_down: "arrowDown",
  circle: "circle",
  cross: "circle",
  diamond: "circle",
  xcross: "circle",
};

const POS_MAP = {
  above: "aboveBar",
  below: "belowBar",
  abovebar: "aboveBar",
  belowbar: "belowBar",
  top: "aboveBar",
  bottom: "belowBar",
};

export function flattenIndicatorMarkers(indicatorMarkers = []) {
  const allMarkers = [];
  for (const group of indicatorMarkers) {
    if (!group.data || !Array.isArray(group.data)) continue;
    for (const m of group.data) {
      if (m.time == null) continue;
      allMarkers.push({
        time: m.time,
        position: POS_MAP[m.position] || m.position || "aboveBar",
        color: m.color || "#f59e0b",
        shape: SHAPE_MAP[m.shape] || m.shape || "circle",
        text: m.text || "",
      });
    }
  }
  allMarkers.sort((a, b) => compareChartTimes(a.time, b.time));
  return allMarkers;
}

export function renderMarkers({
  targetSeries,
  indicatorMarkers,
  markerTargetRef,
  markerStateRef,
  paneId,
  recordPerfEvent,
  onError,
}) {
  if (markerTargetRef.current && markerTargetRef.current.series !== targetSeries) {
    try { markerTargetRef.current.plugin.detach(); } catch { /* */ }
    markerTargetRef.current = null;
    markerStateRef.current = { target: null, state: "empty" };
    recordPerfEvent("chart.markerSeries.clear", {
      paneId,
      reason: "target-change",
    });
  }
  if (!targetSeries) return;

  function getPlugin() {
    if (markerTargetRef.current?.series === targetSeries) {
      return markerTargetRef.current.plugin;
    }
    const plugin = createSeriesMarkers(targetSeries, []);
    markerTargetRef.current = { series: targetSeries, plugin };
    return plugin;
  }

  if (!indicatorMarkers || indicatorMarkers.length === 0) {
    const markerState = markerStateRef.current;
    if (markerState.target !== targetSeries || markerState.state !== "empty") {
      try { getPlugin().setMarkers([]); } catch { /* */ }
      markerStateRef.current = { target: targetSeries, state: "empty" };
      recordPerfEvent("chart.markerSeries.clear", {
        paneId,
        reason: "empty",
      });
    }
    return;
  }

  const allMarkers = flattenIndicatorMarkers(indicatorMarkers);

  try {
    getPlugin().setMarkers(allMarkers);
    markerStateRef.current = { target: targetSeries, state: "markers" };
    recordPerfEvent("chart.markerSeries.setMarkers", {
      paneId,
      groups: indicatorMarkers.length,
      markers: allMarkers.length,
    });
  } catch (err) {
    onError?.(err);
  }
}
