import type {
  PluginChartLayer,
  PluginChartLayerV2,
  PluginChartRenderItem,
  PluginMarketIdentity,
} from "./pluginPlatformTypes.js";

export interface PluginChartRenderEntry {
  id: string;
  item: Exclude<PluginChartRenderItem, { type: "marker" }>;
  zOrder: "above-series" | "below-series";
}

export interface PluginChartLayerSnapshot {
  entries: readonly PluginChartRenderEntry[];
  revision: number;
}

const EMPTY_SNAPSHOT: PluginChartLayerSnapshot = Object.freeze({
  entries: Object.freeze([]),
  revision: 0,
});

function isV2Layer(layer: PluginChartLayer): layer is PluginChartLayerV2 {
  return layer.render.schemaVersion === "candlescope.render/2";
}

function isAnalysisItem(
  item: PluginChartRenderItem,
): item is Exclude<PluginChartRenderItem, { type: "marker" }> {
  return item.type !== "marker";
}

export class PluginChartLayerSource {
  private snapshot: PluginChartLayerSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private key = "[]";

  getSnapshot(): PluginChartLayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(layers: readonly PluginChartLayer[], identity: PluginMarketIdentity): void {
    const selectedLayers = layers.filter((layer): layer is PluginChartLayerV2 => (
      isV2Layer(layer)
      && layer.chartId === "main-chart"
      && layer.context.mode === "live"
      && layer.context.exchange === identity.exchange
      && layer.context.marketType === identity.marketType
      && layer.series.symbol === identity.symbol
      && layer.series.interval === identity.interval
    ));
    const nextKey = JSON.stringify(selectedLayers.map((layer) => [
      layer.id,
      layer.generation,
      layer.revision,
      layer.chartRevision,
      layer.zOrder,
    ]));
    if (nextKey === this.key) return;
    const entries = selectedLayers
      .flatMap((layer) => layer.render.items
        .filter(isAnalysisItem)
        .map((item) => ({
          id: `plugin:${layer.id}:${item.id}`,
          item,
          zOrder: layer.zOrder,
        } satisfies PluginChartRenderEntry)));
    this.key = nextKey;
    this.snapshot = Object.freeze({
      entries: Object.freeze(entries),
      revision: this.snapshot.revision + 1,
    });
    for (const listener of this.listeners) listener();
  }
}
