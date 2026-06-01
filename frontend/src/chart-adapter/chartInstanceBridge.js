import { logicalToCoordinateInterpolated, timeToCoordinateInterpolated } from "./coordinateBridge.js";

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

export function createLightweightChartAdapter({ chartRef, seriesRef }) {
  const getChart = () => getRefValue(chartRef);
  const getSeries = () => getRefValue(seriesRef);

  return {
    isReady: () => !!(getChart() && getSeries()),
    hasSeries: () => !!getSeries(),
    getMainSeries: getSeries,
    getSeriesData: () => safeCall(() => getSeries()?.data?.() || [], []),
    attachPrimitive: (primitive) => {
      const series = getSeries();
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
    timeToCoordinateInterpolated: (time) => safeCall(
      () => timeToCoordinateInterpolated(getChart(), getSeries(), time),
      null,
    ),
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
