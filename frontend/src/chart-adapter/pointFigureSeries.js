import { customSeriesDefaultOptions } from "lightweight-charts";

const DEFAULT_UP_COLOR = "#22c55e";
const DEFAULT_DOWN_COLOR = "#ef4444";
const COLUMN_WIDTH_RATIO = 0.68;
const MAX_RENDERED_BOXES_PER_COLUMN = 10_000;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function columnMetadata(data) {
  return data?.customValues?.pointAndFigure || null;
}

function columnDirection(data) {
  const direction = columnMetadata(data)?.direction;
  if (direction === "x" || direction === "o") return direction;
  const open = finiteNumber(data?.open);
  const close = finiteNumber(data?.close);
  if (open == null || close == null) return null;
  return close >= open ? "x" : "o";
}

function columnBoxSpec(data) {
  const low = finiteNumber(data?.low);
  const high = finiteNumber(data?.high);
  const boxSize = positiveNumber(columnMetadata(data)?.boxSize);
  if (low == null || high == null || boxSize == null || high < low) return null;
  const count = Math.floor(((high - low) / boxSize) + 1e-9) + 1;
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return { boxSize, count, high, low };
}

class PointFigureSeriesRenderer {
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
      const symbolWidth = Math.max(
        2,
        effectiveSpacing * COLUMN_WIDTH_RATIO * horizontalPixelRatio,
      );
      const from = Math.max(0, Math.floor(data.visibleRange.from));
      const to = Math.min(data.bars.length, Math.ceil(data.visibleRange.to));
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
        if (!Number.isFinite(nextBoxCoordinate) || !Number.isFinite(firstCoordinate)) continue;
        const symbolHeight = Math.max(
          2,
          Math.abs(nextBoxCoordinate - firstCoordinate) * verticalPixelRatio * 0.72,
        );
        const halfSize = Math.max(1, Math.min(symbolWidth, symbolHeight) / 2);
        const centerX = bar.x * horizontalPixelRatio;
        context.strokeStyle = direction === "x"
          ? (this.options?.upColor || DEFAULT_UP_COLOR)
          : (this.options?.downColor || DEFAULT_DOWN_COLOR);

        // At this density individual glyphs cannot be distinguished anyway.
        // Draw a bounded column spine instead of allocating or painting tens
        // of thousands of X/O paths on every animation frame.
        if (boxSpec.count > MAX_RENDERED_BOXES_PER_COLUMN) {
          const highCoordinate = priceConverter(boxSpec.high);
          const lowCoordinate = priceConverter(boxSpec.low);
          if (!Number.isFinite(highCoordinate) || !Number.isFinite(lowCoordinate)) continue;
          context.beginPath();
          context.moveTo(centerX, highCoordinate * verticalPixelRatio);
          context.lineTo(centerX, lowCoordinate * verticalPixelRatio);
          context.stroke();
          continue;
        }

        for (let boxIndex = 0; boxIndex < boxSpec.count; boxIndex += 1) {
          const level = boxSpec.low + boxIndex * boxSpec.boxSize;
          const priceCoordinate = priceConverter(level);
          if (!Number.isFinite(priceCoordinate)) continue;
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

class PointFigureSeriesPaneView {
  constructor() {
    this.seriesRenderer = new PointFigureSeriesRenderer();
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
    return finiteNumber(data?.high) == null
      || finiteNumber(data?.low) == null
      || columnBoxSpec(data) == null;
  }

  defaultOptions() {
    return {
      ...customSeriesDefaultOptions,
      upColor: DEFAULT_UP_COLOR,
      downColor: DEFAULT_DOWN_COLOR,
      lineWidth: 2,
    };
  }

  destroy() {
    this.seriesRenderer.update(null, null);
  }
}

export function createPointFigureSeriesPaneView() {
  return new PointFigureSeriesPaneView();
}
