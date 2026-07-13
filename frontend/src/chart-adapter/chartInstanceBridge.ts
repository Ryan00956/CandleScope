import {
  captureSourceLineageFreehandStrokeBatch,
  dataPointToCoordinate as resolveDataPointCoordinate,
  drawingAnchorFromCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  registerDrawingSeriesContext,
  timeToCoordinateInterpolated,
} from "./coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateDataPoint,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
  DrawingSeriesProviders,
  ScreenPoint,
} from "./coordinateBridge.js";
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
  timeToCoordinate(time: unknown): number | null;
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

interface DrawingCoordinateSnapshot {
  seriesData?: DisplayRow[];
  ordinalSeriesIndex?: DrawingLineageIndex | null;
  indexRevision?: number | null;
  sourceTimeHorizon?: unknown;
  sourceInterval?: unknown;
  sourceIntervalSeconds?: unknown;
  drawingProjectionConfig?: unknown;
}

interface LookupMap {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
}

interface LightweightChartAdapterOptions {
  chartRef: RefOrValue<AdapterChart>;
  seriesRef: RefOrValue<AdapterSeries>;
  seriesDataRef?: RefOrValue<unknown>;
  seriesDataMapRef?: RefOrValue<LookupMap>;
  seriesDataIndexRef?: RefOrValue<LookupMap>;
  sourceTimeHorizonRef?: RefOrValue<unknown>;
  sourceIntervalRef?: RefOrValue<unknown>;
  sourceIntervalSecondsRef?: RefOrValue<unknown>;
  projectionConfigRef?: RefOrValue<unknown>;
  ordinalSeriesIndexProvider?: (() => DrawingLineageIndex | null) | null;
  drawingCoordinateSnapshotProvider?: (() => DrawingCoordinateSnapshot | null) | null;
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

type CrosshairHandler = (event: unknown) => void;

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

function usesOrdinalData(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  for (const row of data) {
    if (row?.time != null) return isOrdinalAxisTime(row.time);
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
    if (Array.isArray(data)) return data;
    const fallbackData = safeCall(() => getSeries()?.data?.() || [], []);
    return Array.isArray(fallbackData) ? fallbackData as DisplayRow[] : [];
  };
  const getSeriesDataForSeries = (series: AdapterSeries): DisplayRow[] => {
    const data = getRefValue(seriesDataRef);
    if (Array.isArray(data)) return data;
    const fallbackData = safeCall(() => series.data?.() || [], []);
    return Array.isArray(fallbackData) ? fallbackData as DisplayRow[] : [];
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
    const hasSnapshotData = Array.isArray(snapshot?.seriesData);
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
        ? snapshot.ordinalSeriesIndex || null
        : getOrdinalSeriesIndex(),
      ...(hasSnapshotData
        ? { drawingOrdinalSeriesIndexRevision: snapshot.indexRevision ?? null }
        : {}),
      drawingProjectionConfig: hasSnapshotProjectionConfig
        ? snapshot.drawingProjectionConfig
        : getProjectionConfig(),
      seriesData: hasSnapshotData ? snapshot.seriesData : getSeriesData(),
      sourceInterval: hasSnapshotIntervalId
        ? snapshot.sourceInterval
        : getSourceInterval(),
      sourceIntervalSeconds: hasSnapshotInterval
        ? snapshot.sourceIntervalSeconds
        : getSourceIntervalSeconds(),
      sourceTimeHorizon: hasSnapshotHorizon
        ? snapshot.sourceTimeHorizon
        : getSourceTimeHorizon(),
    };
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
      if (hasSnapshotProvider && (!snapshot || !Array.isArray(snapshot.seriesData))) return null;

      const seriesData = hasSnapshotProvider && snapshot
        ? snapshot.seriesData
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
        context.drawingOrdinalSeriesIndex = ordinalSeriesIndex;
        context.drawingOrdinalSeriesIndexRevision = hasSnapshotProvider && snapshot
          ? snapshot.indexRevision ?? null
          : ordinalSeriesIndex?.revision ?? null;
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
        safeCall(() => owningSeries.detachPrimitive(primitive), null);
        detached = true;
      }
      if (series) {
        safeCall(() => series.detachPrimitive(primitive), null);
        detached = true;
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
        return true;
      }
      if (range.time) {
        timeScale.setVisibleRange(range.time);
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
    requestSeriesUpdate: () => safeCall(() => getSeries()?.applyOptions({}), null),
  };
}
