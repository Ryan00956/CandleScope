export function buildChartPaneImperativeHandle({
  paneId,
  paneType,
  paneRootRef,
  containerRef,
  chartRef,
  alignmentSeriesRef,
  mainSeriesRef,
  indicatorSeriesRef,
  isSyncingRef,
  clearAllDrawings,
  setDrawingsHidden,
  updateSelectedDrawingStyle,
  prepareDrawingExport,
  resetAutoScale,
}) {
  const withSyncGuard = (operation) => {
    const chart = chartRef.current;
    if (!chart) return null;
    isSyncingRef.current = true;
    try {
      return operation(chart);
    } catch {
      return null;
    } finally {
      isSyncingRef.current = false;
    }
  };

  return {
    clearAllDrawings,
    setDrawingsHidden,
    updateSelectedDrawingStyle,
    prepareExport: () => {
      prepareDrawingExport();
    },
    getExportSnapshot: () => {
      const rootElement = paneRootRef.current;
      const chartElement = containerRef.current;
      return {
        paneId,
        paneType,
        rootElement,
        chartElement,
        rect: rootElement?.getBoundingClientRect?.() || null,
      };
    },
    syncCrosshair: (time) => {
      withSyncGuard((chart) => {
        if (time == null) {
          chart.clearCrosshairPosition();
          return;
        }
        const series =
          alignmentSeriesRef.current ||
          mainSeriesRef.current ||
          indicatorSeriesRef.current[0]?.series;
        if (series) {
          chart.setCrosshairPosition(undefined, time, series);
        }
      });
    },
    setVisibleLogicalRange: (range) => {
      if (!range) return;
      withSyncGuard((chart) => chart.timeScale().setVisibleLogicalRange(range));
    },
    fitContent: () => {
      const chart = chartRef.current;
      if (!chart) return;
      try {
        chart.timeScale().fitContent();
      } catch {
        // Ignore chart-library range errors.
      }
    },
    getVisibleLogicalRange: () => {
      const chart = chartRef.current;
      if (!chart) return null;
      try {
        return chart.timeScale().getVisibleLogicalRange();
      } catch {
        return null;
      }
    },
    getVisibleRange: () => {
      const chart = chartRef.current;
      if (!chart) return null;
      try {
        const timeScale = chart.timeScale();
        return {
          logical: timeScale.getVisibleLogicalRange(),
          time: timeScale.getVisibleRange(),
          barSpacing: timeScale.options().barSpacing,
          scrollPosition: timeScale.scrollPosition(),
        };
      } catch {
        return null;
      }
    },
    setVisibleTimeRange: (range) => {
      if (!range) return;
      withSyncGuard((chart) => chart.timeScale().setVisibleRange(range));
    },
    setScrollPosition: (position, animated = false) => {
      if (!Number.isFinite(position)) return;
      withSyncGuard((chart) => chart.timeScale().scrollToPosition(position, animated));
    },
    applyTimeScaleOptions: (options) => {
      const chart = chartRef.current;
      if (!chart) return;
      try {
        chart.timeScale().applyOptions(options);
      } catch {
        // Ignore invalid partial options.
      }
    },
    resetAutoScale,
  };
}
