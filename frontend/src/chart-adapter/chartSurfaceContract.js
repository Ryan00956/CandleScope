export const EMPTY_CHART_SURFACE_VIEW = Object.freeze({});

export function callChartSurface(chartRef, methodName, fallback = undefined, ...args) {
  try {
    const surface = chartRef?.current;
    const method = surface?.[methodName];
    if (typeof method !== "function") return fallback;
    return method.apply(surface, args);
  } catch {
    return fallback;
  }
}
