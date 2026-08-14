import type {
  ExternalMarkerSnapshot,
  ExternalMarkerSource,
  ExternalSeriesMarker,
} from "../../chart-adapter/externalMarkerSource.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { floorIntervalTime } from "../../utils/intervalTimeline.js";
import type { LocalAnalysisEventStore } from "./localAnalysisStore.js";
import {
  LOCAL_ANALYSIS_KIND_LABELS,
  type LocalAnalysisEvent,
} from "./localAnalysisTypes.js";

const EMPTY_MARKER_SNAPSHOT: ExternalMarkerSnapshot = Object.freeze({
  markers: Object.freeze([]),
  revision: 0,
});

function markerForEvent(event: LocalAnalysisEvent, time = event.time): ExternalSeriesMarker {
  const common = {
    id: `local-analysis:${event.id}`,
    time,
    color: event.color,
    text: event.label || LOCAL_ANALYSIS_KIND_LABELS[event.kind],
    size: 1.15,
  } as const;
  switch (event.kind) {
    case "entry":
      return { ...common, position: "belowBar", shape: "arrowUp" };
    case "exit":
      return { ...common, position: "aboveBar", shape: "arrowDown" };
    case "signal":
      return { ...common, position: "aboveBar", shape: "square" };
    case "custom":
      return { ...common, position: "inBar", shape: "circle" };
    case "note":
    default:
      return { ...common, position: "aboveBar", shape: "circle" };
  }
}

export function createLocalAnalysisMarkerSource({
  eventStore,
  seriesStore,
  interval,
}: {
  eventStore: LocalAnalysisEventStore;
  seriesStore: SeriesWindowStore;
  interval?: string;
}): ExternalMarkerSource {
  let eventRevision = -1;
  let axisRevision = -1;
  let markerRevision = 0;
  let cached = EMPTY_MARKER_SNAPSHOT;

  const getSnapshot = (): ExternalMarkerSnapshot => {
    const eventSnapshot = eventStore.getSnapshot();
    const nextAxisRevision = Number(seriesStore.axisRevision);
    if (eventSnapshot.revision === eventRevision && nextAxisRevision === axisRevision) return cached;
    eventRevision = eventSnapshot.revision;
    axisRevision = nextAxisRevision;
    const markers = eventSnapshot.events.flatMap((event) => {
      const displayTime = interval === undefined
        ? event.time
        : floorIntervalTime(interval, event.time);
      return displayTime !== null && seriesStore.hasTime(displayTime)
        ? [markerForEvent(event, displayTime)]
        : [];
    });
    markerRevision += 1;
    cached = Object.freeze({ markers: Object.freeze(markers), revision: markerRevision });
    return cached;
  };

  return {
    getSnapshot,
    subscribe(listener) {
      const unsubscribeEvents = eventStore.subscribe(listener);
      let currentAxisRevision = Number(seriesStore.axisRevision);
      const unsubscribeSeries = seriesStore.subscribe(() => {
        const next = Number(seriesStore.axisRevision);
        if (next === currentAxisRevision) return;
        currentAxisRevision = next;
        listener();
      });
      return () => {
        unsubscribeEvents();
        unsubscribeSeries();
      };
    },
  };
}
