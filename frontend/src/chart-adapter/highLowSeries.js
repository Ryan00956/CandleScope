import { customSeriesDefaultOptions } from "lightweight-charts";

const DEFAULT_HIGH_LOW_COLOR = "#2962ff";
const BAR_WIDTH_RATIO = 0.72;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class HighLowSeriesRenderer {
  constructor() {
    this.data = null;
    this.options = null;
  }

  update(data, options) {
    this.data = data;
    this.options = options;
  }

  draw(target, priceConverter) {
    const data = this.data;
    if (!data?.visibleRange) return;

    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio, verticalPixelRatio } = scope;
      const effectiveSpacing = data.barSpacing * (data.conflationFactor || 1);
      const width = Math.max(1, Math.round(effectiveSpacing * BAR_WIDTH_RATIO * horizontalPixelRatio));
      const from = Math.max(0, Math.floor(data.visibleRange.from));
      const to = Math.min(data.bars.length, Math.ceil(data.visibleRange.to));

      for (let index = from; index < to; index += 1) {
        const bar = data.bars[index];
        const high = finiteNumber(bar?.originalData?.high);
        const low = finiteNumber(bar?.originalData?.low);
        if (high == null || low == null) continue;

        const highCoordinate = priceConverter(high);
        const lowCoordinate = priceConverter(low);
        if (!Number.isFinite(highCoordinate) || !Number.isFinite(lowCoordinate)) continue;

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

class HighLowSeriesPaneView {
  constructor() {
    this.seriesRenderer = new HighLowSeriesRenderer();
  }

  renderer() {
    return this.seriesRenderer;
  }

  update(data, options) {
    this.seriesRenderer.update(data, options);
  }

  priceValueBuilder(data) {
    return [data.high, data.low, data.close];
  }

  isWhitespace(data) {
    return finiteNumber(data?.high) == null || finiteNumber(data?.low) == null;
  }

  defaultOptions() {
    return {
      ...customSeriesDefaultOptions,
      color: DEFAULT_HIGH_LOW_COLOR,
    };
  }

  destroy() {
    this.seriesRenderer.update(null, null);
  }
}

export function createHighLowSeriesPaneView() {
  return new HighLowSeriesPaneView();
}
