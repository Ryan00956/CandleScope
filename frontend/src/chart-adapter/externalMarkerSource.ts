import { createSeriesMarkers } from "lightweight-charts";
import type { ISeriesMarkersPluginApi, SeriesMarker } from "lightweight-charts";
import { compareChartTimes } from "./chartTime.js";
import type {
  ChartTime,
  MainSeriesHandle,
  PerfEventRecorder,
} from "./chartAdapterTypes.js";

export interface ExternalSeriesMarker {
  id: string;
  time: ChartTime;
  position: "aboveBar" | "belowBar" | "inBar" | "atPriceTop" | "atPriceBottom" | "atPriceMiddle";
  color: string;
  shape: "circle" | "square" | "arrowUp" | "arrowDown";
  text?: string;
  size?: number;
  price?: number;
}

export interface ExternalMarkerSnapshot {
  markers: readonly ExternalSeriesMarker[];
  revision: number;
}

export interface ExternalMarkerSource {
  getSnapshot(): ExternalMarkerSnapshot;
  subscribe(listener: () => void): () => void;
}

export function combineExternalMarkerSources(
  values: readonly (ExternalMarkerSource | null | undefined)[],
): ExternalMarkerSource | null {
  const sources = values.filter((value): value is ExternalMarkerSource => value != null);
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0] ?? null;
  let revision = 0;
  let sourceRevisions = "";
  let cached: ExternalMarkerSnapshot = { markers: [], revision };
  return {
    getSnapshot(): ExternalMarkerSnapshot {
      const snapshots = sources.map((source) => source.getSnapshot());
      const nextRevisions = snapshots.map((snapshot) => snapshot.revision).join(":");
      if (nextRevisions === sourceRevisions) return cached;
      sourceRevisions = nextRevisions;
      revision += 1;
      cached = {
        markers: snapshots.flatMap((snapshot) => [...snapshot.markers]),
        revision,
      };
      return cached;
    },
    subscribe(listener: () => void): () => void {
      const unsubscribers = sources.map((source) => source.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
  };
}

export function attachExternalMarkerSource({
  source,
  targetSeries,
  recordPerfEvent,
}: {
  source: ExternalMarkerSource;
  targetSeries: MainSeriesHandle;
  recordPerfEvent: PerfEventRecorder;
}): () => void {
  const plugin: ISeriesMarkersPluginApi<ChartTime> = createSeriesMarkers(targetSeries, []);
  let lastRevision = -1;

  const render = () => {
    const snapshot = source.getSnapshot();
    if (snapshot.revision === lastRevision) return;
    lastRevision = snapshot.revision;
    const markers = [...snapshot.markers]
      .sort((left, right) => compareChartTimes(left.time, right.time))
      .map((marker) => ({ ...marker })) as SeriesMarker<ChartTime>[];
    plugin.setMarkers(markers);
    recordPerfEvent("chart.externalMarkerSeries.setMarkers", {
      markers: markers.length,
      revision: snapshot.revision,
    });
  };

  render();
  const unsubscribe = source.subscribe(render);
  return () => {
    unsubscribe();
    try { plugin.detach(); } catch { /* chart or series may already be disposed */ }
  };
}
