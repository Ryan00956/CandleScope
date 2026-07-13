import { customSeriesDefaultOptions } from "lightweight-charts";
import type {
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
} from "lightweight-charts";
import type {
  ChartTime,
  PointFigureCustomData,
  PointFigureMetadata,
  PointFigureSeriesOptions,
} from "./chartAdapterTypes.js";

const DEFAULT_UP_COLOR = "#22c55e";
const DEFAULT_DOWN_COLOR = "#ef4444";
const COLUMN_WIDTH_RATIO = 0.68;
const MAX_RENDERED_BOXES_PER_COLUMN = 10_000;

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function isPointFigureMetadata(value: unknown): value is PointFigureMetadata {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function columnMetadata(
  data: PointFigureCustomData | CustomSeriesWhitespaceData<ChartTime> | null | undefined,
): PointFigureMetadata | null {
  const metadata = data?.customValues?.pointAndFigure;
  return isPointFigureMetadata(metadata) ? metadata : null;
}

function columnDirection(
  data: PointFigureCustomData | CustomSeriesWhitespaceData<ChartTime> | null | undefined,
): "x" | "o" | null {
  const direction = columnMetadata(data)?.direction;
  if (direction === "x" || direction === "o") return direction;
  const open = finiteNumber(data && "open" in data ? data.open : null);
  const close = finiteNumber(data && "close" in data ? data.close : null);
  if (open == null || close == null) return null;
  return close >= open ? "x" : "o";
}

function columnBoxSpec(
  data: PointFigureCustomData | CustomSeriesWhitespaceData<ChartTime> | null | undefined,
): { boxSize: number; count: number; high: number; low: number } | null {
  const low = finiteNumber(data && "low" in data ? data.low : null);
  const high = finiteNumber(data && "high" in data ? data.high : null);
  const boxSize = positiveNumber(columnMetadata(data)?.boxSize);
  if (low == null || high == null || boxSize == null || high < low) return null;
  const count = Math.floor(((high - low) / boxSize) + 1e-9) + 1;
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return { boxSize, count, high, low };
}

class PointFigureSeriesRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<ChartTime, PointFigureCustomData> | null;
  private options: PointFigureSeriesOptions | null;

  constructor() {
    this.data = null;
    this.options = null;
  }

  update(
    data: PaneRendererCustomData<ChartTime, PointFigureCustomData> | null,
    options: PointFigureSeriesOptions | null,
  ): void {
    this.data = data;
    this.options = options;
  }

  draw(
    target: Parameters<ICustomSeriesPaneRenderer["draw"]>[0],
    priceConverter: PriceToCoordinateConverter,
  ): void {
    const data = this.data;
    if (!data?.visibleRange) return;
    const visibleRange = data.visibleRange;

    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio, verticalPixelRatio } = scope;
      const effectiveSpacing = data.barSpacing * (data.conflationFactor || 1);
      const symbolWidth = Math.max(
        2,
        effectiveSpacing * COLUMN_WIDTH_RATIO * horizontalPixelRatio,
      );
      const from = Math.max(0, Math.floor(visibleRange.from));
      const to = Math.min(data.bars.length, Math.ceil(visibleRange.to));
      const configuredLineWidth = positiveNumber(this.options?.lineWidth) || 2;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = Math.max(1, configuredLineWidth * Math.min(
        horizontalPixelRatio,
        verticalPixelRatio,
      ));

      for (let index = from; index < to; index += 1) {
        const bar = data.bars[index];
        const originalData = bar?.originalData;
        const direction = columnDirection(originalData);
        const boxSpec = columnBoxSpec(originalData);
        if (!direction || !boxSpec) continue;

        const nextBoxCoordinate = priceConverter(boxSpec.low + boxSpec.boxSize);
        const firstCoordinate = priceConverter(boxSpec.low);
        if (nextBoxCoordinate == null || firstCoordinate == null) continue;
        const symbolHeight = Math.max(
          2,
          Math.abs(nextBoxCoordinate - firstCoordinate) * verticalPixelRatio * 0.72,
        );
        const halfSize = Math.max(1, Math.min(symbolWidth, symbolHeight) / 2);
        const centerX = bar.x * horizontalPixelRatio;
        context.strokeStyle = originalData?.color
          || bar?.barColor
          || (direction === "x"
            ? (this.options?.upColor || DEFAULT_UP_COLOR)
            : (this.options?.downColor || DEFAULT_DOWN_COLOR));

        // At this density individual glyphs cannot be distinguished anyway.
        // Draw a bounded column spine instead of allocating or painting tens
        // of thousands of X/O paths on every animation frame.
        if (boxSpec.count > MAX_RENDERED_BOXES_PER_COLUMN) {
          const highCoordinate = priceConverter(boxSpec.high);
          const lowCoordinate = priceConverter(boxSpec.low);
          if (highCoordinate == null || lowCoordinate == null) continue;
          context.beginPath();
          context.moveTo(centerX, highCoordinate * verticalPixelRatio);
          context.lineTo(centerX, lowCoordinate * verticalPixelRatio);
          context.stroke();
          continue;
        }

        for (let boxIndex = 0; boxIndex < boxSpec.count; boxIndex += 1) {
          const level = boxSpec.low + boxIndex * boxSpec.boxSize;
          const priceCoordinate = priceConverter(level);
          if (priceCoordinate == null) continue;
          const centerY = priceCoordinate * verticalPixelRatio;
          context.beginPath();
          if (direction === "x") {
            context.moveTo(centerX - halfSize, centerY - halfSize);
            context.lineTo(centerX + halfSize, centerY + halfSize);
            context.moveTo(centerX + halfSize, centerY - halfSize);
            context.lineTo(centerX - halfSize, centerY + halfSize);
          } else {
            context.ellipse(centerX, centerY, halfSize, halfSize, 0, 0, Math.PI * 2);
          }
          context.stroke();
        }
      }
    });
  }
}

class PointFigureSeriesPaneView implements ICustomSeriesPaneView<
  ChartTime,
  PointFigureCustomData,
  PointFigureSeriesOptions
> {
  private readonly seriesRenderer: PointFigureSeriesRenderer;

  constructor() {
    this.seriesRenderer = new PointFigureSeriesRenderer();
  }

  renderer(): ICustomSeriesPaneRenderer {
    return this.seriesRenderer;
  }

  update(
    data: PaneRendererCustomData<ChartTime, PointFigureCustomData>,
    options: PointFigureSeriesOptions,
  ): void {
    this.seriesRenderer.update(data, options);
  }

  priceValueBuilder(data: PointFigureCustomData): [number, number, number] {
    return [data.high, data.low, data.close];
  }

  isWhitespace(
    data: PointFigureCustomData | CustomSeriesWhitespaceData<ChartTime>,
  ): data is CustomSeriesWhitespaceData<ChartTime> {
    return !("high" in data)
      || !("low" in data)
      || finiteNumber(data.high) == null
      || finiteNumber(data.low) == null
      || columnBoxSpec(data) == null;
  }

  defaultOptions(): PointFigureSeriesOptions {
    return {
      ...customSeriesDefaultOptions,
      upColor: DEFAULT_UP_COLOR,
      downColor: DEFAULT_DOWN_COLOR,
      lineWidth: 2,
    };
  }

  destroy(): void {
    this.seriesRenderer.update(null, null);
  }
}

export function createPointFigureSeriesPaneView(): ICustomSeriesPaneView<
  ChartTime,
  PointFigureCustomData,
  PointFigureSeriesOptions
> {
  return new PointFigureSeriesPaneView();
}
