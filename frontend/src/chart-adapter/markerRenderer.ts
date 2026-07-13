import { createSeriesMarkers } from "lightweight-charts";
import type {
  ISeriesMarkersPluginApi,
  SeriesMarker,
  SeriesMarkerBarPosition,
  SeriesMarkerShape,
} from "lightweight-charts";
import { compareChartTimes } from "./chartTime.js";
import type {
  ChartTime,
  IndicatorMarkerGroup,
  MainSeriesHandle,
  MutableRef,
  PerfEventRecorder,
} from "./chartAdapterTypes.js";

const SHAPE_MAP: Readonly<Record<string, SeriesMarkerShape>> = {
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

const POS_MAP: Readonly<Record<string, SeriesMarkerBarPosition>> = {
  above: "aboveBar",
  below: "belowBar",
  abovebar: "aboveBar",
  belowbar: "belowBar",
  top: "aboveBar",
  bottom: "belowBar",
};

function markerPosition(value: string | undefined): SeriesMarkerBarPosition {
  const normalized = value ? POS_MAP[value] || value : "aboveBar";
  return normalized === "aboveBar" || normalized === "belowBar" || normalized === "inBar"
    ? normalized
    : "aboveBar";
}

function markerShape(value: string | undefined): SeriesMarkerShape {
  const normalized = value ? SHAPE_MAP[value] || value : "circle";
  return normalized === "circle"
    || normalized === "square"
    || normalized === "arrowUp"
    || normalized === "arrowDown"
    ? normalized
    : "circle";
}

export function flattenIndicatorMarkers(
  indicatorMarkers: IndicatorMarkerGroup[] = [],
): SeriesMarker<ChartTime>[] {
  const allMarkers: SeriesMarker<ChartTime>[] = [];
  for (const group of indicatorMarkers) {
    if (!group.data || !Array.isArray(group.data)) continue;
    for (const m of group.data) {
      if (m.time == null) continue;
      allMarkers.push({
        time: m.time,
        position: markerPosition(m.position),
        color: m.color || "#f59e0b",
        shape: markerShape(m.shape),
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
}: {
  targetSeries: MainSeriesHandle | null | undefined;
  indicatorMarkers: IndicatorMarkerGroup[] | null | undefined;
  markerTargetRef: MutableRef<{
    series: MainSeriesHandle;
    plugin: ISeriesMarkersPluginApi<ChartTime>;
  } | null>;
  markerStateRef: MutableRef<{
    target: MainSeriesHandle | null;
    state: "empty" | "markers";
  }>;
  paneId: string;
  recordPerfEvent: PerfEventRecorder;
  onError?: (error: unknown) => void;
}): void {
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
  const series = targetSeries;

  function getPlugin(): ISeriesMarkersPluginApi<ChartTime> {
    const currentTarget = markerTargetRef.current;
    if (currentTarget?.series === series) {
      return currentTarget.plugin;
    }
    const plugin = createSeriesMarkers(series, []);
    markerTargetRef.current = { series, plugin };
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
