import type {
  ExternalMarkerSnapshot,
  ExternalMarkerSource,
  ExternalSeriesMarker,
} from "../../chart-adapter/externalMarkerSource.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type { TradeFlowExternalStore } from "./tradeFlowTypes.js";

const EMPTY_SNAPSHOT: ExternalMarkerSnapshot = Object.freeze({
  markers: Object.freeze([]),
  revision: 0,
});

function markerSize(notional: number, threshold: number): number {
  const ratio = threshold > 0 ? notional / threshold : 1;
  return Math.max(1, Math.min(3.2, 1 + Math.log10(Math.max(1, ratio)) * 0.9));
}

function sameMarkers(
  left: readonly ExternalSeriesMarker[],
  right: readonly ExternalSeriesMarker[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index];
    const next = right[index];
    if (
      !previous
      || !next
      || previous.id !== next.id
      || previous.time !== next.time
      || previous.price !== next.price
      || previous.color !== next.color
      || previous.size !== next.size
    ) {
      return false;
    }
  }
  return true;
}

function resolveSeriesTime(
  seriesStore: SeriesWindowStore,
  tradeTimeSeconds: number,
  intervalSeconds: number,
): number | null {
  const seconds = Math.max(1, intervalSeconds);
  const epochAligned = Math.floor(tradeTimeSeconds / seconds) * seconds;
  if (seriesStore.hasTime(epochAligned)) return epochAligned;

  // Weekly/monthly/custom bars are not necessarily aligned to Unix epoch 0.
  // Fall back to the actual ordered axis with a logarithmic lookup.
  const bars = seriesStore.snapshot();
  let left = 0;
  let right = bars.length - 1;
  let candidate = -1;
  while (left <= right) {
    const middle = (left + right) >> 1;
    const time = bars[middle]?.time;
    if (time == null) break;
    if (time <= tradeTimeSeconds) {
      candidate = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  const barTime = candidate >= 0 ? bars[candidate]?.time : null;
  if (barTime == null || tradeTimeSeconds - barTime >= seconds * 1.5) return null;
  return barTime;
}

export function createTradeFlowMarkerSource({
  store,
  seriesStore,
  intervalSeconds,
  threshold,
  buyColor,
  sellColor,
  maxMarkers = 100,
}: {
  store: TradeFlowExternalStore;
  seriesStore: SeriesWindowStore;
  intervalSeconds: number;
  threshold: number;
  buyColor: string;
  sellColor: string;
  maxMarkers?: number;
}): ExternalMarkerSource {
  let cachedTradeVersion = -1;
  let cachedAxisRevision = -1;
  let revision = 0;
  let cached = EMPTY_SNAPSHOT;

  const getSnapshot = (): ExternalMarkerSnapshot => {
    const tradeSnapshot = store.getSnapshot();
    const axisRevision = Number(seriesStore.axisRevision);
    if (cachedTradeVersion === tradeSnapshot.version && cachedAxisRevision === axisRevision) {
      return cached;
    }
    cachedTradeVersion = tradeSnapshot.version;
    cachedAxisRevision = axisRevision;
    const markers: ExternalSeriesMarker[] = [];
    for (let index = tradeSnapshot.records.length - 1; index >= 0; index -= 1) {
      const trade = tradeSnapshot.records[index];
      if (!trade || trade.quoteQuantity < threshold) continue;
      const time = resolveSeriesTime(seriesStore, trade.tradeTimeMs / 1_000, intervalSeconds);
      if (time === null) continue;
      markers.push({
        id: `trade-flow-${trade.aggTradeId}`,
        time,
        position: "atPriceMiddle",
        price: trade.price,
        color: trade.aggressorSide === "buy" ? buyColor : sellColor,
        shape: "circle",
        size: markerSize(trade.quoteQuantity, threshold),
      });
      if (markers.length >= maxMarkers) break;
    }
    markers.reverse();
    // The tape publishes at most once per frame, but most trades are below the
    // bubble threshold. Keep the marker revision stable in that common case so
    // lightweight-charts never receives a redundant setMarkers call.
    if (sameMarkers(cached.markers, markers)) return cached;
    revision += 1;
    cached = Object.freeze({ markers: Object.freeze(markers), revision });
    return cached;
  };

  return {
    getSnapshot,
    subscribe: (listener) => {
      let axisRevision = Number(seriesStore.axisRevision);
      const unsubscribeTrades = store.subscribe(listener);
      const unsubscribeSeries = seriesStore.subscribe(() => {
        const next = Number(seriesStore.axisRevision);
        if (next === axisRevision) return;
        axisRevision = next;
        listener();
      });
      return () => {
        unsubscribeTrades();
        unsubscribeSeries();
      };
    },
  };
}
