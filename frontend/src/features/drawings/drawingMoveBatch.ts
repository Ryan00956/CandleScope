import { MAX_FREEHAND_STROKE_POINTS } from "./freehandStrokeModel.js";
import type { ActiveDrawingMovePayload, ScreenPoint } from "./drawingTypes.js";

function isFreehandMovePayload(
  payload: ActiveDrawingMovePayload | null | undefined,
): payload is ActiveDrawingMovePayload & { tool: "pen" | "highlighter" } {
  return payload?.tool === "pen" || payload?.tool === "highlighter";
}

export function limitFreehandCapturePositions(
  positions: readonly ScreenPoint[] | null | undefined,
  remainingCapacity: number,
): ScreenPoint[] {
  if (!positions
    || !Number.isSafeInteger(remainingCapacity)
    || remainingCapacity < 0) {
    return [];
  }
  return positions.slice(0, remainingCapacity);
}

/** Merge all pen samples observed before the next RAF; other tools stay latest-wins. */
export function mergePendingActiveDrawingMove(
  pending: ActiveDrawingMovePayload | null | undefined,
  payload: ActiveDrawingMovePayload | null | undefined,
  maxPositions = MAX_FREEHAND_STROKE_POINTS,
): ActiveDrawingMovePayload | null | undefined {
  const limit = Number.isSafeInteger(maxPositions) && maxPositions > 0
    ? maxPositions
    : MAX_FREEHAND_STROKE_POINTS;
  if (!payload || !isFreehandMovePayload(payload)) return payload;
  if (!pending
    || !isFreehandMovePayload(pending)
    || pending.tool !== payload.tool) {
    return payload.positions && payload.positions.length > limit
      ? { ...payload, positions: payload.positions.slice(0, limit) }
      : payload;
  }

  const positions = pending.positions
    ? pending.positions
    : (pending.pos ? [pending.pos] : []);
  const incoming = payload.positions && payload.positions.length > 0
    ? payload.positions
    : (payload.pos ? [payload.pos] : []);
  const remaining = Math.max(0, limit - positions.length);
  for (let index = 0; index < incoming.length && index < remaining; index += 1) {
    const position = incoming[index];
    if (position) positions.push(position);
  }
  pending.positions = positions;
  if (payload.pos) pending.pos = payload.pos;
  else delete pending.pos;
  if (payload.e) pending.e = payload.e;
  else delete pending.e;
  return pending;
}
