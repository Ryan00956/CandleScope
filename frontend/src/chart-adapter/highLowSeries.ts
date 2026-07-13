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
  HighLowSeriesOptions,
  OhlcCustomData,
} from "./chartAdapterTypes.js";

const DEFAULT_HIGH_LOW_COLOR = "#2962ff";
const BAR_WIDTH_RATIO = 0.72;

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class HighLowSeriesRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<ChartTime, OhlcCustomData> | null;
  private options: HighLowSeriesOptions | null;

  constructor() {
    this.data = null;
    this.options = null;
  }

  update(
    data: PaneRendererCustomData<ChartTime, OhlcCustomData> | null,
    options: HighLowSeriesOptions | null,
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
      const width = Math.max(1, Math.round(effectiveSpacing * BAR_WIDTH_RATIO * horizontalPixelRatio));
      const from = Math.max(0, Math.floor(visibleRange.from));
      const to = Math.min(data.bars.length, Math.ceil(visibleRange.to));

      for (let index = from; index < to; index += 1) {
        const bar = data.bars[index];
        const high = finiteNumber(bar?.originalData?.high);
        const low = finiteNumber(bar?.originalData?.low);
        if (high == null || low == null) continue;

        const highCoordinate = priceConverter(high);
        const lowCoordinate = priceConverter(low);
        if (highCoordinate == null || lowCoordinate == null) continue;

        const center = Math.round(bar.x * horizontalPixelRatio);
        const left = Math.round(center - width / 2);
        const top = Math.round(Math.min(highCoordinate, lowCoordinate) * verticalPixelRatio);
        const bottom = Math.round(Math.max(highCoordinate, lowCoordinate) * verticalPixelRatio);

        context.fillStyle = bar?.originalData?.color
          || bar.barColor
          || this.options?.color
          || DEFAULT_HIGH_LOW_COLOR;
        context.fillRect(left, top, width, Math.max(1, bottom - top));
      }
    });
  }
}

class HighLowSeriesPaneView implements ICustomSeriesPaneView<
  ChartTime,
  OhlcCustomData,
  HighLowSeriesOptions
> {
  private readonly seriesRenderer: HighLowSeriesRenderer;

  constructor() {
    this.seriesRenderer = new HighLowSeriesRenderer();
  }

  renderer(): ICustomSeriesPaneRenderer {
    return this.seriesRenderer;
  }

  update(
    data: PaneRendererCustomData<ChartTime, OhlcCustomData>,
    options: HighLowSeriesOptions,
  ): void {
    this.seriesRenderer.update(data, options);
  }

  priceValueBuilder(data: OhlcCustomData): [number, number, number] {
    return [data.high, data.low, data.close];
  }

  isWhitespace(
    data: OhlcCustomData | CustomSeriesWhitespaceData<ChartTime>,
  ): data is CustomSeriesWhitespaceData<ChartTime> {
    if (!("high" in data) || !("low" in data)) return true;
    return finiteNumber(data?.high) == null || finiteNumber(data?.low) == null;
  }

  defaultOptions(): HighLowSeriesOptions {
    return {
      ...customSeriesDefaultOptions,
      color: DEFAULT_HIGH_LOW_COLOR,
    };
  }

  destroy(): void {
    this.seriesRenderer.update(null, null);
  }
}

export function createHighLowSeriesPaneView(): ICustomSeriesPaneView<
  ChartTime,
  OhlcCustomData,
  HighLowSeriesOptions
> {
  return new HighLowSeriesPaneView();
}
