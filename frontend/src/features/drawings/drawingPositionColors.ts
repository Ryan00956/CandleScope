import type { DrawingFrameThemePalette } from "../../chart-adapter/drawingFrameSnapshot.js";

export const DEFAULT_DRAWING_POSITION_THEME_PALETTE: DrawingFrameThemePalette = Object.freeze({
  upColor: "#22c55e",
  downColor: "#ef4444",
});

/** Keep position levels aligned with the chart candle palette by price direction. */
export function drawingPositionLevelColor(
  entryPrice: number,
  levelPrice: number,
  themePalette: DrawingFrameThemePalette = DEFAULT_DRAWING_POSITION_THEME_PALETTE,
): string {
  return levelPrice > entryPrice ? themePalette.upColor : themePalette.downColor;
}
