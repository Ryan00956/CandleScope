export const EMPTY_CHART_SURFACE_VIEW = Object.freeze({});

export function callChartSurface(chartRef, methodName, fallback = undefined, ...args) {
  const method = chartRef.current?.[methodName];
  if (typeof method !== "function") return fallback;
  return method(...args);
}
