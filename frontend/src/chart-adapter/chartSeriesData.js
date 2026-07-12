import { chartTimeKey, chartTimesEqual, compareChartTimes } from "./chartTime.js";

export function toCandlePoint(d) {
  if (
    d?.__whitespace
    || d?.open == null
    || d?.high == null
    || d?.low == null
    || d?.close == null
  ) {
    return { time: d.time };
  }
  return { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close };
}

export function filterEntriesByTime(entries = [], allowedTimeSet) {
  if (!allowedTimeSet) return entries || [];
  const allowedKeys = new Set();
  for (const time of allowedTimeSet) {
    const key = chartTimeKey(time);
    if (key !== null) allowedKeys.add(key);
  }
  return (entries || []).filter((entry) => {
    if (entry?.time == null) return false;
    if (allowedTimeSet.has(entry.time)) return true;
    const key = chartTimeKey(entry.time);
    return key !== null && allowedKeys.has(key);
  });
}

export function normalizeLineSeriesData(line, allowedTimeSet) {
  const isHistogram = line?.type === "histogram";
  const sourceData = filterEntriesByTime(line?.data, allowedTimeSet);
  if (isHistogram && line.colorData && Array.isArray(line.colorData)) {
    const colorMap = new Map();
    for (const cd of filterEntriesByTime(line.colorData, allowedTimeSet)) {
      const key = chartTimeKey(cd.time);
      if (key !== null) colorMap.set(key, cd.color);
    }
    return sourceData
      .filter((d) => d?.time != null && d?.value != null && isFinite(d.value))
      .map((d) => {
        const entry = { time: d.time, value: d.value };
        const c = colorMap.get(chartTimeKey(d.time));
        if (c) entry.color = c;
        return entry;
      });
  }
  return sourceData.filter((d) => d?.time != null && d?.value != null && isFinite(d.value));
}

export function alignIndicatorLinesToTimes(indicatorLines = [], allowedTimeSet) {
  return (indicatorLines || []).map((line) => ({
    ...line,
    data: normalizeLineSeriesData(line, allowedTimeSet),
    ...(Array.isArray(line?.colorData)
      ? { colorData: filterEntriesByTime(line.colorData, allowedTimeSet) }
      : {}),
  }));
}

export function alignIndicatorMarkersToTimes(indicatorMarkers = [], allowedTimeSet) {
  return (indicatorMarkers || []).map((group) => ({
    ...group,
    data: filterEntriesByTime(group?.data, allowedTimeSet),
  }));
}

export function alignIndicatorBgcolorsToTimes(indicatorBgcolors = [], allowedTimeSet) {
  return (indicatorBgcolors || []).map((group) => ({
    ...group,
    data: filterEntriesByTime(group?.data, allowedTimeSet),
    regions: filterEntriesByTime(group?.regions, allowedTimeSet),
  }));
}

export function linePointEquals(a, b) {
  return chartTimesEqual(a?.time, b?.time)
    && a?.value === b?.value
    && (a?.color || null) === (b?.color || null);
}

export function candlePointEquals(a, b) {
  return chartTimesEqual(a?.time, b?.time)
    && a?.open === b?.open
    && a?.high === b?.high
    && a?.low === b?.low
    && a?.close === b?.close
    && (a?.color || null) === (b?.color || null)
    && (a?.borderColor || null) === (b?.borderColor || null)
    && (a?.wickColor || null) === (b?.wickColor || null);
}

export function canUseTrailingSeriesUpdate(previousData, nextData) {
  if (!previousData?.length || !nextData?.length) return false;
  if (nextData.length < previousData.length || nextData.length > previousData.length + 1) return false;
  if (!chartTimesEqual(nextData[0]?.time, previousData[0]?.time)) return false;
  if (!chartTimesEqual(
    nextData[previousData.length - 1]?.time,
    previousData[previousData.length - 1]?.time,
  )) return false;

  const stableCount = Math.max(0, previousData.length - 1);
  for (let i = 0; i < stableCount; i += 1) {
    if (!linePointEquals(previousData[i], nextData[i])) return false;
  }
  return true;
}

export function canUseTrailingCandleUpdate(previousData, nextData) {
  if (!previousData?.length || !nextData?.length) return false;
  if (nextData.length < previousData.length || nextData.length > previousData.length + 1) return false;
  if (!chartTimesEqual(nextData[0]?.time, previousData[0]?.time)) return false;
  if (!chartTimesEqual(
    nextData[previousData.length - 1]?.time,
    previousData[previousData.length - 1]?.time,
  )) return false;

  const stableCount = Math.max(0, previousData.length - 1);
  for (let i = 0; i < stableCount; i += 1) {
    if (!candlePointEquals(previousData[i], nextData[i])) return false;
  }
  return true;
}

export function applyLineSeriesData(
  series,
  nextData,
  previousData,
  detail,
  recordPerfEvent,
  { preferSetData = false } = {},
) {
  if (!nextData?.length) {
    if (previousData?.length) {
      series.setData([]);
      recordPerfEvent?.("chart.indicatorSeries.setData", {
        ...detail,
        points: 0,
        reason: "clear",
      });
      return "clear";
    }
    return "empty";
  }
  if (!preferSetData && canUseTrailingSeriesUpdate(previousData, nextData)) {
    const start = Math.max(0, previousData.length - 1);
    for (let i = start; i < nextData.length; i += 1) {
      series.update(nextData[i]);
    }
    recordPerfEvent?.("chart.indicatorSeries.update", {
      ...detail,
      points: nextData.length - start,
      totalPoints: nextData.length,
    });
    return "update";
  }
  series.setData(nextData);
  recordPerfEvent?.("chart.indicatorSeries.setData", {
    ...detail,
    points: nextData.length,
  });
  return "setData";
}

export function buildFillRenderEntries(indicatorFills = [], indicatorLines = [], backgroundColor) {
  if (!indicatorFills?.length || !indicatorLines?.length) {
    return { entries: [], signature: "empty", matchedFillCount: 0, pointCount: 0 };
  }

  const plotDataMap = new Map();
  for (const line of indicatorLines) {
    if (!line.id) continue;
    const scopedKey = `${line.indicatorId || ""}:${line.id}`;
    plotDataMap.set(scopedKey, line.data);
    if (!line.indicatorId && !plotDataMap.has(line.id)) {
      plotDataMap.set(line.id, line.data);
    }
  }

  const entries = [];
  const signatureParts = [];
  let pointCount = 0;

  for (const fillDef of indicatorFills) {
    const { plot1_id, plot2_id } = fillDef;
    const scope = fillDef.indicatorId || "";
    const data1 = plotDataMap.get(`${scope}:${plot1_id}`) || (!scope ? plotDataMap.get(plot1_id) : null);
    const data2 = plotDataMap.get(`${scope}:${plot2_id}`) || (!scope ? plotDataMap.get(plot2_id) : null);
    if (!data1 || !data2 || data1.length === 0 || data2.length === 0) continue;

    const map1 = new Map();
    const map2 = new Map();
    for (const d of data1) {
      const key = chartTimeKey(d?.time);
      if (key !== null && d?.value != null && isFinite(d.value)) {
        map1.set(key, { time: d.time, value: d.value });
      }
    }
    for (const d of data2) {
      const key = chartTimeKey(d?.time);
      if (key !== null && d?.value != null && isFinite(d.value)) {
        map2.set(key, { time: d.time, value: d.value });
      }
    }

    const sharedPoints = [];
    for (const [key, first] of map1) {
      const second = map2.get(key);
      if (second) sharedPoints.push({ key, first, second });
    }
    sharedPoints.sort((a, b) => compareChartTimes(a.first.time, b.first.time));
    if (sharedPoints.length === 0) continue;

    const upperData = sharedPoints.map(({ first, second }) => ({
      time: first.time,
      value: Math.max(first.value, second.value),
    }));
    const lowerData = sharedPoints.map(({ first, second }) => ({
      time: first.time,
      value: Math.min(first.value, second.value),
    }));
    const fillColor = fillDef.color || "rgba(59,130,246,0.15)";
    entries.push({ upperData, lowerData, fillColor, backgroundColor });
    signatureParts.push(JSON.stringify([
      scope,
      plot1_id,
      plot2_id,
      fillColor,
      backgroundColor,
      sharedPoints.map(({ key, first, second }) => [key, first.value, second.value]),
    ]));
    pointCount += sharedPoints.length;
  }

  return {
    entries,
    signature: signatureParts.length ? signatureParts.join("|") : "empty",
    matchedFillCount: entries.length,
    pointCount,
  };
}
