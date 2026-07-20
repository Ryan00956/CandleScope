import {
  captureSourceLineageFreehandStrokeBatch,
  dataPointToCoordinate as resolveDataPointCoordinate,
  drawingAnchorFromCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  projectSourceLineageSpanWithMode,
  projectDrawingCoordinateResolutions,
  registerDrawingSeriesContext,
  resolveDrawingSourceAnchors,
  resolveSourceLineageSpan,
  timeToCoordinateInterpolated,
} from "./coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateDataPoint,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
  DrawingCoordinateResolution,
  DrawingSourceLineageSpanProjection,
  DrawingSourceLineageSpanResolution,
  DrawingSeriesProviders,
  ScreenPoint,
  SourceLineageSpanInput,
} from "./coordinateBridge.js";
import {
  drawingFrameRevisionsEqual,
  isDrawingFrameSnapshot,
} from "./drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "./drawingFrameSnapshot.js";
import {
  subscribeSharedDrawingFrameInvalidation,
} from "./drawingFrameInvalidationHub.js";

export type DrawingFrameInvalidationReason = "manual" | "viewport";
import type { DrawingLineageIndex } from "../features/chart-representation/drawingLineageIndex.js";
import type { DisplayRow } from "../features/chart-representation/chartRepresentationTypes.js";
import type { MainSeriesHandle } from "./chartAdapterTypes.js";

interface RefLike<T> {
  current: T | null;
}

type RefOrValue<T> = RefLike<T> | T | null | undefined;

interface AdapterTimeScale {
  coordinateToLogical(coordinate: number): number | null;
  coordinateToTime(coordinate: number): unknown;
  getVisibleLogicalRange(): { from: number; to: number } | null;
  getVisibleRange(): { from: unknown; to: unknown } | null;
  logicalToCoordinate(logical: number): number | null;
  options(): { barSpacing: number };
  scrollPosition(): number;
  setVisibleLogicalRange(range: unknown): void;
  setVisibleRange(range: unknown): void;
  subscribeSizeChange?(handler: (width: number, height: number) => void): void;
  subscribeVisibleLogicalRangeChange?(
    handler: (range: { from: number; to: number } | null) => void,
  ): void;
  timeToCoordinate(time: unknown): number | null;
  unsubscribeSizeChange?(handler: (width: number, height: number) => void): void;
  unsubscribeVisibleLogicalRangeChange?(
    handler: (range: { from: number; to: number } | null) => void,
  ): void;
  width?(): number;
}

interface AdapterChart extends CoordinateChartBridge {
  paneSize(paneIndex?: number): { width: number; height: number };
  priceScale(priceScaleId: string, paneIndex?: number): { width(): number };
  timeScale(): AdapterTimeScale;
  subscribeCrosshairMove(handler: CrosshairHandler): void;
  unsubscribeCrosshairMove(handler: CrosshairHandler): void;
}

type AdapterSeries = MainSeriesHandle;
type AdapterPrimitive = Parameters<AdapterSeries["attachPrimitive"]>[0] & {
  _series?: AdapterSeries | null;
};

interface LookupMap {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
}

interface LightweightChartAdapterOptions {
  chartRef: RefOrValue<AdapterChart>;
  seriesRef: RefOrValue<AdapterSeries>;
  containerRef?: RefOrValue<HTMLElement>;
  drawingPaneIndexRef?: RefOrValue<number>;
  /** @deprecated Use drawingPaneIndexRef for pane-scoped drawing adapters. */
  mainPaneIndexRef?: RefOrValue<number>;
  seriesDataRef?: RefOrValue<DisplayRow[]>;
  seriesDataMapRef?: RefOrValue<LookupMap>;
  seriesDataIndexRef?: RefOrValue<LookupMap>;
  sourceTimeHorizonRef?: RefOrValue<unknown>;
  sourceIntervalRef?: RefOrValue<unknown>;
  sourceIntervalSecondsRef?: RefOrValue<unknown>;
  projectionConfigRef?: RefOrValue<unknown>;
  ordinalSeriesIndexProvider?: (() => DrawingLineageIndex | null) | null;
  drawingCoordinateSnapshotProvider?: (() => DrawingFrameSnapshot | null) | null;
}

interface FreehandCaptureIdentityRecord {
  identity: Readonly<Record<string, never>>;
  series: AdapterSeries;
  sourceProjection: string;
  sourceProjectionConfig: string;
}

interface DrawingFrameProjectionSessionState {
  readonly context: DrawingCoordinateContext;
  readonly invalidationEpoch: number;
  /**
   * Viewport projection is pure for one atomic frame. Multiple canonical
   * strokes may share the same immutable world-lineage resolution, so retain
   * its public time-scale projection only for this synchronous scene build.
   * The WeakMap is released with the session and cannot retain documents or
   * grow across viewport revisions.
   */
  readonly lineageProjectionCache: WeakMap<
    DrawingSourceLineageSpanResolution,
    Readonly<{
      coordinates: Readonly<{ left: number; right: number }> | null;
      mode: DrawingSourceLineageSpanProjection["mode"] | null;
    }>
  >;
  readonly lineageStats: {
    exactProjectionCount: number;
    fallbackProjectionCount: number;
    unresolvedProjectionCount: number;
  };
  readonly series: AdapterSeries;
  readonly snapshot: DrawingFrameSnapshot;
  readonly timeScale: AdapterTimeScale;
}

interface VisibleRangeSnapshot {
  logical?: { from: number; to: number } | null;
  time?: { from: unknown; to: unknown } | null;
  barSpacing?: number;
  scrollPosition?: number;
}

interface DrawingTextMeasureRequest {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly fontWeight?: number | "normal" | "bold";
}

export interface MainPanePlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

type CrosshairHandler = (event: unknown) => void;

let drawingTextMeasureContext: CanvasRenderingContext2D | null | undefined;

function measureDrawingText(
  request: DrawingTextMeasureRequest,
): Readonly<{ width: number }> | null {
  if (typeof document === "undefined"
    || typeof request.text !== "string"
    || typeof request.fontFamily !== "string"
    || request.fontFamily.length === 0
    || !Number.isFinite(request.fontSize)
    || request.fontSize <= 0) return null;
  if (drawingTextMeasureContext === undefined) {
    drawingTextMeasureContext = document.createElement("canvas").getContext("2d");
  }
  const context = drawingTextMeasureContext;
  if (!context) return null;
  const weight = request.fontWeight ?? (request.bold ? "bold" : "normal");
  context.font = `${request.italic ? "italic " : ""}${weight} ${request.fontSize}px ${request.fontFamily}`;
  const width = context.measureText(request.text).width;
  return Number.isFinite(width) && width >= 0 ? Object.freeze({ width }) : null;
}

function getRefValue<T>(refOrValue: RefOrValue<T>): T | null | undefined {
  return refOrValue && typeof refOrValue === "object" && "current" in refOrValue
    ? refOrValue.current
    : refOrValue;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDisplayRow(value: unknown): value is DisplayRow {
  if (!isRecord(value)) return false;
  const time = value.time;
  return (typeof time === "number" && Number.isFinite(time)) || isOrdinalAxisTime(time);
}

function isDisplayRowArray(value: unknown): value is DisplayRow[] {
  if (!Array.isArray(value)) return false;
  const rows: unknown[] = value;
  return rows.every(isDisplayRow);
}

function currentDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio;
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function snapshotLineageRevision(
  snapshot: DrawingFrameSnapshot | null | undefined,
): number | null {
  if (!snapshot) return null;
  if (Number.isSafeInteger(snapshot.lineageIndexRevision)) {
    return snapshot.lineageIndexRevision;
  }
  // Transitional compatibility for adapter tests and embedders compiled
  // against the pre-Phase-1 atomic projection snapshot.
  const legacyRevision = (snapshot as unknown as { indexRevision?: unknown }).indexRevision;
  return Number.isSafeInteger(legacyRevision) ? Number(legacyRevision) : null;
}

function usesOrdinalData(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  for (const row of data) {
    if (isDisplayRow(row) && row.time != null) return isOrdinalAxisTime(row.time);
  }
  return false;
}

export function createLightweightChartAdapter({
  chartRef,
  seriesRef,
  containerRef = null,
  drawingPaneIndexRef = null,
  mainPaneIndexRef = null,
  seriesDataRef = null,
  seriesDataMapRef = null,
  seriesDataIndexRef = null,
  sourceTimeHorizonRef = null,
  sourceIntervalRef = null,
  sourceIntervalSecondsRef = null,
  projectionConfigRef = null,
  ordinalSeriesIndexProvider = null,
  drawingCoordinateSnapshotProvider = null,
}: LightweightChartAdapterOptions) {
  const getChart = () => getRefValue(chartRef);
  const getSeries = () => getRefValue(seriesRef);
  const getDrawingPaneIndex = () => {
    const drawingPaneIndex = getRefValue(drawingPaneIndexRef);
    const value = drawingPaneIndex ?? getRefValue(mainPaneIndexRef);
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  };
  let drawingPaneGeometryCache: Readonly<{
    container: HTMLElement | null;
    offsetY: number;
    paneElement: HTMLElement | null;
    valid: boolean;
  }> = Object.freeze({
    container: null,
    offsetY: 0,
    paneElement: null,
    valid: false,
  });
  const getDrawingPaneElement = (): HTMLElement | null => (
    getSeries()?.getPane?.()?.getHTMLElement?.() ?? null
  ) as HTMLElement | null;
  const refreshDrawingPaneGeometry = (
    container: HTMLElement | null = getRefValue(containerRef) ?? null,
    paneElement?: HTMLElement | null,
  ): number => {
    const resolvedPaneElement = container
      ? paneElement === undefined ? getDrawingPaneElement() : paneElement
      : null;
    const containerRect = container?.getBoundingClientRect?.() ?? null;
    const paneRect = resolvedPaneElement?.getBoundingClientRect?.() ?? null;
    const rawOffset = containerRect && paneRect ? paneRect.top - containerRect.top : 0;
    const offsetY = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    drawingPaneGeometryCache = Object.freeze({
      container,
      offsetY,
      paneElement: resolvedPaneElement,
      valid: true,
    });
    return offsetY;
  };
  const getDrawingPaneOffsetY = (): number => {
    const container = getRefValue(containerRef) ?? null;
    if (!container) {
      if (!drawingPaneGeometryCache.valid
        || drawingPaneGeometryCache.container !== null
        || drawingPaneGeometryCache.paneElement !== null) {
        return refreshDrawingPaneGeometry(null, null);
      }
      return 0;
    }
    const paneElement = getDrawingPaneElement();
    if (!drawingPaneGeometryCache.valid
      || drawingPaneGeometryCache.container !== container
      || drawingPaneGeometryCache.paneElement !== paneElement) {
      return refreshDrawingPaneGeometry(container, paneElement);
    }
    return drawingPaneGeometryCache.offsetY;
  };
  const getSeriesData = (): DisplayRow[] => {
    const data = getRefValue(seriesDataRef);
    if (data) return data;
    const fallbackData: unknown = safeCall(() => getSeries()?.data?.() || [], []);
    return isDisplayRowArray(fallbackData) ? fallbackData : [];
  };
  const getSeriesDataForSeries = (series: AdapterSeries): DisplayRow[] => {
    const data = getRefValue(seriesDataRef);
    if (data) return data;
    const fallbackData: unknown = safeCall(() => series.data?.() || [], []);
    return isDisplayRowArray(fallbackData) ? fallbackData : [];
  };
  const getSeriesDataMap = () => getRefValue(seriesDataMapRef);
  const getSeriesDataIndex = () => getRefValue(seriesDataIndexRef);
  const getSourceTimeHorizon = () => getRefValue(sourceTimeHorizonRef);
  const getSourceInterval = () => getRefValue(sourceIntervalRef);
  const getSourceIntervalSeconds = () => getRefValue(sourceIntervalSecondsRef);
  const getProjectionConfig = () => getRefValue(projectionConfigRef);
  const getOrdinalSeriesIndex = () => safeCall(
    () => ordinalSeriesIndexProvider?.(),
    null,
  );
  const getDrawingCoordinateSnapshot = () => safeCall(
    () => drawingCoordinateSnapshotProvider?.(),
    null,
  );
  const drawingSeriesProviders: DrawingSeriesProviders = {
    coordinateSnapshotProvider: getDrawingCoordinateSnapshot,
    ordinalSeriesIndexProvider: getOrdinalSeriesIndex,
    projectionConfigProvider: getProjectionConfig,
    seriesDataProvider: getSeriesData,
    sourceTimeHorizonProvider: getSourceTimeHorizon,
    sourceIntervalProvider: getSourceInterval,
    sourceIntervalSecondsProvider: getSourceIntervalSeconds,
  };
  const registerCurrentDrawingSeries = () => {
    const series = getSeries();
    if (series) registerDrawingSeriesContext(series, drawingSeriesProviders);
    return series;
  };
  const createDrawingCoordinateContext = (): DrawingCoordinateContext => {
    const snapshot = getDrawingCoordinateSnapshot();
    const snapshotData = snapshot?.seriesData ?? null;
    const hasSnapshotData = snapshotData !== null;
    const hasSnapshotHorizon = snapshot != null
      && Object.prototype.hasOwnProperty.call(snapshot, "sourceTimeHorizon");
    const hasSnapshotInterval = snapshot != null
      && Object.prototype.hasOwnProperty.call(snapshot, "sourceIntervalSeconds");
    const hasSnapshotIntervalId = snapshot != null
      && Object.prototype.hasOwnProperty.call(snapshot, "sourceInterval");
    const hasSnapshotProjectionConfig = snapshot != null
      && Object.prototype.hasOwnProperty.call(snapshot, "drawingProjectionConfig");
    return {
      drawingOrdinalSeriesIndex: hasSnapshotData
        ? snapshot?.ordinalSeriesIndex ?? null
        : getOrdinalSeriesIndex() ?? null,
      ...(hasSnapshotData
        ? { drawingOrdinalSeriesIndexRevision: snapshotLineageRevision(snapshot) }
        : {}),
      drawingProjectionConfig: hasSnapshotProjectionConfig
        ? snapshot.drawingProjectionConfig
        : getProjectionConfig(),
      seriesData: snapshotData ?? getSeriesData(),
      sourceInterval: hasSnapshotIntervalId
        ? snapshot.sourceInterval
        : getSourceInterval(),
      sourceIntervalSeconds: hasSnapshotInterval
        ? snapshot.sourceIntervalSeconds
        : getSourceIntervalSeconds(),
      sourceTimeHorizon: hasSnapshotHorizon
        ? snapshot.sourceTimeHorizon
        : getSourceTimeHorizon(),
      ...(isDrawingFrameSnapshot(snapshot) ? { drawingFrameSnapshot: snapshot } : {}),
    };
  };
  const createDrawingFrameCoordinateContext = (
    snapshot: DrawingFrameSnapshot,
  ): DrawingCoordinateContext => ({
    drawingCoordinateIndex: snapshot.coordinateIndex,
    drawingFrameSnapshot: snapshot,
    drawingOrdinalSeriesIndex: snapshot.ordinalSeriesIndex,
    drawingOrdinalSeriesIndexRevision: snapshot.lineageIndexRevision,
    drawingProjectionConfig: snapshot.drawingProjectionConfig,
    seriesData: snapshot.seriesData,
    sourceInterval: snapshot.sourceInterval,
    sourceIntervalSeconds: snapshot.sourceIntervalSeconds,
    sourceTimeHorizon: snapshot.sourceTimeHorizon,
  });
  const drawingLineageSpanWorldCache = new WeakMap<
    object,
    WeakMap<object, Map<string, DrawingSourceLineageSpanResolution | null>>
  >();
  let drawingLineageExactProjectionCount = 0;
  let drawingLineageFallbackProjectionCount = 0;
  let drawingLineageUnresolvedProjectionCount = 0;
  const resolveDrawingFrameSourceLineageSpan = (
    snapshot: DrawingFrameSnapshot,
    series: AdapterSeries,
    span: SourceLineageSpanInput,
    context: DrawingCoordinateContext,
  ): DrawingSourceLineageSpanResolution | null => {
    const exactIdentity = span.exact;
    const fallbackIdentity = span.fallback;
    if (!exactIdentity || typeof exactIdentity !== "object"
      || !fallbackIdentity || typeof fallbackIdentity !== "object") {
      return resolveSourceLineageSpan(series, span, context);
    }
    let byFallback = drawingLineageSpanWorldCache.get(exactIdentity);
    if (!byFallback) {
      byFallback = new WeakMap();
      drawingLineageSpanWorldCache.set(exactIdentity, byFallback);
    }
    let entries = byFallback.get(fallbackIdentity);
    if (!entries) {
      entries = new Map();
      byFallback.set(fallbackIdentity, entries);
    }
    const key = JSON.stringify([
      snapshot.worldRevisionKey,
      span.sourceProjection ?? null,
      span.sourceProjectionConfig ?? null,
    ]);
    if (entries.has(key)) {
      const cached = entries.get(key) ?? null;
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const resolved = resolveSourceLineageSpan(series, span, context);
    entries.set(key, resolved);
    while (entries.size > 4) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return resolved;
  };
  const drawingFrameSeriesOwners = new WeakMap<DrawingFrameSnapshot, AdapterSeries>();
  const drawingFrameInvalidationListeners = new Set<(
    reason?: DrawingFrameInvalidationReason,
  ) => void>();
  let unsubscribeSharedFrameInvalidation: (() => void) | null = null;
  let drawingFrameInvalidationEpoch = 0;
  const advanceDrawingFrameInvalidationEpoch = (): void => {
    drawingFrameInvalidationEpoch = drawingFrameInvalidationEpoch >= Number.MAX_SAFE_INTEGER
      ? 0
      : drawingFrameInvalidationEpoch + 1;
  };
  const emitDrawingFrameInvalidation = (
    reason: DrawingFrameInvalidationReason = "manual",
    refreshPaneGeometry = reason === "manual",
  ) => {
    if (refreshPaneGeometry) refreshDrawingPaneGeometry();
    advanceDrawingFrameInvalidationEpoch();
    for (const listener of drawingFrameInvalidationListeners) {
      safeCall(() => listener(reason), undefined);
    }
  };
  const captureDrawingFrame = (): DrawingFrameSnapshot | null => {
    const chart = getChart();
    const series = getSeries();
    const snapshot = getDrawingCoordinateSnapshot();
    if (!chart || !series || !isDrawingFrameSnapshot(snapshot)) return null;
    const existingOwner = drawingFrameSeriesOwners.get(snapshot);
    if (existingOwner && existingOwner !== series) return null;
    drawingFrameSeriesOwners.set(snapshot, series);
    return snapshot;
  };
  const isDrawingFrameCurrent = (snapshot: DrawingFrameSnapshot): boolean => {
    if (!isDrawingFrameSnapshot(snapshot)) return false;
    const chart = getChart();
    const series = getSeries();
    if (!chart || !series || drawingFrameSeriesOwners.get(snapshot) !== series) return false;
    const current = getDrawingCoordinateSnapshot();
    return current === snapshot
      && drawingFrameRevisionsEqual(snapshot, current)
      && current.surfaceGeneration === snapshot.surfaceGeneration;
  };
  let activeDrawingFrameProjectionSession: DrawingFrameProjectionSessionState | null = null;
  const runDrawingFrameProjectionSession = <T>(
    snapshot: DrawingFrameSnapshot,
    work: () => T | null,
  ): T | null => {
    if (activeDrawingFrameProjectionSession
      || typeof work !== "function"
      || !isDrawingFrameCurrent(snapshot)) return null;
    const chart = getChart();
    const series = getSeries();
    if (!chart || !series || drawingFrameSeriesOwners.get(snapshot) !== series) return null;
    const timeScale = safeCall(() => chart.timeScale(), null);
    if (!timeScale) return null;
    const session = Object.freeze({
      context: createDrawingFrameCoordinateContext(snapshot),
      invalidationEpoch: drawingFrameInvalidationEpoch,
      lineageProjectionCache: new WeakMap(),
      lineageStats: {
        exactProjectionCount: 0,
        fallbackProjectionCount: 0,
        unresolvedProjectionCount: 0,
      },
      series,
      snapshot,
      timeScale,
    });
    activeDrawingFrameProjectionSession = session;
    let result: T | null;
    try {
      result = work();
    } finally {
      activeDrawingFrameProjectionSession = null;
    }
    const frameCurrent = isDrawingFrameCurrent(snapshot);
    if (session.invalidationEpoch !== drawingFrameInvalidationEpoch || !frameCurrent) return null;
    drawingLineageExactProjectionCount += session.lineageStats.exactProjectionCount;
    drawingLineageFallbackProjectionCount += session.lineageStats.fallbackProjectionCount;
    drawingLineageUnresolvedProjectionCount += session.lineageStats.unresolvedProjectionCount;
    return result;
  };
  const projectionSessionFor = (
    snapshot: DrawingFrameSnapshot,
  ): DrawingFrameProjectionSessionState | null => (
    activeDrawingFrameProjectionSession?.snapshot === snapshot
      ? activeDrawingFrameProjectionSession
      : null
  );
  let lastFreehandCaptureIdentity: FreehandCaptureIdentityRecord | null = null;
  const captureIdentityFor = (
    series: AdapterSeries,
    sourceProjection: string,
    sourceProjectionConfig: string,
  ): Readonly<Record<string, never>> => {
    if (lastFreehandCaptureIdentity?.series === series
      && lastFreehandCaptureIdentity.sourceProjection === sourceProjection
      && lastFreehandCaptureIdentity.sourceProjectionConfig === sourceProjectionConfig) {
      return lastFreehandCaptureIdentity.identity;
    }
    const identity: Record<string, never> = {};
    Object.defineProperties(identity, {
      series: { value: series },
      sourceProjection: { value: sourceProjection },
      sourceProjectionConfig: { value: sourceProjectionConfig },
    });
    Object.freeze(identity);
    lastFreehandCaptureIdentity = {
      identity,
      series,
      sourceProjection,
      sourceProjectionConfig,
    };
    return identity;
  };
  const resolveDrawingFrameDataPoints = (
    snapshot: DrawingFrameSnapshot,
    dataPoints: readonly CoordinateDataPoint[],
  ): readonly (DrawingCoordinateResolution | null)[] | null => safeCall(() => {
    const session = projectionSessionFor(snapshot);
    if ((!session && activeDrawingFrameProjectionSession)
      || (!session && !isDrawingFrameCurrent(snapshot))) return null;
    const context = session?.context ?? createDrawingFrameCoordinateContext(snapshot);
    const sourceResolutions = resolveDrawingSourceAnchors(
      snapshot.seriesData,
      dataPoints,
      context,
    );
    if (sourceResolutions.length !== dataPoints.length) return null;
    const resolutions = dataPoints.map((point, index): DrawingCoordinateResolution | null => {
      if (point.time !== null && point.time !== undefined) {
        return sourceResolutions[index] ?? null;
      }
      return typeof point.logical === "number" && Number.isFinite(point.logical)
        ? Object.freeze({ kind: "logical" as const, logical: point.logical })
        : null;
    });
    return session || isDrawingFrameCurrent(snapshot) ? Object.freeze(resolutions) : null;
  }, null);
  const projectDrawingFrameResolvedDataPoints = (
    snapshot: DrawingFrameSnapshot,
    resolutions: readonly (DrawingCoordinateResolution | null)[],
    dataPoints: readonly CoordinateDataPoint[],
  ): Float64Array | null => safeCall(() => {
    const session = projectionSessionFor(snapshot);
    if (resolutions.length !== dataPoints.length
      || (!session && activeDrawingFrameProjectionSession)
      || (!session && !isDrawingFrameCurrent(snapshot))) return null;
    const chart = session ? null : getChart();
    const series = session?.series ?? getSeries();
    const timeScale = session?.timeScale ?? chart?.timeScale();
    if (!series || !timeScale) return null;
    const xCoordinates = projectDrawingCoordinateResolutions(
      timeScale,
      resolutions,
      session?.context ?? createDrawingFrameCoordinateContext(snapshot),
    );
    if (xCoordinates.length !== dataPoints.length) return null;
    const coordinates = new Float64Array(dataPoints.length * 2);
    coordinates.fill(Number.NaN);
    for (let index = 0; index < dataPoints.length; index += 1) {
      const point = dataPoints[index];
      const x = xCoordinates[index];
      const price = point?.price;
      const coordinateIndex = index * 2;
      // Preserve each independently resolvable axis. Cross/axis drawings
      // intentionally render one axis even when the other is unresolved.
      if (typeof x === "number" && Number.isFinite(x)) coordinates[coordinateIndex] = x;
      if (typeof price === "number" && Number.isFinite(price)) {
        const y = series.priceToCoordinate(price);
        if (typeof y === "number" && Number.isFinite(y)) coordinates[coordinateIndex + 1] = y;
      }
    }
    return session || isDrawingFrameCurrent(snapshot) ? coordinates : null;
  }, null);

  return {
    isReady: () => !!(getChart() && getSeries()),
    hasSeries: () => !!getSeries(),
    usesOrdinalTime: () => usesOrdinalData(getSeriesData()),
    getMainSeries: getSeries,
    getSeriesData,
    captureDrawingFrame,
    isDrawingFrameCurrent,
    runDrawingFrameProjectionSession,
    resolveDrawingFrameDataPoints,
    projectDrawingFrameResolvedDataPoints,
    projectDrawingFrameDataPoints: (
      snapshot: DrawingFrameSnapshot,
      dataPoints: readonly CoordinateDataPoint[],
    ): Float64Array | null => safeCall(() => {
      const resolutions = resolveDrawingFrameDataPoints(snapshot, dataPoints);
      return resolutions
        ? projectDrawingFrameResolvedDataPoints(snapshot, resolutions, dataPoints)
        : null;
    }, null),
    projectDrawingFrameSourceLineageSpan: (
      snapshot: DrawingFrameSnapshot,
      span: SourceLineageSpanInput,
    ): Readonly<{ left: number; right: number }> | null => safeCall(() => {
      const session = projectionSessionFor(snapshot);
      if ((!session && activeDrawingFrameProjectionSession)
        || (!session && !isDrawingFrameCurrent(snapshot))) return null;
      const chart = session ? null : getChart();
      const series = session?.series ?? getSeries();
      const timeScale = session?.timeScale ?? chart?.timeScale();
      if (!series || !timeScale) return null;
      const context = session?.context ?? createDrawingFrameCoordinateContext(snapshot);
      const resolution = resolveDrawingFrameSourceLineageSpan(
        snapshot,
        series,
        span,
        context,
      );
      const cachedProjection = session && resolution
        ? session.lineageProjectionCache.get(resolution)
        : undefined;
      let coordinates = cachedProjection?.coordinates;
      let mode = cachedProjection?.mode;
      if (cachedProjection === undefined) {
        const projected = projectSourceLineageSpanWithMode(
          timeScale,
          resolution,
          context,
        );
        if (!projected
          || !Number.isFinite(projected.left)
          || !Number.isFinite(projected.right)
          || projected.left >= projected.right) {
          coordinates = null;
          mode = null;
        } else {
          coordinates = Object.freeze({ left: projected.left, right: projected.right });
          mode = projected.mode;
        }
        if (session && resolution) {
          session.lineageProjectionCache.set(resolution, Object.freeze({ coordinates, mode }));
        }
      }
      if (!coordinates || mode === null || mode === undefined) {
        if (session) session.lineageStats.unresolvedProjectionCount += 1;
        else drawingLineageUnresolvedProjectionCount += 1;
        return null;
      }
      if (!session && !isDrawingFrameCurrent(snapshot)) return null;
      if (mode === "exact") {
        if (session) session.lineageStats.exactProjectionCount += 1;
        else drawingLineageExactProjectionCount += 1;
      } else if (session) session.lineageStats.fallbackProjectionCount += 1;
      else drawingLineageFallbackProjectionCount += 1;
      return coordinates;
    }, null),
    readDrawingFrameSourceLineageStats: () => Object.freeze({
      exactProjectionCount: drawingLineageExactProjectionCount,
      fallbackProjectionCount: drawingLineageFallbackProjectionCount,
      unresolvedProjectionCount: drawingLineageUnresolvedProjectionCount,
    }),
    subscribeDrawingFrameInvalidation: (
      listener: (reason?: DrawingFrameInvalidationReason) => void,
    ) => {
      if (typeof listener !== "function") return () => {};
      drawingFrameInvalidationListeners.add(listener);
      if (drawingFrameInvalidationListeners.size === 1) {
        const timeScale = safeCall(() => getChart()?.timeScale(), null);
        unsubscribeSharedFrameInvalidation = subscribeSharedDrawingFrameInvalidation(
          timeScale,
          (source) => {
            // Horizontal viewport churn cannot move a pane relative to its
            // container. Refresh DOM geometry only for a real size change;
            // coordinate conversion then stays layout-read-free for the full
            // wheel/pan frame.
            emitDrawingFrameInvalidation("viewport", source === "size");
          },
        );
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        drawingFrameInvalidationListeners.delete(listener);
        if (drawingFrameInvalidationListeners.size > 0) return;
        unsubscribeSharedFrameInvalidation?.();
        unsubscribeSharedFrameInvalidation = null;
      };
    },
    notifyDrawingFrameInvalidation: emitDrawingFrameInvalidation,
    // Exact browser font metrics are required for shadow parity with the last
    // legacy paint. This detached canvas never becomes a visible scene owner.
    measureText: measureDrawingText,
    captureFreehandStrokeBatch: (screenPoints: ScreenPoint[]) => safeCall(() => {
      const chart = getChart();
      const series = getSeries();
      if (!chart || !series) return null;

      // Read every mutable provider once, then keep the complete coalesced
      // pointer batch on that immutable local snapshot.
      const snapshot = getDrawingCoordinateSnapshot();
      const hasSnapshotProjectionConfig = snapshot != null
        && Object.prototype.hasOwnProperty.call(snapshot, "drawingProjectionConfig");
      const projectionConfig = hasSnapshotProjectionConfig
        ? snapshot.drawingProjectionConfig
        : getProjectionConfig();
      const hasSnapshotIntervalId = snapshot != null
        && Object.prototype.hasOwnProperty.call(snapshot, "sourceInterval");
      const sourceInterval = hasSnapshotIntervalId
        ? snapshot.sourceInterval
        : getSourceInterval();
      const hasSnapshotInterval = snapshot != null
        && Object.prototype.hasOwnProperty.call(snapshot, "sourceIntervalSeconds");
      const sourceIntervalSeconds = hasSnapshotInterval
        ? snapshot.sourceIntervalSeconds
        : getSourceIntervalSeconds();
      const hasSnapshotHorizon = snapshot != null
        && Object.prototype.hasOwnProperty.call(snapshot, "sourceTimeHorizon");
      const sourceTimeHorizon = hasSnapshotHorizon
        ? snapshot.sourceTimeHorizon
        : getSourceTimeHorizon();
      const hasSnapshotProvider = typeof drawingCoordinateSnapshotProvider === "function";
      const snapshotSeriesData = snapshot?.seriesData ?? null;
      if (hasSnapshotProvider && snapshotSeriesData === null) return null;

      const seriesData = hasSnapshotProvider && snapshotSeriesData
        ? snapshotSeriesData
        : getSeriesDataForSeries(series);
      const ordinalSeriesIndex = hasSnapshotProvider && snapshot
        ? snapshot.ordinalSeriesIndex
        : getOrdinalSeriesIndex();
      const context: DrawingCoordinateContext = {
        drawingProjectionConfig: projectionConfig,
        seriesData,
        sourceInterval,
        sourceIntervalSeconds,
        sourceTimeHorizon,
      };
      if (hasSnapshotProvider || typeof ordinalSeriesIndexProvider === "function") {
        context.drawingOrdinalSeriesIndex = ordinalSeriesIndex ?? null;
        context.drawingOrdinalSeriesIndexRevision = hasSnapshotProvider && snapshot
          ? snapshotLineageRevision(snapshot)
          : ordinalSeriesIndex?.revision ?? null;
        if (isDrawingFrameSnapshot(snapshot)) context.drawingFrameSnapshot = snapshot;
      }
      const paneOffsetY = getDrawingPaneOffsetY();
      const paneLocalPoints = paneOffsetY === 0
        ? screenPoints
        : screenPoints.map((point) => ({
            x: point.x,
            y: typeof point.y === "number" ? point.y - paneOffsetY : point.y,
          }));
      const batch = captureSourceLineageFreehandStrokeBatch(
        chart,
        series,
        paneLocalPoints,
        context,
      );
      if (!batch) return null;
      return Object.freeze({
        captureIdentity: captureIdentityFor(
          series,
          batch.sourceProjection,
          batch.sourceProjectionConfig,
        ),
        sourceProjection: batch.sourceProjection,
        sourceProjectionConfig: batch.sourceProjectionConfig,
        // The coordinate bridge consumes pane-local Y, but live-ink feedback
        // and interaction drafts remain container-local. Restore the original
        // samples before the batch crosses back into the drawing controller.
        captures: Object.freeze(batch.captures.map((capture) => Object.freeze({
          ...capture,
          screen: Object.freeze({
            x: capture.screen.x,
            y: capture.screen.y + paneOffsetY,
          }),
        }))),
      });
    }, null),
    axisTimeToDrawingAnchor: (time: unknown) => safeCall(() => {
      registerCurrentDrawingSeries();
      const context = createDrawingCoordinateContext();
      return drawingAnchorFromAxisTime(time, context.seriesData, context);
    }, null),
    coordinateToDrawingAnchor: (x: number) => safeCall(() => {
      const series = registerCurrentDrawingSeries();
      return drawingAnchorFromCoordinate(
        getChart(),
        series,
        x,
        createDrawingCoordinateContext(),
      );
    }, null),
    dataPointToCoordinate: (dataPoint: CoordinateDataPoint) => safeCall(() => {
      const series = registerCurrentDrawingSeries();
      return resolveDataPointCoordinate(
        getChart(),
        series,
        dataPoint,
        createDrawingCoordinateContext(),
      );
    }, null),
    getSeriesItemByTime: (time: unknown): unknown => {
      const dataMap = getSeriesDataMap();
      if (dataMap?.has?.(time)) return dataMap.get(time);
      return getSeriesData().find((bar) => bar?.time === time) || null;
    },
    getSeriesIndexByTime: (time: unknown): unknown => {
      const dataIndex = getSeriesDataIndex();
      if (dataIndex?.has?.(time)) return dataIndex.get(time);
      return getSeriesData().findIndex((bar) => bar?.time === time);
    },
    attachPrimitive: (primitive: AdapterPrimitive | null | undefined) => {
      const series = registerCurrentDrawingSeries();
      if (!series || !primitive) return false;
      return safeCall(() => {
        series.attachPrimitive(primitive);
        return true;
      }, false);
    },
    detachPrimitive: (primitive: AdapterPrimitive | null | undefined) => {
      if (!primitive) return false;
      const series = getSeries();
      let detached = false;
      const owningSeries = primitive._series;
      if (owningSeries && owningSeries !== series) {
        detached = safeCall(() => {
          owningSeries.detachPrimitive(primitive);
          return true;
        }, false) || detached;
      }
      if (series) {
        detached = safeCall(() => {
          series.detachPrimitive(primitive);
          return true;
        }, false) || detached;
      }
      return detached;
    },
    // Drawing interaction points are container-local while Lightweight Charts
    // price coordinates are pane-local. Keep this adapter boundary explicit so
    // the same controller can own the main pane, reordered panes, and native
    // indicator panes without leaking DOM offsets into persisted geometry.
    drawingPaneToContainerY: (y: number) => safeCall(
      () => y + getDrawingPaneOffsetY(),
      y,
    ),
    containerToDrawingPaneY: (y: number) => safeCall(
      () => y - getDrawingPaneOffsetY(),
      y,
    ),
    priceToCoordinate: (price: number) => safeCall(() => {
      const coordinate = getSeries()?.priceToCoordinate(price);
      return typeof coordinate === "number" && Number.isFinite(coordinate)
        ? coordinate + getDrawingPaneOffsetY()
        : null;
    }, null),
    timeToCoordinate: (time: unknown) => safeCall(() => getChart()?.timeScale().timeToCoordinate(time), null),
    timeToCoordinateInterpolated: (time: unknown) => safeCall(() => {
      const series = registerCurrentDrawingSeries();
      return timeToCoordinateInterpolated(
        getChart(),
        series,
        time,
        createDrawingCoordinateContext(),
      );
    }, null),
    coordinateToPrice: (y: number) => safeCall(() => (
      getSeries()?.coordinateToPrice(y - getDrawingPaneOffsetY()) ?? null
    ), null),
    coordinateToTime: (x: number) => safeCall(() => getChart()?.timeScale().coordinateToTime(x), null),
    coordinateToLogical: (x: number) => safeCall(() => getChart()?.timeScale().coordinateToLogical(x), null),
    logicalToCoordinate: (logical: number) => safeCall(() => getChart()?.timeScale().logicalToCoordinate(logical), null),
    logicalToCoordinateInterpolated: (logical: number) => safeCall(
      () => logicalToCoordinateInterpolated(getChart()?.timeScale(), logical),
      null,
    ),
    getBarSpacing: () => safeCall(() => getChart()?.timeScale().options?.().barSpacing, null),
    getDrawingPanePlotRect: (): Readonly<MainPanePlotRect> | null => safeCall(() => {
      const chart = getChart();
      if (!chart) return null;

      const paneIndex = getDrawingPaneIndex();
      // paneSize describes the plot surface for the requested pane, excluding
      // both price scales and the time scale. Its coordinates are pane-local,
      // so resolve the pane element's vertical offset for DOM overlays.
      const pane = chart.paneSize(paneIndex);
      const leftPriceScaleWidth = chart.priceScale("left", paneIndex).width();
      const paneOffsetY = getDrawingPaneOffsetY();
      if (!pane
        || !Number.isFinite(pane.width)
        || pane.width <= 0
        || !Number.isFinite(pane.height)
        || pane.height <= 0
        || !Number.isFinite(leftPriceScaleWidth)
        || leftPriceScaleWidth < 0
        || !Number.isFinite(paneOffsetY)
        || paneOffsetY < 0) return null;

      return Object.freeze({
        x: leftPriceScaleWidth,
        y: paneOffsetY,
        width: pane.width,
        height: pane.height,
        dpr: currentDevicePixelRatio(),
      });
    }, null),
    // Transitional alias retained for existing consumers and diagnostics.
    getMainPanePlotRect: (): Readonly<MainPanePlotRect> | null => safeCall(() => {
      const chart = getChart();
      if (!chart) return null;
      const paneIndex = getDrawingPaneIndex();
      const pane = chart.paneSize(paneIndex);
      const leftPriceScaleWidth = chart.priceScale("left", paneIndex).width();
      const paneOffsetY = getDrawingPaneOffsetY();
      if (!pane
        || !Number.isFinite(pane.width)
        || pane.width <= 0
        || !Number.isFinite(pane.height)
        || pane.height <= 0
        || !Number.isFinite(leftPriceScaleWidth)
        || leftPriceScaleWidth < 0
        || !Number.isFinite(paneOffsetY)
        || paneOffsetY < 0) return null;
      return Object.freeze({
        x: leftPriceScaleWidth,
        y: paneOffsetY,
        width: pane.width,
        height: pane.height,
        dpr: currentDevicePixelRatio(),
      });
    }, null),
    getTimeScaleWidth: () => safeCall(() => {
      const width = getChart()?.timeScale().width?.();
      return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null;
    }, null),
    getVisibleTimeRange: () => safeCall(() => getChart()?.timeScale().getVisibleRange(), null),
    getVisibleRange: () => safeCall(() => {
      const timeScale = getChart()?.timeScale();
      if (!timeScale) return null;
      return {
        logical: timeScale.getVisibleLogicalRange(),
        time: timeScale.getVisibleRange(),
        barSpacing: timeScale.options().barSpacing,
        scrollPosition: timeScale.scrollPosition(),
      };
    }, null),
    getVisiblePriceRange: (height: number) => safeCall(() => {
      const series = getSeries();
      if (!series || !Number.isFinite(height)) return null;
      const topPrice = series.coordinateToPrice(0);
      const bottomPrice = series.coordinateToPrice(height);
      if (typeof topPrice !== "number"
        || typeof bottomPrice !== "number"
        || !Number.isFinite(topPrice)
        || !Number.isFinite(bottomPrice)) return null;
      return Math.abs(topPrice - bottomPrice);
    }, null),
    restoreVisibleRange: (range: VisibleRangeSnapshot | null | undefined) => safeCall(() => {
      const timeScale = getChart()?.timeScale();
      if (!timeScale || !range) return false;
      if (range.logical) {
        timeScale.setVisibleLogicalRange(range.logical);
        emitDrawingFrameInvalidation("viewport");
        return true;
      }
      if (range.time) {
        timeScale.setVisibleRange(range.time);
        emitDrawingFrameInvalidation("viewport");
        return true;
      }
      return false;
    }, false),
    subscribeCrosshair: (handler: CrosshairHandler) => {
      const chart = getChart();
      if (!chart || typeof handler !== "function") return () => {};
      chart.subscribeCrosshairMove(handler);
      return () => safeCall(() => chart.unsubscribeCrosshairMove(handler), null);
    },
    requestSeriesUpdate: () => safeCall(() => {
      const result = getSeries()?.applyOptions({});
      emitDrawingFrameInvalidation();
      return result;
    }, null),
  };
}
