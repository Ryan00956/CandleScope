import {
  createDrawingCoordinateTransactionContext,
  dataPointToCoordinate,
  getDrawingCoordinateProjectorMode,
  prepareDrawingCoordinateContext,
  projectDrawingCoordinateResolutions,
  projectSourceLineageSpan,
  resolveDrawingDataPointsToCoordinates,
  resolveDrawingSourceAnchors,
  resolveSourceLineageSpan,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateDataPoint,
  CoordinateSeriesBridge,
  DrawingCoordinateResolution,
  DrawingCoordinateContext,
  DrawingSourceLineageSpanResolution,
} from "../../../chart-adapter/coordinateBridge.js";
import { resolveFreehandStrokePoints } from "../freehandStrokeModel.js";
import type {
  FreehandBatchResolveRequest,
  ResolvedFreehandPoint,
} from "../drawingTypes.js";
import { drawingPerfCounters } from "../performance/drawingPerfCounters.js";

export {
  logicalToCoordinateInterpolated,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";
export { dataPointToCoordinate };

export interface DrawingCoordinateCacheOptions {
  cacheToken?: object | null;
  geometryRevision?: number;
}

interface DrawingResolutionCacheEntry {
  coordinateIndex: unknown;
  drawingProjectionConfig: unknown;
  geometryRevision: number;
  inputLength: number;
  resolutions: readonly (DrawingCoordinateResolution | null)[];
  seriesData: unknown;
  sourceTimeHorizon: unknown;
  worldRevisionKey: string | null;
}

interface FreehandSpanResolutionCacheEntry {
  coordinateIndex: unknown;
  drawingProjectionConfig: unknown;
  geometryRevision: number;
  resolutions: Map<number, DrawingSourceLineageSpanResolution | null>;
  seriesData: unknown;
  sourceTimeHorizon: unknown;
  spanCount: number;
  worldRevisionKey: string | null;
}

const drawingResolutionCache = new WeakMap<object, DrawingResolutionCacheEntry>();
const freehandSpanResolutionCache = new WeakMap<object, FreehandSpanResolutionCacheEntry>();

function finiteGeometryRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function cacheMatches(
  entry: DrawingResolutionCacheEntry,
  context: DrawingCoordinateContext,
  inputLength: number,
  geometryRevision: number,
): boolean {
  const snapshot = context.drawingFrameSnapshot;
  const worldRevisionKey = snapshot?.worldRevisionKey ?? null;
  return entry.geometryRevision === geometryRevision
    && entry.inputLength === inputLength
    && entry.worldRevisionKey === worldRevisionKey
    && entry.seriesData === context.seriesData
    && entry.coordinateIndex === context.drawingCoordinateIndex
    && entry.drawingProjectionConfig === context.drawingProjectionConfig
    && entry.sourceTimeHorizon === context.sourceTimeHorizon;
}

function spanCacheMatches(
  entry: FreehandSpanResolutionCacheEntry,
  context: DrawingCoordinateContext,
  spanCount: number,
  geometryRevision: number,
): boolean {
  const snapshot = context.drawingFrameSnapshot;
  return entry.geometryRevision === geometryRevision
    && entry.spanCount === spanCount
    && entry.worldRevisionKey === (snapshot?.worldRevisionKey ?? null)
    && entry.seriesData === context.seriesData
    && entry.coordinateIndex === context.drawingCoordinateIndex
    && entry.drawingProjectionConfig === context.drawingProjectionConfig
    && entry.sourceTimeHorizon === context.sourceTimeHorizon;
}

function sourceResolutionsForPoints(
  points: readonly CoordinateDataPoint[],
  context: DrawingCoordinateContext,
): Array<DrawingCoordinateResolution | null> {
  const sourceResolutions = resolveDrawingSourceAnchors(
    context.seriesData || [],
    points,
    context,
  );
  return points.map((point, index) => {
    if (point.time !== null && point.time !== undefined) {
      return sourceResolutions[index] ?? null;
    }
    return typeof point.logical === "number" && Number.isFinite(point.logical)
      ? { kind: "logical", logical: point.logical }
      : null;
  });
}

/**
 * Resolve canonical anchors once per entity geometry/world revision, then run
 * only the LWC-bound final projection on every viewport revision.
 */
export function drawingDataPointsToCoordinates(
  chart: CoordinateChartBridge,
  series: CoordinateSeriesBridge,
  points: readonly CoordinateDataPoint[],
  context: DrawingCoordinateContext | null = null,
  {
    cacheToken = null,
    geometryRevision = 0,
  }: DrawingCoordinateCacheOptions = {},
): Array<number | null> {
  const prepared = prepareDrawingCoordinateContext(series, context);
  if (getDrawingCoordinateProjectorMode(prepared) !== "batch") {
    return resolveDrawingDataPointsToCoordinates(chart, series, points, prepared);
  }

  const revision = finiteGeometryRevision(geometryRevision);
  const cacheRevision = revision ?? -1;
  const cacheable = cacheToken !== null && revision !== null;
  const cached = cacheable ? drawingResolutionCache.get(cacheToken) : null;
  let resolutions: readonly (DrawingCoordinateResolution | null)[];
  if (cached && cacheMatches(cached, prepared, points.length, cacheRevision)) {
    resolutions = cached.resolutions;
  } else {
    resolutions = Object.freeze(sourceResolutionsForPoints(points, prepared));
    if (points.length > 0) drawingPerfCounters.recordAnchorResolve(points.length);
    if (cacheable) {
      drawingResolutionCache.set(cacheToken, {
        coordinateIndex: prepared.drawingCoordinateIndex,
        drawingProjectionConfig: prepared.drawingProjectionConfig,
        geometryRevision: cacheRevision,
        inputLength: points.length,
        resolutions,
        seriesData: prepared.seriesData,
        sourceTimeHorizon: prepared.sourceTimeHorizon,
        worldRevisionKey: prepared.drawingFrameSnapshot?.worldRevisionKey ?? null,
      });
    }
  }

  let timeScale = null;
  try {
    timeScale = chart.timeScale();
  } catch {
    timeScale = null;
  }
  return projectDrawingCoordinateResolutions(timeScale, resolutions, prepared);
}

function drawingPointFromFreehandRequest(
  request: FreehandBatchResolveRequest,
  sourceProjection: string,
  sourceProjectionConfig: string,
): CoordinateDataPoint {
  return request.kind === "time"
    ? { time: request.time }
    : {
        ...request.anchor,
        sourceProjection,
        sourceProjectionConfig,
      };
}

export function freehandStrokeToCoordinates(
  chart: CoordinateChartBridge,
  series: CoordinateSeriesBridge,
  stroke: unknown,
  context: DrawingCoordinateContext | null = null,
  cacheOptions: DrawingCoordinateCacheOptions = {},
): Array<ResolvedFreehandPoint | null> {
  const coordinateContext = createDrawingCoordinateTransactionContext(context);
  prepareDrawingCoordinateContext(series, coordinateContext);
  const projectorMode = getDrawingCoordinateProjectorMode(coordinateContext);
  const cacheToken = cacheOptions.cacheToken ?? null;
  const cacheRevision = finiteGeometryRevision(cacheOptions.geometryRevision ?? 0);
  const spanCacheable = projectorMode !== "scalar"
    && cacheToken !== null
    && cacheRevision !== null;
  let spanCache = spanCacheable ? freehandSpanResolutionCache.get(cacheToken) ?? null : null;
  let timeScale = null;
  try {
    timeScale = chart.timeScale();
  } catch {
    timeScale = null;
  }
  const resolved = resolveFreehandStrokePoints(stroke, {
    ...(projectorMode === "scalar" ? {} : {
      resolveBatch: (requests, normalizedStroke) => drawingDataPointsToCoordinates(
        chart,
        series,
        requests.map((request) => drawingPointFromFreehandRequest(
          request,
          normalizedStroke.sourceProjection,
          normalizedStroke.sourceProjectionConfig,
        )),
        coordinateContext,
        cacheOptions,
      ),
    }),
    resolveAnchor: (anchor, _index, _point, normalizedStroke) => dataPointToCoordinate(
      chart,
      series,
      {
        ...anchor,
        sourceProjection: normalizedStroke.sourceProjection,
        sourceProjectionConfig: normalizedStroke.sourceProjectionConfig,
      },
      coordinateContext,
    ),
    resolveSpan: (span, index, normalizedStroke) => {
      const spanInput = {
        ...span,
        sourceProjection: normalizedStroke.sourceProjection,
        sourceProjectionConfig: normalizedStroke.sourceProjectionConfig,
      };
      let sourceResolution: DrawingSourceLineageSpanResolution | null;
      if (!spanCacheable || cacheRevision === null || cacheToken === null) {
        sourceResolution = resolveSourceLineageSpan(series, spanInput, coordinateContext);
      } else {
        if (!spanCache || !spanCacheMatches(
          spanCache,
          coordinateContext,
          normalizedStroke.spans.length,
          cacheRevision,
        )) {
          spanCache = {
            coordinateIndex: coordinateContext.drawingCoordinateIndex,
            drawingProjectionConfig: coordinateContext.drawingProjectionConfig,
            geometryRevision: cacheRevision,
            resolutions: new Map(),
            seriesData: coordinateContext.seriesData,
            sourceTimeHorizon: coordinateContext.sourceTimeHorizon,
            spanCount: normalizedStroke.spans.length,
            worldRevisionKey: coordinateContext.drawingFrameSnapshot?.worldRevisionKey ?? null,
          };
          freehandSpanResolutionCache.set(cacheToken, spanCache);
        }
        if (!spanCache.resolutions.has(index)) {
          spanCache.resolutions.set(
            index,
            resolveSourceLineageSpan(series, spanInput, coordinateContext),
          );
        }
        sourceResolution = spanCache.resolutions.get(index) ?? null;
      }
      return projectSourceLineageSpan(timeScale, sourceResolution, coordinateContext);
    },
    resolveTime: (time) => dataPointToCoordinate(
      chart,
      series,
      { time },
      coordinateContext,
    ),
  });
  if (projectorMode === "scalar" && resolved.length > 0) {
    drawingPerfCounters.recordAnchorResolve(resolved.length);
  }
  return resolved;
}

// Keep the narrow export for callers compiled against the v2-only bridge.
export const freehandStrokeV2ToCoordinates = freehandStrokeToCoordinates;
