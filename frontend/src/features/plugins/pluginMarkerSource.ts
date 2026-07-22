import type {
  ExternalMarkerSnapshot,
  ExternalMarkerSource,
  ExternalSeriesMarker,
} from "../../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayer, PluginMarketIdentity } from "./pluginPlatformTypes.js";

const EMPTY_MARKERS: ExternalMarkerSnapshot = Object.freeze({
  markers: Object.freeze([]),
  revision: 0,
});

function chartTime(value: number): number {
  return value > 100_000_000_000 ? Math.floor(value / 1_000) : value;
}

function markerKey(markers: readonly ExternalSeriesMarker[]): string {
  return JSON.stringify(markers);
}

export class PluginMarkerSource implements ExternalMarkerSource {
  private snapshot: ExternalMarkerSnapshot = EMPTY_MARKERS;
  private readonly listeners = new Set<() => void>();
  private key = "[]";

  getSnapshot(): ExternalMarkerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(layers: readonly PluginChartLayer[], identity: PluginMarketIdentity): void {
    const markers = layers
      .filter((layer) => (
        layer.context.mode === "live"
        && layer.context.exchange === identity.exchange
        && layer.context.marketType === identity.marketType
        && layer.series.symbol === identity.symbol
        && layer.series.interval === identity.interval
      ))
      .flatMap((layer) => layer.render.items.map((item) => ({
        id: `plugin:${layer.id}:${item.id}`,
        time: chartTime(item.time),
        position: item.position,
        shape: item.shape,
        color: item.color,
        text: item.text,
        ...(item.price === undefined ? {} : { price: item.price }),
      } satisfies ExternalSeriesMarker)));
    const nextKey = markerKey(markers);
    if (nextKey === this.key) return;
    this.key = nextKey;
    this.snapshot = Object.freeze({
      markers: Object.freeze(markers),
      revision: this.snapshot.revision + 1,
    });
    for (const listener of this.listeners) listener();
  }
}
