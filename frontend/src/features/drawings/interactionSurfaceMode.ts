import { resolvePhase4DrawingEngineMode } from "./drawingEngineMode.js";

export const DRAWING_INTERACTION_SURFACE_MODES = ["overlay", "legacy"] as const;

export const DEFAULT_DRAWING_INTERACTION_SURFACE_MODE = "overlay" as const;

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

export interface DrawingHostInteractionSurfaceModeResolverOptions {
  readonly requestedInteractionMode?: DrawingInteractionSurfaceMode;
  readonly effectiveEngineMode?: unknown;
}

function configuredInteractionSurfaceMode(): unknown {
  try {
    return import.meta.env.VITE_DRAWING_INTERACTION_OVERLAY;
  } catch {
    return undefined;
  }
}

export function isDrawingInteractionSurfaceMode(
  value: unknown,
): value is DrawingInteractionSurfaceMode {
  return typeof value === "string"
    && (DRAWING_INTERACTION_SURFACE_MODES as readonly string[]).includes(value);
}

function isUnsetDrawingInteractionSurfaceMode(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Resolve once when the drawing host mounts. The caller deliberately keeps
 * the result in React state so a gesture can never switch render ownership
 * halfway through because deployment configuration changed underneath it.
 */
export function resolveDrawingInteractionSurfaceMode({
  configured = configuredInteractionSurfaceMode(),
  defaultMode = DEFAULT_DRAWING_INTERACTION_SURFACE_MODE,
}: DrawingInteractionSurfaceModeResolverOptions = {}): DrawingInteractionSurfaceModeResolution {
  if (isDrawingInteractionSurfaceMode(configured)) {
    return Object.freeze({ mode: configured, source: "environment", failedClosed: false });
  }
  if (!isUnsetDrawingInteractionSurfaceMode(configured)) {
    return Object.freeze({ mode: "legacy", source: "default", failedClosed: true });
  }
  const mode = isDrawingInteractionSurfaceMode(defaultMode) ? defaultMode : "legacy";
  return Object.freeze({
    mode,
    source: "default",
    failedClosed: !isDrawingInteractionSurfaceMode(defaultMode),
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

/** Resolve both mount-locked owners together so static and pointer surfaces cannot split. */
export function resolveDrawingHostInteractionSurfaceMode({
  requestedInteractionMode = resolveDrawingInteractionSurfaceMode().mode,
  effectiveEngineMode = resolvePhase4DrawingEngineMode().effective,
}: DrawingHostInteractionSurfaceModeResolverOptions = {}): DrawingInteractionSurfaceMode {
  return resolveEffectiveDrawingInteractionSurfaceMode(
    requestedInteractionMode,
    effectiveEngineMode,
  );
}
