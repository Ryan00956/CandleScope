import type {
  DrawingFrameSnapshot,
  DrawingFrameThemePalette,
} from "../../chart-adapter/drawingFrameSnapshot.js";
import { drawingPositionLevelColor } from "./drawingPositionColors.js";

export interface DrawingPositionPanelLine {
  readonly label: string;
  readonly value: string;
  readonly extra: string | null;
  readonly color: string;
}

export interface DrawingPositionPresentationInput {
  readonly currentPrice: number | null;
  readonly direction: "long" | "short";
  readonly entryPrice: number;
  readonly positionSize: number;
  readonly slPrice: number | null;
  readonly themePalette: DrawingFrameThemePalette;
  readonly tpPrice: number | null;
}

export interface DrawingPositionLevelPresentation {
  readonly color: string;
  readonly percentText: string;
  readonly pnlText: string | null;
  readonly priceText: string;
}

export function formatDrawingPositionPrice(price: number): string {
  if (price >= 1_000) {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

export function drawingPositionPnlPercent(
  entryPrice: number,
  price: number,
  isLong: boolean,
): number {
  if (!entryPrice) return 0;
  return isLong
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
}

export function signedDrawingPositionValue(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function drawingPositionCurrentPrice(frame: DrawingFrameSnapshot): number | null {
  const last = frame.seriesData.at(-1);
  if (!last) return null;
  if (typeof last.close === "number" && Number.isFinite(last.close)) return last.close;
  return typeof last.value === "number" && Number.isFinite(last.value) ? last.value : null;
}

export function drawingPositionLevelPresentation(
  input: Omit<DrawingPositionPresentationInput, "currentPrice" | "slPrice" | "tpPrice">,
  price: number,
): DrawingPositionLevelPresentation {
  const percent = drawingPositionPnlPercent(
    input.entryPrice,
    price,
    input.direction === "long",
  );
  const pnl = input.positionSize ? input.positionSize * percent / 100 : 0;
  return Object.freeze({
    priceText: formatDrawingPositionPrice(price),
    percentText: `${signedDrawingPositionValue(percent)}%`,
    pnlText: pnl === 0 ? null : signedDrawingPositionValue(pnl),
    color: drawingPositionLevelColor(input.entryPrice, price, input.themePalette),
  });
}

export function drawingPositionPanelLines({
  currentPrice,
  direction,
  entryPrice,
  positionSize,
  slPrice,
  themePalette,
  tpPrice,
}: DrawingPositionPresentationInput): readonly DrawingPositionPanelLine[] {
  const isLong = direction === "long";
  const priceColor = (price: number): string => drawingPositionLevelColor(
    entryPrice,
    price,
    themePalette,
  );
  const lines: DrawingPositionPanelLine[] = [Object.freeze({
    label: "入场",
    value: formatDrawingPositionPrice(entryPrice),
    extra: null,
    color: "#2196f3",
  })];
  if (tpPrice !== null) {
    const percent = drawingPositionPnlPercent(entryPrice, tpPrice, isLong);
    const pnl = positionSize ? positionSize * percent / 100 : null;
    lines.push(Object.freeze({
      label: "止盈",
      value: `${formatDrawingPositionPrice(tpPrice)} (${signedDrawingPositionValue(percent)}%)`,
      extra: pnl === null ? null : signedDrawingPositionValue(pnl),
      color: priceColor(tpPrice),
    }));
  }
  if (slPrice !== null) {
    const percent = drawingPositionPnlPercent(entryPrice, slPrice, isLong);
    const pnl = positionSize ? positionSize * percent / 100 : null;
    lines.push(Object.freeze({
      label: "止损",
      value: `${formatDrawingPositionPrice(slPrice)} (${signedDrawingPositionValue(percent)}%)`,
      extra: pnl === null ? null : signedDrawingPositionValue(pnl),
      color: priceColor(slPrice),
    }));
  }
  if (currentPrice !== null && Number.isFinite(currentPrice)) {
    const percent = drawingPositionPnlPercent(entryPrice, currentPrice, isLong);
    const pnl = positionSize ? positionSize * percent / 100 : null;
    lines.push(Object.freeze({
      label: "现价",
      value: `${formatDrawingPositionPrice(currentPrice)} (${signedDrawingPositionValue(percent)}%)`,
      extra: pnl === null ? null : signedDrawingPositionValue(pnl),
      color: priceColor(currentPrice),
    }));
  }
  if (tpPrice !== null && slPrice !== null && entryPrice) {
    const reward = Math.abs(tpPrice - entryPrice);
    const risk = Math.abs(slPrice - entryPrice);
    if (risk > 0) lines.push(Object.freeze({
      label: "盈亏比",
      value: `1 : ${(reward / risk).toFixed(2)}`,
      extra: null,
      color: "#ffab40",
    }));
  }
  if (positionSize) lines.push(Object.freeze({
    label: "仓位",
    value: `$${positionSize.toFixed(0)}`,
    extra: null,
    color: "#b0bec5",
  }));
  return Object.freeze(lines);
}
