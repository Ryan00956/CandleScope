import type { DrawingDisplayHitResult } from "../rendering/drawingDisplayList.js";
import type {
  DrawingHit,
  DrawingHitType,
  SavedDrawing,
} from "../drawingTypes.js";

export type DrawingEntityHit = DrawingHit & Readonly<{
  id: string;
  saved: SavedDrawing;
  type: DrawingHitType;
}>;

export function drawingHitTypeFromSavedDrawing(saved: SavedDrawing): DrawingHitType {
  return saved.type === "angle-measure" ? "angle" : saved.type;
}

/** Resolve one scene hit against its canonical entity lookup result. */
export function drawingEntityHitFromSavedDrawing(
  saved: SavedDrawing | null,
  hit: DrawingDisplayHitResult | null,
): DrawingEntityHit | null {
  if (!hit || !saved || saved.type !== hit.kind || !saved.id) return null;
  return Object.freeze({
    id: saved.id,
    saved,
    type: drawingHitTypeFromSavedDrawing(saved),
    ...(hit.pointIndex === undefined ? {} : { pointIndex: hit.pointIndex }),
    ...(hit.zone === undefined ? {} : { zone: hit.zone }),
    ...(hit.handle === undefined ? {} : { handle: hit.handle }),
    ...(hit.body === undefined ? {} : { body: hit.body }),
  });
}

/** Resolve a scene hit against the canonical z-ordered SavedDrawing snapshot. */
export function drawingEntityHitFromDisplay(
  drawings: readonly SavedDrawing[],
  hit: DrawingDisplayHitResult | null,
): DrawingEntityHit | null {
  if (!hit) return null;
  const saved = drawings.find((drawing) => drawing.id === hit.entityId);
  return drawingEntityHitFromSavedDrawing(saved ?? null, hit);
}
