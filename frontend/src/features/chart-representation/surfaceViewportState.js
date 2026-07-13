import {
  mapSourceViewportAnchorToDisplayLogicalRange,
  sourceTimeFromAxisTime,
  sourceTimeFromDisplayRow,
} from "./axisTime.js";

export const SURFACE_VIEWPORT_CACHE_LIMIT = 32;

function finiteRange(range) {
  const from = Number(range?.from);
  const to = Number(range?.to);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to
    ? { from, to }
    : null;
}

function stableAxisTime(time) {
  return time && typeof time === "object" ? { ...time } : time;
}

export function buildSurfaceViewportCacheKey(datasetKey, surfaceConfigKey) {
  if (!datasetKey || !surfaceConfigKey) return null;
  return JSON.stringify([datasetKey, surfaceConfigKey]);
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
} = {}) {
  const logical = finiteRange(logicalRange);
  if (!logical || !Array.isArray(displayRows) || displayRows.length === 0) return null;

  const lastIndex = displayRows.length - 1;
  const anchorIndex = Math.max(0, Math.min(lastIndex, Math.round(logical.to)));
  const anchorRow = displayRows[anchorIndex];
  const anchorTime = anchorRow?.time;
  const anchorSourceTime = sourceTimeFromAxisTime(anchorTime)
    ?? sourceTimeFromDisplayRow(anchorRow);
  if (anchorTime == null || !Number.isFinite(anchorSourceTime)) return null;

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
export function planSurfaceViewportRestore(displayRows, snapshot, {
  axisMode,
  datasetKey,
  surfaceConfigKey,
} = {}) {
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

export function rememberSurfaceViewport(cache, snapshot, {
  limit = SURFACE_VIEWPORT_CACHE_LIMIT,
} = {}) {
  const key = buildSurfaceViewportCacheKey(
    snapshot?.datasetKey,
    snapshot?.surfaceConfigKey,
  );
  if (!(cache instanceof Map) || !key || !snapshot) return false;

  cache.delete(key);
  cache.set(key, snapshot);
  const safeLimit = Math.max(1, Math.floor(Number(limit)) || SURFACE_VIEWPORT_CACHE_LIMIT);
  while (cache.size > safeLimit) {
    cache.delete(cache.keys().next().value);
  }
  return true;
}

export function selectSurfaceViewportSnapshot(cache, {
  datasetKey,
  outgoingSnapshot = null,
  surfaceConfigKey,
} = {}) {
  const key = buildSurfaceViewportCacheKey(datasetKey, surfaceConfigKey);
  const remembered = cache instanceof Map && key ? cache.get(key) : null;
  if (remembered) return { snapshot: remembered, source: "remembered" };
  if (outgoingSnapshot?.datasetKey === datasetKey) {
    return { snapshot: outgoingSnapshot, source: "transfer" };
  }
  return { snapshot: null, source: "none" };
}
