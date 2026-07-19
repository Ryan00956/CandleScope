import type {
  PositionInfoPanelAnchor,
  PositionInfoPanelOffset,
} from "./drawingTypes.js";

export const POSITION_INFO_PANEL_GAP = 8;

export function positionInfoPanelAnchor(
  offset: PositionInfoPanelOffset | null | undefined,
): PositionInfoPanelAnchor {
  return offset?.anchor === "left" ? "left" : "right";
}

/** Resolve the panel's left edge in the same coordinate space as the position. */
export function positionInfoPanelLeft(
  positionLeft: number,
  positionRight: number,
  panelWidth: number,
  offset: PositionInfoPanelOffset,
  horizontalScale = 1,
): number {
  const anchorX = positionInfoPanelAnchor(offset) === "left"
    ? positionLeft
    : positionRight;
  return anchorX
    - panelWidth
    - POSITION_INFO_PANEL_GAP * horizontalScale
    + offset.x * horizontalScale;
}

/**
 * Translate a dragged panel offset while switching to the left edge once the
 * panel has fully crossed it. The conversion preserves the current pixel
 * position, so crossing the edge never produces a visual jump.
 */
export function draggedPositionInfoPanelOffset({
  deltaX,
  deltaY,
  original,
  positionLeft,
  positionRight,
}: Readonly<{
  deltaX: number;
  deltaY: number;
  original: PositionInfoPanelOffset;
  positionLeft: number;
  positionRight: number;
}>): PositionInfoPanelOffset {
  const width = Math.max(0, positionRight - positionLeft);
  const originalRightOffset = positionInfoPanelAnchor(original) === "left"
    ? original.x - width
    : original.x;
  const rightOffset = originalRightOffset + deltaX;
  const anchor: PositionInfoPanelAnchor = rightOffset <= POSITION_INFO_PANEL_GAP - width
    ? "left"
    : "right";
  const x = anchor === "left" ? rightOffset + width : rightOffset;
  const y = original.y + deltaY;
  return anchor === "left" ? { anchor, x, y } : { x, y };
}
