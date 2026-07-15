import type { DrawingKind, DrawingPrimitive } from "../drawingTypes.js";

export const PHASE4_SCENE_DRAWING_KINDS = Object.freeze([
  "line",
  "axis-line",
  "shape",
] as const);

export type Phase4SceneDrawingKind = typeof PHASE4_SCENE_DRAWING_KINDS[number];

export function isPhase4SceneDrawingKind(
  value: DrawingKind | string | null | undefined,
): value is Phase4SceneDrawingKind {
  return value === "line" || value === "axis-line" || value === "shape";
}

/**
 * Transitional interaction objects still exist in Phase 4, but migrated
 * objects must not be attached as independent chart primitives.
 */
export function isPhase4SceneDrawingPrimitive(
  primitive: DrawingPrimitive | null | undefined,
): boolean {
  if (!primitive) return false;
  const candidate = primitive as DrawingPrimitive & {
    _lineType?: unknown;
    _shapeType?: unknown;
    _type?: unknown;
  };
  if (typeof candidate._lineType === "string") return true;
  return candidate._type === "axis-line" || candidate._type === "shape"
    || typeof candidate._shapeType === "string";
}
