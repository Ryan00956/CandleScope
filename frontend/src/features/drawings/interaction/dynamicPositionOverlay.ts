import type { DrawingFrameThemePalette } from "../../../chart-adapter/drawingFrameSnapshot.js";
import {
  DEFAULT_POSITION_RENDER_SIZE,
} from "../rendering/drawingRenderDefaults.js";
import {
  drawingPositionLevelPresentation,
  drawingPositionPanelLines,
} from "../drawingPositionPresentation.js";
import type { DrawingPositionPanelLine } from "../drawingPositionPresentation.js";
import type {
  DrawingDataPoint,
  DrawingDataToScreen,
  PositionInfoPanelOffset,
  SavedPositionDrawing,
  ScreenBox,
  ScreenPoint,
} from "../drawingTypes.js";
import { positionInfoPanelLeft } from "../positionInfoPanelLayout.js";
import type { DrawingOverlayPlotRect } from "./overlayCanvasSurface.js";

export interface DynamicPositionLevelOverlay {
  readonly body: ScreenBox;
  readonly color: string;
  readonly line: readonly [ScreenPoint, ScreenPoint];
  readonly percentText: string;
  readonly pnlText: string | null;
  readonly priceText: string;
}

export interface DynamicPositionOverlayDecoration {
  readonly type: "position";
  readonly badgeColor: string;
  readonly badgeText: "LONG" | "SHORT";
  readonly direction: "long" | "short";
  readonly entryColor: string;
  readonly entryLine: readonly [ScreenPoint, ScreenPoint];
  readonly infoPanelOffset: Readonly<PositionInfoPanelOffset>;
  readonly lineWidth: number;
  readonly panelLines: readonly DrawingPositionPanelLine[];
  readonly selected: boolean;
  readonly slLevel: DynamicPositionLevelOverlay | null;
  readonly tpLevel: DynamicPositionLevelOverlay | null;
}

function finitePoint(point: ScreenPoint | null): point is ScreenPoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function dataPointFromHorizontalAnchor(
  anchor: unknown,
  price: number,
): DrawingDataPoint | null {
  if (typeof anchor === "number" && Number.isFinite(anchor)) return { time: anchor, price };
  if (!anchor || typeof anchor !== "object") return null;
  return { ...(anchor as Record<string, unknown>), price } as DrawingDataPoint;
}

function freezePoint(point: ScreenPoint): ScreenPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build a full-fidelity position draft in container-local CSS coordinates. */
export function buildDynamicPositionOverlayDecoration(
  saved: SavedPositionDrawing,
  dataToScreen: DrawingDataToScreen,
  themePalette: DrawingFrameThemePalette,
  currentPrice: number | null = null,
): DynamicPositionOverlayDecoration | null {
  const entryPrice = finitePrice(saved.entryPrice);
  const tpPrice = saved.tpPrice == null ? null : finitePrice(saved.tpPrice);
  const slPrice = saved.slPrice == null ? null : finitePrice(saved.slPrice);
  if (entryPrice === null
    || (saved.tpPrice != null && tpPrice === null)
    || (saved.slPrice != null && slPrice === null)
    || !saved.timeRange) return null;

  const start = dataPointFromHorizontalAnchor(saved.timeRange.start, entryPrice);
  const end = dataPointFromHorizontalAnchor(saved.timeRange.end, entryPrice);
  const startScreen = start ? dataToScreen(start) : null;
  const endScreen = end ? dataToScreen(end) : null;
  if (!finitePoint(startScreen) || !finitePoint(endScreen)) return null;

  let left = Math.min(startScreen.x, endScreen.x);
  let right = Math.max(startScreen.x, endScreen.x);
  if (right - left < 24) {
    const middle = (left + right) / 2;
    left = middle - 12;
    right = middle + 12;
  }
  const entryY = startScreen.y;
  const positionSize = typeof saved.positionSize === "number"
    && Number.isFinite(saved.positionSize)
    ? saved.positionSize
    : DEFAULT_POSITION_RENDER_SIZE;
  const direction = saved.direction === "short" ? "short" : "long";
  const presentationBase = {
    direction,
    entryPrice,
    positionSize,
    themePalette,
  } as const;
  const buildLevel = (price: number | null): DynamicPositionLevelOverlay | null => {
    if (price === null) return null;
    const levelPoint = start
      ? dataToScreen({ ...start, price })
      : null;
    if (!finitePoint(levelPoint)) return null;
    const presentation = drawingPositionLevelPresentation(presentationBase, price);
    const top = Math.min(entryY, levelPoint.y);
    const bottom = Math.max(entryY, levelPoint.y);
    return Object.freeze({
      ...presentation,
      line: Object.freeze([
        freezePoint({ x: left, y: levelPoint.y }),
        freezePoint({ x: right, y: levelPoint.y }),
      ] as const),
      body: Object.freeze({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      }),
    });
  };
  const infoPanelOffset = Object.freeze({
    ...(saved.infoPanelOffset?.anchor === "left" ? { anchor: "left" as const } : {}),
    x: typeof saved.infoPanelOffset?.x === "number"
      && Number.isFinite(saved.infoPanelOffset.x)
      ? saved.infoPanelOffset.x
      : 0,
    y: typeof saved.infoPanelOffset?.y === "number"
      && Number.isFinite(saved.infoPanelOffset.y)
      ? saved.infoPanelOffset.y
      : 0,
  });

  return Object.freeze({
    type: "position" as const,
    badgeColor: direction === "long" ? themePalette.upColor : themePalette.downColor,
    badgeText: direction === "long" ? "LONG" as const : "SHORT" as const,
    direction,
    entryColor: "#2196f3",
    entryLine: Object.freeze([
      freezePoint({ x: left, y: entryY }),
      freezePoint({ x: right, y: entryY }),
    ] as const),
    infoPanelOffset,
    lineWidth: 2.5,
    panelLines: drawingPositionPanelLines({
      currentPrice,
      direction,
      entryPrice,
      positionSize,
      slPrice,
      themePalette,
      tpPrice,
    }),
    selected: true,
    slLevel: buildLevel(slPrice),
    tpLevel: buildLevel(tpPrice),
  });
}

function adjustAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return "transparent";
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  const rgba = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgba) return `rgba(${rgba[1]},${rgba[2]},${rgba[3]},${normalizedAlpha})`;
  const channels = color.length === 4
    ? [color.charAt(1).repeat(2), color.charAt(2).repeat(2), color.charAt(3).repeat(2)]
    : color.length === 7
      ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      : null;
  if (!channels) return color;
  const [red, green, blue] = channels.map((channel) => Number.parseInt(channel ?? "", 16));
  return [red, green, blue].every(Number.isFinite)
    ? `rgba(${red},${green},${blue},${normalizedAlpha})`
    : color;
}

function localPoint(point: ScreenPoint, rect: DrawingOverlayPlotRect): ScreenPoint {
  return { x: point.x - rect.x, y: point.y - rect.y };
}

function localBox(box: ScreenBox, rect: DrawingOverlayPlotRect): ScreenBox {
  return { ...box, x: box.x - rect.x, y: box.y - rect.y };
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function measuredTextWidth(context: CanvasRenderingContext2D, text: string): number {
  try {
    const width = context.measureText(text).width;
    if (Number.isFinite(width) && width >= 0) return width;
  } catch {
    // Use the deterministic fallback below.
  }
  return [...text].reduce((width, character) => (
    width + (character.charCodeAt(0) > 0xff ? 11 : 11 * 0.62)
  ), 0);
}

function drawPriceBadge(
  context: CanvasRenderingContext2D,
  level: DynamicPositionLevelOverlay,
  rect: DrawingOverlayPlotRect,
): void {
  const line = level.line.map((point) => localPoint(point, rect)) as unknown as readonly [
    ScreenPoint,
    ScreenPoint,
  ];
  const text = [level.priceText, level.percentText, ...(level.pnlText ? [level.pnlText] : [])]
    .join("  ");
  const fontSize = 10;
  context.font = `${fontSize}px sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  const paddingX = 6;
  const paddingY = 4;
  const width = measuredTextWidth(context, text) + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const right = Math.max(line[0].x, line[1].x);
  const y = (line[0].y + line[1].y) / 2;
  const x = right + 4;
  const top = y - height / 2;
  context.fillStyle = adjustAlpha(level.color, 0.9);
  roundRect(context, x, top, width, height, 3);
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillText(text, x + paddingX, y);
}

function drawLevel(
  context: CanvasRenderingContext2D,
  level: DynamicPositionLevelOverlay,
  rect: DrawingOverlayPlotRect,
): void {
  const body = localBox(level.body, rect);
  const from = localPoint(level.line[0], rect);
  const to = localPoint(level.line[1], rect);
  context.fillStyle = adjustAlpha(level.color, 0.15);
  context.fillRect(body.x, body.y, body.width, body.height);
  context.strokeStyle = adjustAlpha(level.color, 0.8);
  context.lineWidth = 2;
  context.setLineDash([6, 3]);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.setLineDash([]);
  drawPriceBadge(context, level, rect);
}

function drawInfoPanel(
  context: CanvasRenderingContext2D,
  item: DynamicPositionOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  const entry = item.entryLine.map((point) => localPoint(point, rect)) as unknown as readonly [
    ScreenPoint,
    ScreenPoint,
  ];
  const fontSize = 11;
  const lineHeight = 17;
  const paddingX = 8;
  const paddingY = 6;
  context.font = `${fontSize}px sans-serif`;
  const textWidth = item.panelLines.reduce((width, line) => {
    const text = `${line.label}: ${line.value}${line.extra ? ` ${line.extra}` : ""}`;
    return Math.max(width, measuredTextWidth(context, text));
  }, 0);
  const boxWidth = textWidth + paddingX * 2;
  const boxHeight = item.panelLines.length * lineHeight + paddingY * 2;
  const right = Math.max(entry[0].x, entry[1].x);
  const entryY = (entry[0].y + entry[1].y) / 2;
  const left = Math.min(entry[0].x, entry[1].x);
  const boxX = positionInfoPanelLeft(
    left,
    right,
    boxWidth,
    item.infoPanelOffset,
  );
  const boxY = Math.max(4, entryY - boxHeight - 8 + item.infoPanelOffset.y);

  context.fillStyle = "rgba(30, 33, 40, 0.92)";
  context.shadowColor = "rgba(0,0,0,0.4)";
  context.shadowBlur = 8 * rect.dpr;
  roundRect(context, boxX, boxY, boxWidth, boxHeight, 6);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 1;
  roundRect(context, boxX, boxY, boxWidth, boxHeight, 6);
  context.stroke();
  context.textAlign = "left";
  context.textBaseline = "middle";
  item.panelLines.forEach((line, index) => {
    const y = boxY + paddingY + lineHeight * index + lineHeight / 2;
    const label = `${line.label}: `;
    context.fillStyle = "rgba(255,255,255,0.5)";
    context.font = `${fontSize}px sans-serif`;
    context.fillText(label, boxX + paddingX, y);
    const labelWidth = measuredTextWidth(context, label);
    context.fillStyle = line.color;
    context.font = `bold ${fontSize}px sans-serif`;
    context.fillText(line.value, boxX + paddingX + labelWidth, y);
    if (line.extra) {
      const valueWidth = measuredTextWidth(context, `${line.value} `);
      context.fillStyle = adjustAlpha(line.color, 0.7);
      context.font = `${fontSize}px sans-serif`;
      context.fillText(line.extra, boxX + paddingX + labelWidth + valueWidth, y);
    }
  });

  if (!item.selected) return;
  context.strokeStyle = "rgba(59, 130, 246, 0.55)";
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  roundRect(context, boxX - 1, boxY - 1, boxWidth + 2, boxHeight + 2, 6);
  context.stroke();
  context.setLineDash([]);
  const gripX = boxX + boxWidth - 13;
  const gripY = boxY + 9;
  context.fillStyle = "rgba(255,255,255,0.55)";
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      context.beginPath();
      context.arc(gripX + column * 5, gripY + row * 5, 1.2, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function drawDirectionBadge(
  context: CanvasRenderingContext2D,
  item: DynamicPositionOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  const entry = item.entryLine.map((point) => localPoint(point, rect));
  const left = Math.min(entry[0]?.x ?? 0, entry[1]?.x ?? 0);
  const y = ((entry[0]?.y ?? 0) + (entry[1]?.y ?? 0)) / 2;
  const x = left + 4;
  const top = y - 24;
  context.fillStyle = item.badgeColor;
  roundRect(context, x, top, 48, 20, 4);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "bold 11px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(item.badgeText, x + 24, top + 10);
}

function drawSelectedControls(
  context: CanvasRenderingContext2D,
  item: DynamicPositionOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  if (!item.selected) return;
  const entry = item.entryLine.map((point) => localPoint(point, rect));
  const left = Math.min(entry[0]?.x ?? 0, entry[1]?.x ?? 0);
  const right = Math.max(entry[0]?.x ?? 0, entry[1]?.x ?? 0);
  const entryY = ((entry[0]?.y ?? 0) + (entry[1]?.y ?? 0)) / 2;
  const middleX = (left + right) / 2;
  context.fillStyle = "#ffffff";
  context.strokeStyle = item.entryColor;
  context.lineWidth = 2;
  context.shadowColor = "rgba(0,0,0,0.3)";
  context.shadowBlur = 4 * rect.dpr;
  context.beginPath();
  context.arc(middleX, entryY, 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  const levels = [item.tpLevel, item.slLevel].filter(
    (level): level is DynamicPositionLevelOverlay => level !== null,
  );
  for (const level of levels) {
    const line = level.line.map((point) => localPoint(point, rect));
    const y = ((line[0]?.y ?? 0) + (line[1]?.y ?? 0)) / 2;
    const width = Math.min(60, (right - left) * 0.4);
    const x = middleX - width / 2;
    context.fillStyle = adjustAlpha(level.color, 0.6);
    roundRect(context, x, y - 3, width, 6, 3);
    context.fill();
    const pointsUp = item.direction === "long"
      ? level === item.tpLevel
      : level === item.slLevel;
    context.fillStyle = "#ffffff";
    context.beginPath();
    if (pointsUp) {
      context.moveTo(middleX, y - 4);
      context.lineTo(middleX - 4, y + 2);
      context.lineTo(middleX + 4, y + 2);
    } else {
      context.moveTo(middleX, y + 4);
      context.lineTo(middleX - 4, y - 2);
      context.lineTo(middleX + 4, y - 2);
    }
    context.closePath();
    context.fill();
  }

  const verticals = [
    entryY,
    ...levels.map((level) => localPoint(level.line[0], rect).y),
  ];
  const top = Math.min(...verticals);
  const bottom = Math.max(...verticals);
  const height = Math.min(24, Math.abs(bottom - top) * 0.4);
  if (height < 4) return;
  const middleY = (top + bottom) / 2;
  for (const x of [left, right]) {
    context.fillStyle = adjustAlpha("#90a4ae", 0.7);
    roundRect(context, x - 2, middleY - height / 2, 4, height, 2);
    context.fill();
  }
}

/** Paint one position draft without depending on the retained scene/document lifecycle. */
export function drawDynamicPositionOverlayDecoration(
  context: CanvasRenderingContext2D,
  item: DynamicPositionOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  if (!finitePoint(item.entryLine[0])
    || !finitePoint(item.entryLine[1])
    || item.panelLines.length === 0
    || !Number.isFinite(item.lineWidth)
    || item.lineWidth <= 0) return;
  context.save();
  if (item.tpLevel) drawLevel(context, item.tpLevel, rect);
  if (item.slLevel) drawLevel(context, item.slLevel, rect);
  const entryFrom = localPoint(item.entryLine[0], rect);
  const entryTo = localPoint(item.entryLine[1], rect);
  context.strokeStyle = item.entryColor;
  context.lineWidth = item.lineWidth;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(entryFrom.x, entryFrom.y);
  context.lineTo(entryTo.x, entryTo.y);
  context.stroke();
  drawInfoPanel(context, item, rect);
  drawDirectionBadge(context, item, rect);
  drawSelectedControls(context, item, rect);
  context.restore();
}
