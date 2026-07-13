import { customSeriesDefaultOptions } from "lightweight-charts";

const DEFAULT_UP_COLOR = "#22c55e";
const DEFAULT_DOWN_COLOR = "#ef4444";
const DEFAULT_LINE_WIDTH = 2;
const DEFAULT_THICK_LINE_WIDTH = 4;
const MAX_STROKE_WIDTH_RATIO = 0.72;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function kagiMetadata(data) {
  return data?.customValues?.kagi || null;
}

function kagiStyle(value, fallback = "yin") {
  return value === "yang" || value === "yin" ? value : fallback;
}

function kagiDirection(data) {
  const direction = kagiMetadata(data)?.direction;
  if (direction === "up" || direction === "down") return direction;
  const open = finiteNumber(data?.open);
  const close = finiteNumber(data?.close);
  if (open == null || close == null || open === close) return null;
  return close > open ? "up" : "down";
}

function kagiSections(data) {
  const metadata = kagiMetadata(data);
  const fallbackStyle = kagiStyle(metadata?.state);
  const sections = [];

  if (Array.isArray(metadata?.sections)) {
    for (const section of metadata.sections) {
      const from = finiteNumber(section?.from);
      const to = finiteNumber(section?.to);
      if (from == null || to == null || from === to) continue;
      sections.push({
        from,
        to,
        style: kagiStyle(section?.style, fallbackStyle),
      });
    }
  }

  if (sections.length > 0) return sections;
  const from = finiteNumber(data?.open) ?? finiteNumber(metadata?.turnPrice);
  const to = finiteNumber(data?.close);
  return from == null || to == null || from === to
    ? []
    : [{ from, to, style: fallbackStyle }];
}

function tailStyle(data) {
  const metadata = kagiMetadata(data);
  if (metadata?.state === "yang" || metadata?.state === "yin") {
    return metadata.state;
  }
  const sections = kagiSections(data);
  return sections.length > 0 ? sections[sections.length - 1].style : "yin";
}

function connectorPrice(currentData, previousData) {
  return finiteNumber(kagiMetadata(currentData)?.turnPrice)
    ?? finiteNumber(currentData?.open)
    ?? finiteNumber(previousData?.close);
}

function strokeWidths(options, data, horizontalPixelRatio, verticalPixelRatio) {
  const pixelRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  const thinCss = positiveNumber(options?.lineWidth) || DEFAULT_LINE_WIDTH;
  const thickCss = Math.max(
    thinCss,
    positiveNumber(options?.thickLineWidth) || DEFAULT_THICK_LINE_WIDTH,
  );
  const desiredThin = thinCss * pixelRatio;
  const desiredThick = thickCss * pixelRatio;
  const spacing = (positiveNumber(data?.barSpacing) || 1)
    * (positiveNumber(data?.conflationFactor) || 1)
    * horizontalPixelRatio;
  const maxWidth = Math.max(1, spacing * MAX_STROKE_WIDTH_RATIO);
  const compression = Math.min(1, maxWidth / desiredThick);
  const yin = Math.max(1, desiredThin * compression);
  return {
    yin,
    yang: Math.max(yin, desiredThick * compression),
  };
}

function strokeColor(direction, options, data, bar) {
  return data?.color
    || bar?.barColor
    || (direction === "down"
    ? (options?.downColor || DEFAULT_DOWN_COLOR)
    : (options?.upColor || DEFAULT_UP_COLOR));
}

function drawSegment(context, fromX, fromY, toX, toY, { color, lineWidth }) {
  if (![fromX, fromY, toX, toY, lineWidth].every(Number.isFinite)) return false;
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(toX, toY);
  context.stroke();
  return true;
}

class KagiSeriesRenderer {
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
    if (!data?.visibleRange || !Array.isArray(data.bars)) return;

    target.useBitmapCoordinateSpace((scope) => {
      const context = scope?.context;
      if (!context) return;
      const horizontalPixelRatio = positiveNumber(scope.horizontalPixelRatio) || 1;
      const verticalPixelRatio = positiveNumber(scope.verticalPixelRatio) || 1;
      const widths = strokeWidths(
        this.options,
        data,
        horizontalPixelRatio,
        verticalPixelRatio,
      );
      const from = Math.max(0, Math.floor(finiteNumber(data.visibleRange.from) ?? 0));
      const to = Math.min(
        data.bars.length,
        Math.ceil(finiteNumber(data.visibleRange.to) ?? data.bars.length),
      );
      const toY = (price) => {
        const coordinate = priceConverter(price);
        return Number.isFinite(coordinate) ? coordinate * verticalPixelRatio : null;
      };

      context.lineCap = "round";
      context.lineJoin = "round";

      for (let index = from; index < to; index += 1) {
        const bar = data.bars[index];
        const originalData = bar?.originalData;
        const x = finiteNumber(bar?.x);
        const direction = kagiDirection(originalData);
        const sections = kagiSections(originalData);
        if (x == null || !direction || sections.length === 0) continue;
        const centerX = x * horizontalPixelRatio;

        // A reversal connector belongs visually to the leg that just ended,
        // so it inherits the previous leg's tail thickness and direction color.
        if (index > 0) {
          const previousBar = data.bars[index - 1];
          const previousData = previousBar?.originalData;
          const previousX = finiteNumber(previousBar?.x);
          const previousDirection = kagiDirection(previousData);
          const turnPrice = connectorPrice(originalData, previousData);
          const turnY = turnPrice == null ? null : toY(turnPrice);
          if (previousX != null && previousDirection && turnY != null) {
            const style = tailStyle(previousData);
            drawSegment(
              context,
              previousX * horizontalPixelRatio,
              turnY,
              centerX,
              turnY,
              {
                color: strokeColor(previousDirection, this.options, previousData, previousBar),
                lineWidth: widths[style],
              },
            );
          }
        }

        const color = strokeColor(direction, this.options, originalData, bar);
        for (const section of sections) {
          const fromY = toY(section.from);
          const sectionToY = toY(section.to);
          if (fromY == null || sectionToY == null) continue;
          drawSegment(context, centerX, fromY, centerX, sectionToY, {
            color,
            lineWidth: widths[section.style],
          });
        }
      }
    });
  }
}

class KagiSeriesPaneView {
  constructor() {
    this.seriesRenderer = new KagiSeriesRenderer();
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
      || kagiSections(data).length === 0;
  }

  defaultOptions() {
    return {
      ...customSeriesDefaultOptions,
      upColor: DEFAULT_UP_COLOR,
      downColor: DEFAULT_DOWN_COLOR,
      lineWidth: DEFAULT_LINE_WIDTH,
      thickLineWidth: DEFAULT_THICK_LINE_WIDTH,
    };
  }

  destroy() {
    this.seriesRenderer.update(null, null);
  }
}

export function createKagiSeriesPaneView() {
  return new KagiSeriesPaneView();
}
