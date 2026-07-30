import type {
  AutoscaleInfo,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
} from "lightweight-charts";
import type {
  PluginChartRenderEntry,
  PluginChartLayerSource,
} from "../features/plugins/pluginChartLayerSource.js";
import type {
  PluginChartBand,
  PluginChartLabel,
  PluginChartPolyline,
  PluginChartPriceLine,
} from "../features/plugins/pluginPlatformTypes.js";
import type {
  ChartTime,
  MainSeriesHandle,
  PerfEventRecorder,
} from "./chartAdapterTypes.js";
import {
  prepareDrawingCoordinateContext,
  resolveDrawingDataPointsToCoordinates,
} from "./coordinateBridge.js";

type LayerZOrder = PluginChartRenderEntry["zOrder"];
type AttachedParameter = SeriesAttachedParameter<ChartTime, SeriesType>;
type CanvasTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

interface ProjectedPoint {
  x: number | null;
  y: number | null;
}

type ProjectedEntry =
  | {
    type: "polyline";
    item: PluginChartPolyline;
    points: ProjectedPoint[];
  }
  | {
    type: "price-line";
    item: PluginChartPriceLine;
    y: number | null;
  }
  | {
    type: "band";
    item: PluginChartBand;
    x1: number | null;
    x2: number | null;
    y1: number | null;
    y2: number | null;
  }
  | {
    type: "label";
    item: PluginChartLabel;
    x: number | null;
    y: number | null;
  };

function chartTime(value: number): ChartTime {
  return value > 100_000_000_000 ? Math.floor(value / 1_000) : value;
}

function lineDash(
  style: "solid" | "dashed" | "dotted",
  ratio: number,
): number[] {
  if (style === "dashed") return [6 * ratio, 4 * ratio];
  if (style === "dotted") return [2 * ratio, 3 * ratio];
  return [];
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const bounded = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + bounded, y);
  context.lineTo(x + width - bounded, y);
  context.quadraticCurveTo(x + width, y, x + width, y + bounded);
  context.lineTo(x + width, y + height - bounded);
  context.quadraticCurveTo(x + width, y + height, x + width - bounded, y + height);
  context.lineTo(x + bounded, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - bounded);
  context.lineTo(x, y + bounded);
  context.quadraticCurveTo(x, y, x + bounded, y);
  context.closePath();
}

class PluginChartPaneRenderer implements IPrimitivePaneRenderer {
  private entries: ProjectedEntry[] = [];

  update(entries: ProjectedEntry[]): void {
    this.entries = entries;
  }

  draw(target: CanvasTarget): void {
    if (this.entries.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const context = scope.context;
      const horizontalRatio = scope.horizontalPixelRatio;
      const verticalRatio = scope.verticalPixelRatio;
      const scale = Math.min(horizontalRatio, verticalRatio);
      const width = scope.bitmapSize.width;

      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const entry of this.entries) {
        if (entry.type === "polyline") {
          const points = entry.points.filter(
            (point): point is { x: number; y: number } => (
              point.x != null
              && point.y != null
              && Number.isFinite(point.x)
              && Number.isFinite(point.y)
            ),
          );
          if (points.length < 2) continue;
          context.beginPath();
          context.strokeStyle = entry.item.color;
          context.lineWidth = entry.item.width * scale;
          context.setLineDash(lineDash(entry.item.style, scale));
          context.moveTo(points[0]!.x * horizontalRatio, points[0]!.y * verticalRatio);
          for (const point of points.slice(1)) {
            context.lineTo(point.x * horizontalRatio, point.y * verticalRatio);
          }
          context.stroke();
          context.setLineDash([]);
          continue;
        }
        if (entry.type === "price-line") {
          if (entry.y == null || !Number.isFinite(entry.y)) continue;
          const y = entry.y * verticalRatio;
          context.beginPath();
          context.strokeStyle = entry.item.color;
          context.lineWidth = entry.item.width * scale;
          context.setLineDash(lineDash(entry.item.style, scale));
          context.moveTo(0, y);
          context.lineTo(width, y);
          context.stroke();
          context.setLineDash([]);
          if (entry.item.text) {
            const fontSize = 11 * scale;
            context.font = `600 ${fontSize}px system-ui, sans-serif`;
            context.textBaseline = "bottom";
            context.textAlign = "right";
            context.fillStyle = entry.item.color;
            context.fillText(entry.item.text, width - 6 * scale, y - 3 * scale);
          }
          continue;
        }
        if (entry.type === "band") {
          if (
            entry.x1 == null
            || entry.x2 == null
            || entry.y1 == null
            || entry.y2 == null
          ) continue;
          const left = Math.min(entry.x1, entry.x2) * horizontalRatio;
          const right = Math.max(entry.x1, entry.x2) * horizontalRatio;
          const top = Math.min(entry.y1, entry.y2) * verticalRatio;
          const bottom = Math.max(entry.y1, entry.y2) * verticalRatio;
          context.fillStyle = entry.item.fillColor;
          context.fillRect(left, top, right - left, bottom - top);
          if (entry.item.borderColor) {
            context.strokeStyle = entry.item.borderColor;
            context.lineWidth = scale;
            context.strokeRect(left, top, right - left, bottom - top);
          }
          continue;
        }
        if (entry.x == null || entry.y == null) continue;
        const x = entry.x * horizontalRatio;
        const offset = entry.item.position === "above"
          ? -10 * verticalRatio
          : entry.item.position === "below"
            ? 10 * verticalRatio
            : 0;
        const anchorY = entry.y * verticalRatio + offset;
        const fontSize = 12 * scale;
        const paddingX = 5 * scale;
        const paddingY = 3 * scale;
        context.font = `600 ${fontSize}px system-ui, sans-serif`;
        const textWidth = context.measureText(entry.item.text).width;
        const boxWidth = textWidth + paddingX * 2;
        const boxHeight = fontSize + paddingY * 2;
        const boxX = x - boxWidth / 2;
        const boxY = entry.item.position === "above"
          ? anchorY - boxHeight
          : entry.item.position === "below"
            ? anchorY
            : anchorY - boxHeight / 2;
        if (entry.item.backgroundColor) {
          context.fillStyle = entry.item.backgroundColor;
          roundedRect(context, boxX, boxY, boxWidth, boxHeight, 4 * scale);
          context.fill();
        }
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = entry.item.color;
        context.fillText(entry.item.text, x, boxY + boxHeight / 2);
      }
      context.restore();
    });
  }
}

class PluginChartPaneView implements IPrimitivePaneView {
  private readonly rendererValue = new PluginChartPaneRenderer();

  constructor(private readonly source: PluginChartLayerPrimitive) {}

  update(): void {
    const chart = this.source.chart;
    const series = this.source.series;
    if (!chart || !series) {
      this.rendererValue.update([]);
      return;
    }
    const coordinateContext = prepareDrawingCoordinateContext(series);
    const projectTimes = (times: readonly number[]) => (
      resolveDrawingDataPointsToCoordinates(
        chart,
        series,
        times.map((time) => ({ time: chartTime(time) })),
        coordinateContext,
      )
    );
    this.rendererValue.update(this.source.entries.map((entry): ProjectedEntry => {
      const item = entry.item;
      if (item.type === "polyline") {
        const xCoordinates = projectTimes(item.points.map((point) => point.time));
        return {
          type: "polyline",
          item,
          points: item.points.map((point, index) => ({
            x: xCoordinates[index] ?? null,
            y: series.priceToCoordinate(point.price),
          })),
        };
      }
      if (item.type === "price-line") {
        return {
          type: "price-line",
          item,
          y: series.priceToCoordinate(item.price),
        };
      }
      if (item.type === "band") {
        const [x1 = null, x2 = null] = projectTimes([
          item.startTime,
          item.endTime,
        ]);
        return {
          type: "band",
          item,
          x1,
          x2,
          y1: series.priceToCoordinate(item.lowerPrice),
          y2: series.priceToCoordinate(item.upperPrice),
        };
      }
      const [x = null] = projectTimes([item.time]);
      return {
        type: "label",
        item,
        x,
        y: series.priceToCoordinate(item.price),
      };
    }));
  }

  renderer(): IPrimitivePaneRenderer {
    return this.rendererValue;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this.source.zOrder === "above-series" ? "top" : "bottom";
  }
}

export class PluginChartLayerPrimitive {
  entries: PluginChartRenderEntry[] = [];
  chart: AttachedParameter["chart"] | null = null;
  series: AttachedParameter["series"] | null = null;
  readonly zOrder: LayerZOrder;
  private requestUpdate: (() => void) | null = null;
  private readonly paneView: PluginChartPaneView;

  constructor(zOrder: LayerZOrder) {
    this.zOrder = zOrder;
    this.paneView = new PluginChartPaneView(this);
  }

  attached({ chart, series, requestUpdate }: AttachedParameter): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setEntries(entries: readonly PluginChartRenderEntry[]): void {
    this.entries = entries.filter((entry) => entry.zOrder === this.zOrder);
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    this.paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;
    const include = (price: number) => {
      minValue = Math.min(minValue, price);
      maxValue = Math.max(maxValue, price);
    };
    for (const entry of this.entries) {
      const item = entry.item;
      if (item.type === "polyline") {
        for (const point of item.points) include(point.price);
      } else if (item.type === "price-line" || item.type === "label") {
        include(item.price);
      } else {
        include(item.lowerPrice);
        include(item.upperPrice);
      }
    }
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return null;
    return {
      priceRange: {
        minValue,
        maxValue,
      },
    };
  }
}

export function attachPluginChartLayerSource({
  source,
  targetSeries,
  recordPerfEvent,
}: {
  source: PluginChartLayerSource;
  targetSeries: MainSeriesHandle;
  recordPerfEvent: PerfEventRecorder;
}): () => void {
  const above = new PluginChartLayerPrimitive("above-series");
  const below = new PluginChartLayerPrimitive("below-series");
  targetSeries.attachPrimitive(below);
  targetSeries.attachPrimitive(above);
  let lastRevision = -1;

  const render = () => {
    const snapshot = source.getSnapshot();
    if (snapshot.revision === lastRevision) return;
    lastRevision = snapshot.revision;
    below.setEntries(snapshot.entries);
    above.setEntries(snapshot.entries);
    recordPerfEvent("chart.pluginChartLayer.update", {
      entries: snapshot.entries.length,
      revision: snapshot.revision,
    });
  };

  render();
  const unsubscribe = source.subscribe(render);
  return () => {
    unsubscribe();
    try { targetSeries.detachPrimitive(above); } catch { /* disposed */ }
    try { targetSeries.detachPrimitive(below); } catch { /* disposed */ }
  };
}
