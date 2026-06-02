export function applyBarColors({
  series,
  data,
  indicatorBarcolors,
  prevBarcoloredDataRef,
  isSyncingRef,
  paneId,
  recordPerfEvent,
  toCandlePoint,
  canUseTrailingCandleUpdate,
  onError,
}) {
  if (!series || !data?.length) return;
  if (!indicatorBarcolors || indicatorBarcolors.length === 0) {
    if (prevBarcoloredDataRef.current.length > 0) {
      const plainData = data.map(toCandlePoint);
      try {
        isSyncingRef.current = true;
        series.setData(plainData);
        recordPerfEvent("chart.candleSeries.setData", {
          paneId,
          reason: "barcolor-clear",
          points: plainData.length,
        });
      } catch (err) {
        onError?.(err, "clear");
      } finally {
        isSyncingRef.current = false;
        prevBarcoloredDataRef.current = [];
      }
    }
    return;
  }

  // Build a time→color map from all barcolor sources
  const colorMap = new Map();
  for (const group of indicatorBarcolors) {
    if (!group.data || !Array.isArray(group.data)) continue;
    for (const bc of group.data) {
      if (bc.time != null && bc.color) {
        colorMap.set(bc.time, bc.color);
      }
    }
  }
  if (colorMap.size === 0) {
    prevBarcoloredDataRef.current = [];
    return;
  }

  // Re-set candle data with per-bar color overrides
  try {
    isSyncingRef.current = true;
    const coloredData = data.map((d) => {
      const point = toCandlePoint(d);
      if (point.open == null || point.high == null || point.low == null || point.close == null) {
        return point;
      }
      const c = colorMap.get(d.time);
      if (c) {
        return {
          ...point,
          color: c, borderColor: c, wickColor: c,
        };
      }
      return point;
    });
    if (canUseTrailingCandleUpdate(prevBarcoloredDataRef.current, coloredData)) {
      const start = Math.max(0, prevBarcoloredDataRef.current.length - 1);
      for (let i = start; i < coloredData.length; i += 1) {
        series.update(coloredData[i]);
      }
      recordPerfEvent("chart.candleSeries.update", {
        paneId,
        reason: "barcolor-trailing",
        points: coloredData.length - start,
        totalPoints: coloredData.length,
      });
    } else {
      series.setData(coloredData);
      recordPerfEvent("chart.candleSeries.setData", {
        paneId,
        reason: "barcolor-full",
        points: coloredData.length,
      });
    }
    prevBarcoloredDataRef.current = coloredData;
  } catch (err) {
    onError?.(err, "apply");
  } finally {
    isSyncingRef.current = false;
  }
}
