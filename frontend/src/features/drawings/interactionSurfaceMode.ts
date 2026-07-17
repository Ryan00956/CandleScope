export const DRAWING_INTERACTION_SURFACE_MODES = ["overlay", "legacy"] as const;

export type DrawingInteractionSurfaceMode =
  typeof DRAWING_INTERACTION_SURFACE_MODES[number];

export interface DrawingInteractionSurfaceModeResolution {
  readonly mode: DrawingInteractionSurfaceMode;
  readonly source: "default" | "environment";
  /** True when an invalid configured value was rejected in favour of legacy. */
  readonly failedClosed: boolean;
}

export interface DrawingInteractionSurfaceModeResolverOptions {
  readonly configured?: unknown;
  readonly defaultMode?: DrawingInteractionSurfaceMode;
}

function configuredInteractionSurfaceMode(): unknown {
  return import.meta.env?.VITE_DRAWING_INTERACTION_OVERLAY;
}

export function isDrawingInteractionSurfaceMode(
  value: unknown,
): value is DrawingInteractionSurfaceMode {
  return typeof value === "string"
    && (DRAWING_INTERACTION_SURFACE_MODES as readonly string[]).includes(value);
}

/**
 * Resolve once when the drawing host mounts. The caller deliberately keeps
 * the result in React state so a gesture can never switch render ownership
 * halfway through because deployment configuration changed underneath it.
 */
export function resolveDrawingInteractionSurfaceMode({
  configured = configuredInteractionSurfaceMode(),
  defaultMode = "legacy",
}: DrawingInteractionSurfaceModeResolverOptions = {}): DrawingInteractionSurfaceModeResolution {
  if (isDrawingInteractionSurfaceMode(configured)) {
    return Object.freeze({ mode: configured, source: "environment", failedClosed: false });
  }
  const mode = isDrawingInteractionSurfaceMode(defaultMode) ? defaultMode : "legacy";
  return Object.freeze({
    mode,
    source: "default",
    failedClosed: configured !== undefined && configured !== null && configured !== "",
  });
}

/** Overlay ownership requires the Phase 4 single-scene static owner. */
export function resolveEffectiveDrawingInteractionSurfaceMode(
  requested: DrawingInteractionSurfaceMode,
  drawingEngineMode: unknown,
): DrawingInteractionSurfaceMode {
  return requested === "overlay" && drawingEngineMode === "scene-canary"
    ? "overlay"
    : "legacy";
}
