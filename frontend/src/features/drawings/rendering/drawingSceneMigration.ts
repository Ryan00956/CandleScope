import type { DrawingKind, DrawingPrimitive } from "../drawingTypes.js";

export const PHASE4_SCENE_DRAWING_KINDS = Object.freeze([
  "line",
  "axis-line",
  "shape",
] as const);

export type Phase4SceneDrawingKind = typeof PHASE4_SCENE_DRAWING_KINDS[number];

export const PHASE6_SCENE_DRAWING_KINDS = Object.freeze([
  ...PHASE4_SCENE_DRAWING_KINDS,
  "freehand",
  "highlighter",
] as const);

export type Phase6SceneDrawingKind = typeof PHASE6_SCENE_DRAWING_KINDS[number];

export const PHASE8_SCENE_DRAWING_KINDS = Object.freeze([
  "line",
  "axis-line",
  "angle-measure",
  "text",
  "fibonacci",
  "position",
  "shape",
  "freehand",
  "highlighter",
] as const);

export type Phase8SceneDrawingKind = typeof PHASE8_SCENE_DRAWING_KINDS[number];

export function isPhase4SceneDrawingKind(
  value: DrawingKind | string | null | undefined,
): value is Phase4SceneDrawingKind {
  return value === "line" || value === "axis-line" || value === "shape";
}

export function isPhase6SceneDrawingKind(
  value: DrawingKind | string | null | undefined,
): value is Phase6SceneDrawingKind {
  return isPhase4SceneDrawingKind(value)
    || value === "freehand"
    || value === "highlighter";
}

export function isPhase8SceneDrawingKind(
  value: DrawingKind | string | null | undefined,
): value is Phase8SceneDrawingKind {
  return value === "line"
    || value === "axis-line"
    || value === "angle-measure"
    || value === "text"
    || value === "fibonacci"
    || value === "position"
    || value === "shape"
    || value === "freehand"
    || value === "highlighter";
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

/** Phase 6 keeps compatibility proxies but removes their chart ownership. */
export function isPhase6SceneDrawingPrimitive(
  primitive: DrawingPrimitive | null | undefined,
): boolean {
  if (!primitive) return false;
  if (isPhase4SceneDrawingPrimitive(primitive)) return true;
  const candidate = primitive as DrawingPrimitive & { _type?: unknown; type?: unknown };
  const type = candidate._type ?? candidate.type;
  return type === "freehand" || type === "highlighter";
}

/** Phase 8 static ownership covers every persisted drawing kind. */
export function isPhase8SceneDrawingPrimitive(
  primitive: DrawingPrimitive | null | undefined,
): boolean {
  if (!primitive) return false;
  if (isPhase4SceneDrawingPrimitive(primitive)) return true;
  const candidate = primitive as DrawingPrimitive & { _type?: unknown; type?: unknown };
  const type = candidate._type ?? candidate.type;
  return type === "angle-measure"
    || type === "text"
    || type === "fibonacci"
    || type === "position"
    || type === "freehand"
    || type === "highlighter";
}
