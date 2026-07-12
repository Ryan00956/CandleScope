import {
  dataPointToCoordinate as resolveDataPointCoordinate,
  drawingAnchorFromAxisTime,
  isOrdinalAxisTime,
  logicalToCoordinateInterpolated,
  registerDrawingSeriesContext,
  timeToCoordinateInterpolated,
} from "./coordinateBridge.js";

function getRefValue(refOrValue) {
  return refOrValue && typeof refOrValue === "object" && "current" in refOrValue
    ? refOrValue.current
    : refOrValue;
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function usesOrdinalData(data) {
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
  projectionConfigRef = null,
}) {
  const getChart = () => getRefValue(chartRef);
  const getSeries = () => getRefValue(seriesRef);
  const getSeriesData = () => {
    const data = getRefValue(seriesDataRef);
    if (Array.isArray(data)) return data;
    return safeCall(() => getSeries()?.data?.() || [], []);
  };
  const getSeriesDataMap = () => getRefValue(seriesDataMapRef);
  const getSeriesDataIndex = () => getRefValue(seriesDataIndexRef);
  const getSourceTimeHorizon = () => getRefValue(sourceTimeHorizonRef);
  const getProjectionConfig = () => getRefValue(projectionConfigRef);
  const drawingSeriesProviders = {
    projectionConfigProvider: getProjectionConfig,
    seriesDataProvider: getSeriesData,
    sourceTimeHorizonProvider: getSourceTimeHorizon,
  };
  const registerCurrentDrawingSeries = () => {
    const series = getSeries();
    if (series) registerDrawingSeriesContext(series, drawingSeriesProviders);
    return series;
  };
  const createDrawingCoordinateContext = () => ({
    drawingProjectionConfig: getProjectionConfig(),
    seriesData: getSeriesData(),
    sourceTimeHorizon: getSourceTimeHorizon(),
  });

  return {
    isReady: () => !!(getChart() && getSeries()),
    hasSeries: () => !!getSeries(),
    usesOrdinalTime: () => usesOrdinalData(getSeriesData()),
    getMainSeries: getSeries,
    getSeriesData,
    axisTimeToDrawingAnchor: (time) => safeCall(() => {
      registerCurrentDrawingSeries();
      const context = createDrawingCoordinateContext();
      return drawingAnchorFromAxisTime(time, context.seriesData, context);
    }, null),
    dataPointToCoordinate: (dataPoint) => safeCall(() => {
      const series = registerCurrentDrawingSeries();
      return resolveDataPointCoordinate(
        getChart(),
        series,
        dataPoint,
        createDrawingCoordinateContext(),
      );
    }, null),
    getSeriesItemByTime: (time) => {
      const dataMap = getSeriesDataMap();
      if (dataMap?.has?.(time)) return dataMap.get(time);
      return getSeriesData().find((bar) => bar?.time === time) || null;
    },
    getSeriesIndexByTime: (time) => {
      const dataIndex = getSeriesDataIndex();
      if (dataIndex?.has?.(time)) return dataIndex.get(time);
      return getSeriesData().findIndex((bar) => bar?.time === time);
    },
    attachPrimitive: (primitive) => {
      const series = registerCurrentDrawingSeries();
      if (!series || !primitive) return false;
      return safeCall(() => {
        series.attachPrimitive(primitive);
        return true;
      }, false);
    },
    detachPrimitive: (primitive) => {
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
    priceToCoordinate: (price) => safeCall(() => getSeries()?.priceToCoordinate(price), null),
    timeToCoordinate: (time) => safeCall(() => getChart()?.timeScale().timeToCoordinate(time), null),
    timeToCoordinateInterpolated: (time) => safeCall(() => {
      const series = registerCurrentDrawingSeries();
      return timeToCoordinateInterpolated(
        getChart(),
        series,
        time,
        createDrawingCoordinateContext(),
      );
    }, null),
    coordinateToPrice: (y) => safeCall(() => getSeries()?.coordinateToPrice(y), null),
    coordinateToTime: (x) => safeCall(() => getChart()?.timeScale().coordinateToTime(x), null),
    coordinateToLogical: (x) => safeCall(() => getChart()?.timeScale().coordinateToLogical(x), null),
    logicalToCoordinate: (logical) => safeCall(() => getChart()?.timeScale().logicalToCoordinate(logical), null),
    logicalToCoordinateInterpolated: (logical) => safeCall(
      () => logicalToCoordinateInterpolated(getChart()?.timeScale(), logical),
      null,
    ),
    getBarSpacing: () => safeCall(() => getChart()?.timeScale().options?.().barSpacing, null),
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
    getVisiblePriceRange: (height) => safeCall(() => {
      const series = getSeries();
      if (!series || !Number.isFinite(height)) return null;
      const topPrice = series.coordinateToPrice(0);
      const bottomPrice = series.coordinateToPrice(height);
      if (!Number.isFinite(topPrice) || !Number.isFinite(bottomPrice)) return null;
      return Math.abs(topPrice - bottomPrice);
    }, null),
    restoreVisibleRange: (range) => safeCall(() => {
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
    subscribeCrosshair: (handler) => {
      const chart = getChart();
      if (!chart || typeof handler !== "function") return () => {};
      chart.subscribeCrosshairMove(handler);
      return () => safeCall(() => chart.unsubscribeCrosshairMove(handler), null);
    },
    requestSeriesUpdate: () => safeCall(() => getSeries()?.applyOptions({}), null),
  };
}
