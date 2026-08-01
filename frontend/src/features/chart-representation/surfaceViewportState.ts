import {
  axisTimeKey,
  mapSourceViewportAnchorToDisplayLogicalRange,
  sourceTimeFromAxisTime,
  sourceTimeFromDisplayRow,
  sourceTimeRangeFromDisplayRow,
} from "./axisTime.js";
import type {
  AxisTime,
  DisplayRow,
  LogicalRange,
  SurfaceViewportSnapshot,
} from "./chartRepresentationTypes.js";

export const SURFACE_VIEWPORT_CACHE_LIMIT = 32;

const VIEWPORT_GEOMETRY_EPSILON = 1e-6;

function finiteRange(range: unknown): LogicalRange | null {
  const record = range && typeof range === "object"
    ? range as Record<string, unknown>
    : null;
  const from = Number(record?.from);
  const to = Number(record?.to);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to
    ? { from, to }
    : null;
}

function stableAxisTime(time: AxisTime): AxisTime {
  return time && typeof time === "object" ? { ...time } : time;
}

export function buildSurfaceViewportCacheKey(
  datasetKey: unknown,
  surfaceConfigKey: unknown,
): string | null {
  if (!datasetKey || !surfaceConfigKey) return null;
  return JSON.stringify([datasetKey, surfaceConfigKey]);
}

export function bindSurfaceViewportSourceAnchor(
  captured: SurfaceViewportSnapshot | null | undefined,
  source: SurfaceViewportSnapshot | null | undefined,
): SurfaceViewportSnapshot | null {
  if (!captured || !source || captured.datasetKey !== source.datasetKey) return captured ?? null;
  return {
    ...captured,
    anchorSourceTime: source.anchorSourceTime,
  };
}

export function preserveBoundSurfaceViewportSourceAnchor(
  captured: SurfaceViewportSnapshot | null | undefined,
  bound: SurfaceViewportSnapshot | null | undefined,
): SurfaceViewportSnapshot | null {
  if (!captured || !bound
    || captured.datasetKey !== bound.datasetKey
    || captured.surfaceConfigKey !== bound.surfaceConfigKey
    || captured.axisMode !== bound.axisMode
    || axisTimeKey(captured.anchorTime) !== axisTimeKey(bound.anchorTime)
    || Math.abs(captured.logicalSpan - bound.logicalSpan) > VIEWPORT_GEOMETRY_EPSILON
    || Math.abs(captured.screenOffset - bound.screenOffset) > VIEWPORT_GEOMETRY_EPSILON) {
    return captured ?? null;
  }
  return {
    ...captured,
    anchorSourceTime: bound.anchorSourceTime,
  };
}

/**
 * Capture a projection-safe horizontal viewport.
 *
 * The anchor is always a real display row, even when the right edge is in the
 * future whitespace carrier. `screenOffset` then preserves that whitespace.
 */
export function buildSurfaceViewportSnapshot({
  axisMode,
  barSpacing,
  datasetKey,
  displayRows = [],
  logicalRange,
  sourceRange = null,
  surfaceConfigKey,
}: {
  axisMode?: unknown;
  barSpacing?: unknown;
  datasetKey?: unknown;
  displayRows?: readonly DisplayRow[];
  logicalRange?: unknown;
  sourceRange?: unknown;
  surfaceConfigKey?: unknown;
} = {}): SurfaceViewportSnapshot | null {
  const logical = finiteRange(logicalRange);
  if (!logical || displayRows.length === 0) return null;

  const lastIndex = displayRows.length - 1;
  const anchorIndex = Math.max(0, Math.min(lastIndex, Math.round(logical.to)));
  const anchorRow = displayRows[anchorIndex];
  if (!anchorRow) return null;
  const anchorTime = anchorRow.time;
  // A display bucket can represent several revealed source bars. Prefer its
  // lineage tail over the bucket-open axis coordinate so a 1m -> 15m -> 1m
  // round trip does not degrade 12:07 into 12:00.
  const anchorSourceTime = sourceTimeFromDisplayRow(anchorRow)
    ?? sourceTimeFromAxisTime(anchorTime);
  if (anchorTime == null || anchorSourceTime === null || !Number.isFinite(anchorSourceTime)) {
    return null;
  }

  const normalizedSourceRange = finiteRange(sourceRange);
  const normalizedBarSpacing = Number(barSpacing);
  return {
    anchorSourceTime,
    anchorTime: stableAxisTime(anchorTime),
    axisMode,
    barSpacing: Number.isFinite(normalizedBarSpacing) && normalizedBarSpacing > 0
      ? normalizedBarSpacing
      : null,
    datasetKey,
    logicalSpan: logical.to - logical.from,
    screenOffset: anchorIndex - logical.to,
    sourceRange: normalizedSourceRange,
    surfaceConfigKey,
  };
}

/**
 * Rebuild a snapshot on the current display projection. Returning to the same
 * surface uses the full ordinal identity; a first cross-surface transfer uses
 * stable source time while retaining the old number of visible logical cells.
 */
export function planSurfaceViewportRestore(
  displayRows: readonly DisplayRow[],
  snapshot: SurfaceViewportSnapshot | null | undefined,
  {
  axisMode,
  datasetKey,
  surfaceConfigKey,
  }: {
    axisMode?: unknown;
    datasetKey?: unknown;
    surfaceConfigKey?: unknown;
  } = {},
): { barSpacing: number | null; logicalRange: LogicalRange | null; sameSurface: boolean } | null {
  if (!snapshot || snapshot.datasetKey !== datasetKey) return null;
  const sameSurface = snapshot.surfaceConfigKey === surfaceConfigKey
    && snapshot.axisMode === axisMode;
  const logicalRange = mapSourceViewportAnchorToDisplayLogicalRange(displayRows, {
    anchorTime: sameSurface ? snapshot.anchorTime : snapshot.anchorSourceTime,
    sourceTime: snapshot.anchorSourceTime,
    logicalSpan: snapshot.logicalSpan,
    screenOffset: snapshot.screenOffset,
  });
  return {
    barSpacing: sameSurface ? snapshot.barSpacing : null,
    logicalRange,
    sameSurface,
  };
}

export function rememberSurfaceViewport(
  cache: Map<string, SurfaceViewportSnapshot>,
  snapshot: SurfaceViewportSnapshot | null | undefined,
  {
  limit = SURFACE_VIEWPORT_CACHE_LIMIT,
  }: { limit?: unknown } = {},
): boolean {
  const key = buildSurfaceViewportCacheKey(
    snapshot?.datasetKey,
    snapshot?.surfaceConfigKey,
  );
  if (!(cache instanceof Map) || !key || !snapshot) return false;

  cache.delete(key);
  cache.set(key, snapshot);
  const safeLimit = Math.max(1, Math.floor(Number(limit)) || SURFACE_VIEWPORT_CACHE_LIMIT);
  while (cache.size > safeLimit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return true;
}

export function selectSurfaceViewportSnapshot(
  cache: Map<string, SurfaceViewportSnapshot>,
  {
  datasetKey,
  outgoingSnapshot = null,
  surfaceConfigKey,
  }: {
    datasetKey?: unknown;
    outgoingSnapshot?: SurfaceViewportSnapshot | null;
    surfaceConfigKey?: unknown;
  } = {},
): {
  snapshot: SurfaceViewportSnapshot | null;
  source: "remembered" | "transfer" | "none";
} {
  const key = buildSurfaceViewportCacheKey(datasetKey, surfaceConfigKey);
  const remembered = cache instanceof Map && key ? cache.get(key) : null;
  if (remembered) return { snapshot: remembered, source: "remembered" };
  if (outgoingSnapshot?.datasetKey === datasetKey) {
    return { snapshot: outgoingSnapshot, source: "transfer" };
  }
  return { snapshot: null, source: "none" };
}

/**
 * Explicitly carry a captured viewport across a dataset identity change.
 *
 * Dataset isolation remains the default: a transfer is accepted only when it
 * was captured from the currently-owned outgoing dataset. Callers must opt in
 * at the transition boundary and provide the exact incoming dataset key.
 */
export function transferSurfaceViewportSnapshot(
  snapshot: SurfaceViewportSnapshot | null | undefined,
  {
    fromDatasetKey,
    toDatasetKey,
  }: {
    fromDatasetKey?: unknown;
    toDatasetKey?: unknown;
  } = {},
): SurfaceViewportSnapshot | null {
  if (!snapshot
    || !fromDatasetKey
    || !toDatasetKey
    || fromDatasetKey === toDatasetKey
    || snapshot.datasetKey !== fromDatasetKey) return null;
  return {
    ...snapshot,
    // Axis coordinates are dataset-local (a coarse bucket open or an ordinal
    // order). Cross-dataset restoration must resolve from stable source time.
    anchorTime: snapshot.anchorSourceTime,
    datasetKey: toDatasetKey,
  };
}

/**
 * A cross-dataset transfer must not snap to the nearest edge while the target
 * interval is still publishing or paging the rows around the captured anchor.
 */
export function surfaceViewportHasAnchorCoverage(
  displayRows: readonly DisplayRow[] | null | undefined,
  snapshot: SurfaceViewportSnapshot | null | undefined,
): boolean {
  const anchor = Number(snapshot?.anchorSourceTime);
  if (!displayRows?.length || !Number.isFinite(anchor)) return false;

  for (const row of displayRows) {
    const range = sourceTimeRangeFromDisplayRow(row);
    if (!range) continue;
    if (range.from <= anchor && anchor <= range.to) return true;
  }
  return false;
}
