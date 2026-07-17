export const DRAWING_ENGINE_MODES = [
  "legacy",
  "shadow",
  "scene-canary",
  "scene",
] as const;

export const DEFAULT_DRAWING_ENGINE_MODE = "scene-canary" as const;

export type DrawingEngineMode = typeof DRAWING_ENGINE_MODES[number];
export type DrawingEngineEffectiveMode = "legacy" | "shadow" | "scene-canary";
export type DrawingEngineModeSource = "default" | "environment" | "url";

export interface DrawingEngineModeResolution {
  readonly requested: DrawingEngineMode;
  readonly effective: DrawingEngineEffectiveMode;
  readonly source: DrawingEngineModeSource;
  /** Phase 3 has no visible scene backend, so visible modes fail closed. */
  readonly failedClosed: boolean;
}

export interface DrawingEngineModeResolverOptions {
  /** Deployment configuration, normally VITE_DRAWING_ENGINE_MODE. */
  configured?: unknown;
  /** Query string used only by explicit development/test callers. */
  urlSearch?: unknown;
  /** Production callers must leave this false. */
  allowUrlOverride?: boolean;
  defaultMode?: DrawingEngineMode;
}

function configuredDrawingEngineMode(): unknown {
  // Keep the property access direct: Vite only replaces this exact form.
  try {
    return import.meta.env.VITE_DRAWING_ENGINE_MODE;
  } catch {
    return undefined;
  }
}

function developmentUrlOverrideAllowed(): boolean {
  return import.meta.env?.DEV === true || import.meta.env?.MODE === "test";
}

function currentUrlSearch(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location?.search ?? "";
  } catch {
    return "";
  }
}

export function isDrawingEngineMode(value: unknown): value is DrawingEngineMode {
  return typeof value === "string"
    && (DRAWING_ENGINE_MODES as readonly string[]).includes(value);
}

function modeFromUrl(search: unknown): DrawingEngineMode | null {
  if (typeof search !== "string" || search.length === 0) return null;
  try {
    const mode = new URLSearchParams(search).get("drawingEngineMode");
    return isDrawingEngineMode(mode) ? mode : null;
  } catch {
    return null;
  }
}

function isUnsetDrawingEngineMode(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Resolve the requested rollout mode. URL overrides are intentionally opt-in
 * so production never accepts an arbitrary user-controlled mode.
 */
export function resolveRequestedDrawingEngineMode({
  configured = configuredDrawingEngineMode(),
  urlSearch = currentUrlSearch(),
  allowUrlOverride = developmentUrlOverrideAllowed(),
  defaultMode = DEFAULT_DRAWING_ENGINE_MODE,
}: DrawingEngineModeResolverOptions = {}): Readonly<{
  mode: DrawingEngineMode;
  source: DrawingEngineModeSource;
}> {
  if (allowUrlOverride) {
    const override = modeFromUrl(urlSearch);
    if (override) return Object.freeze({ mode: override, source: "url" });
  }
  if (isDrawingEngineMode(configured)) {
    return Object.freeze({ mode: configured, source: "environment" });
  }
  // A non-empty deployment value is an explicit request. Reject unknown
  // values to legacy instead of accidentally enabling the release default.
  if (!isUnsetDrawingEngineMode(configured)) {
    return Object.freeze({ mode: "legacy", source: "default" });
  }
  return Object.freeze({
    mode: isDrawingEngineMode(defaultMode) ? defaultMode : "legacy",
    source: "default",
  });
}

/**
 * Phase 3 can execute legacy or invisible shadow work only. The visible
 * scene-canary/scene values remain parseable for forward-compatible rollout
 * configuration, but fail closed until Phase 4 installs a scene primitive.
 */
export function resolvePhase3DrawingEngineMode(
  options: DrawingEngineModeResolverOptions = {},
): DrawingEngineModeResolution {
  const resolved = resolveRequestedDrawingEngineMode(options);
  const effective = resolved.mode === "shadow" ? "shadow" : "legacy";
  return Object.freeze({
    requested: resolved.mode,
    effective,
    source: resolved.source,
    failedClosed: resolved.mode === "scene-canary" || resolved.mode === "scene",
  });
}

/**
 * Phase 4 unlocks the visible canary for the first migrated kinds. Full scene
 * mode remains fail-closed until every kind and dynamic overlay has migrated.
 */
export function resolvePhase4DrawingEngineMode(
  options: DrawingEngineModeResolverOptions = {},
): DrawingEngineModeResolution {
  const resolved = resolveRequestedDrawingEngineMode(options);
  const effective: DrawingEngineEffectiveMode = resolved.mode === "shadow"
    ? "shadow"
    : resolved.mode === "scene-canary" ? "scene-canary" : "legacy";
  return Object.freeze({
    requested: resolved.mode,
    effective,
    source: resolved.source,
    failedClosed: resolved.mode === "scene",
  });
}
