import {
  captureSourceLineageFreehandStrokeBatch,
  dataPointToCoordinate as resolveDataPointCoordinate,
  drawingAnchorFromCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  registerDrawingSeriesContext,
  resolveDrawingDataPointsToCoordinates,
  resolveSourceLineageSpanToCoordinates,
  timeToCoordinateInterpolated,
} from "./coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateDataPoint,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
  DrawingSeriesProviders,
  ScreenPoint,
  SourceLineageSpanInput,
} from "./coordinateBridge.js";
import {
  drawingFrameRevisionsEqual,
  isDrawingFrameSnapshot,
} from "./drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "./drawingFrameSnapshot.js";
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
  const drawingFrameSeriesOwners = new WeakMap<DrawingFrameSnapshot, AdapterSeries>();
  const drawingFrameInvalidationListeners = new Set<() => void>();
  const emitDrawingFrameInvalidation = () => {
    for (const listener of drawingFrameInvalidationListeners) {
      safeCall(() => listener(), undefined);
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

  return {
    isReady: () => !!(getChart() && getSeries()),
    hasSeries: () => !!getSeries(),
    usesOrdinalTime: () => usesOrdinalData(getSeriesData()),
    getMainSeries: getSeries,
    getSeriesData,
    captureDrawingFrame,
    isDrawingFrameCurrent,
    projectDrawingFrameDataPoints: (
      snapshot: DrawingFrameSnapshot,
      dataPoints: readonly CoordinateDataPoint[],
    ): Float64Array | null => safeCall(() => {
      if (!isDrawingFrameCurrent(snapshot)) return null;
      const chart = getChart();
      const series = getSeries();
      if (!chart || !series) return null;
      const xCoordinates = resolveDrawingDataPointsToCoordinates(
        chart,
        series,
        dataPoints,
        createDrawingFrameCoordinateContext(snapshot),
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
        // intentionally render a horizontal line from price even when its
        // anchor x is unresolved, and vice versa for a vertical line.
        if (typeof x === "number" && Number.isFinite(x)) {
          coordinates[coordinateIndex] = x;
        }
        if (typeof price === "number" && Number.isFinite(price)) {
          const y = series.priceToCoordinate(price);
          if (typeof y === "number" && Number.isFinite(y)) {
            coordinates[coordinateIndex + 1] = y;
          }
        }
      }
      return isDrawingFrameCurrent(snapshot) ? coordinates : null;
    }, null),
    projectDrawingFrameSourceLineageSpan: (
      snapshot: DrawingFrameSnapshot,
      span: SourceLineageSpanInput,
    ): Readonly<{ left: number; right: number }> | null => safeCall(() => {
      if (!isDrawingFrameCurrent(snapshot)) return null;
      const chart = getChart();
      const series = getSeries();
      if (!chart || !series) return null;
      const projected = resolveSourceLineageSpanToCoordinates(
        chart,
        series,
        span,
        createDrawingFrameCoordinateContext(snapshot),
      );
      if (!projected
        || !Number.isFinite(projected.left)
        || !Number.isFinite(projected.right)
        || projected.left >= projected.right) return null;
      if (!isDrawingFrameCurrent(snapshot)) return null;
      return Object.freeze({ left: projected.left, right: projected.right });
    }, null),
    subscribeDrawingFrameInvalidation: (listener: () => void) => {
      if (typeof listener !== "function") return () => {};
      drawingFrameInvalidationListeners.add(listener);
      const timeScale = safeCall(() => getChart()?.timeScale(), null);
      const notify = () => safeCall(() => listener(), undefined);
      safeCall(() => timeScale?.subscribeVisibleLogicalRangeChange?.(notify), undefined);
      safeCall(() => timeScale?.subscribeSizeChange?.(notify), undefined);
      return () => {
        drawingFrameInvalidationListeners.delete(listener);
        safeCall(() => timeScale?.unsubscribeVisibleLogicalRangeChange?.(notify), undefined);
        safeCall(() => timeScale?.unsubscribeSizeChange?.(notify), undefined);
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
      const batch = captureSourceLineageFreehandStrokeBatch(
        chart,
        series,
        screenPoints,
        context,
      );
      if (!batch) return null;
      return Object.freeze({
        captureIdentity: captureIdentityFor(
          series,
          batch.sourceProjection,
          batch.sourceProjectionConfig,
        ),
        ...batch,
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
    priceToCoordinate: (price: number) => safeCall(() => getSeries()?.priceToCoordinate(price), null),
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
    coordinateToPrice: (y: number) => safeCall(() => getSeries()?.coordinateToPrice(y), null),
    coordinateToTime: (x: number) => safeCall(() => getChart()?.timeScale().coordinateToTime(x), null),
    coordinateToLogical: (x: number) => safeCall(() => getChart()?.timeScale().coordinateToLogical(x), null),
    logicalToCoordinate: (logical: number) => safeCall(() => getChart()?.timeScale().logicalToCoordinate(logical), null),
    logicalToCoordinateInterpolated: (logical: number) => safeCall(
      () => logicalToCoordinateInterpolated(getChart()?.timeScale(), logical),
      null,
    ),
    getBarSpacing: () => safeCall(() => getChart()?.timeScale().options?.().barSpacing, null),
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
        emitDrawingFrameInvalidation();
        return true;
      }
      if (range.time) {
        timeScale.setVisibleRange(range.time);
        emitDrawingFrameInvalidation();
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
