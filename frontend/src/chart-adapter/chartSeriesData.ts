import { chartTimeKey, chartTimesEqual, compareChartTimes } from "./chartTime.js";
import type {
  ChartSeriesInputRow,
  ChartTime,
  FillRenderEntry,
  FillRenderResult,
  IndicatorBgcolorGroup,
  IndicatorDataEntry,
  IndicatorFillDefinition,
  IndicatorLine,
  IndicatorMarkerGroup,
  NormalizedIndicatorDataEntry,
  PerfEventRecorder,
  SeriesDataWriter,
} from "./chartAdapterTypes.js";

interface AllowedTimeKeyCacheEntry {
  size: number;
  keys: ReadonlySet<string>;
}

interface FilteredEntriesCacheEntry {
  allowedTimeSet: object;
  allowedTimeSetSize: number;
  result: unknown[];
}

interface NormalizedLineCacheEntry {
  allowedTimeSet: object | null;
  allowedTimeSetSize: number;
  colorData: object | null;
  histogram: boolean;
  result: NormalizedIndicatorDataEntry[];
}

interface AlignedGroupCacheEntry<TResult> {
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined;
  allowedTimeSize: number;
  result: TResult;
}

const allowedTimeKeyCache = new WeakMap<object, AllowedTimeKeyCacheEntry>();
const filteredEntriesCache = new WeakMap<object, FilteredEntriesCacheEntry>();
const normalizedLineCache = new WeakMap<object, NormalizedLineCacheEntry>();
const histogramColorMapCache = new WeakMap<object, ReadonlyMap<string, string>>();
const histogramPointCache = new WeakMap<object, Map<string, NormalizedIndicatorDataEntry>>();
const alignedMarkerCache = new WeakMap<object, AlignedGroupCacheEntry<IndicatorMarkerGroup[]>>();
const alignedBgcolorCache = new WeakMap<object, AlignedGroupCacheEntry<IndicatorBgcolorGroup[]>>();

function allowedTimeKeys(allowedTimeSet: ReadonlySet<ChartTime>): ReadonlySet<string> {
  const cacheKey = allowedTimeSet as object;
  const cached = allowedTimeKeyCache.get(cacheKey);
  if (cached?.size === allowedTimeSet.size) return cached.keys;
  const keys = new Set<string>();
  for (const time of allowedTimeSet) {
    const key = chartTimeKey(time);
    if (key !== null) keys.add(key);
  }
  allowedTimeKeyCache.set(cacheKey, { size: allowedTimeSet.size, keys });
  return keys;
}

function histogramColorMap(
  colorEntries: Array<{ time?: ChartTime; color?: string }>,
): ReadonlyMap<string, string> {
  const cached = histogramColorMapCache.get(colorEntries);
  if (cached) return cached;
  const colors = new Map<string, string>();
  for (const entry of colorEntries) {
    const key = chartTimeKey(entry.time);
    if (key !== null && entry.color) colors.set(key, entry.color);
  }
  histogramColorMapCache.set(colorEntries, colors);
  return colors;
}

function normalizedHistogramPoint(
  point: NormalizedIndicatorDataEntry,
  color: string | undefined,
): NormalizedIndicatorDataEntry {
  if ((point.color || undefined) === color) return point;
  const cacheKey = point as object;
  let byColor = histogramPointCache.get(cacheKey);
  if (!byColor) {
    byColor = new Map();
    histogramPointCache.set(cacheKey, byColor);
  }
  const colorKey = color || "";
  const cached = byColor.get(colorKey);
  if (cached) return cached;
  const normalized: NormalizedIndicatorDataEntry = { time: point.time, value: point.value };
  if (color) normalized.color = color;
  byColor.set(colorKey, normalized);
  return normalized;
}

export function toCandlePoint(d: ChartSeriesInputRow): ChartSeriesInputRow {
  const time = d.time;
  if (time == null) return {};
  if (
    d?.__whitespace
    || d?.open == null
    || d?.high == null
    || d?.low == null
    || d?.close == null
  ) {
    return { time };
  }
  return { time, open: d.open, high: d.high, low: d.low, close: d.close };
}

export function filterEntriesByTime<TEntry extends { time?: ChartTime }>(
  entries: TEntry[] = [],
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
  allowedKeysInput?: ReadonlySet<string> | null,
): TEntry[] {
  if (!allowedTimeSet) return entries || [];
  const source = entries || [];
  const allowedTimeSetKey = allowedTimeSet as object;
  const cached = filteredEntriesCache.get(source);
  if (cached?.allowedTimeSet === allowedTimeSetKey
    && cached.allowedTimeSetSize === allowedTimeSet.size) {
    return cached.result as TEntry[];
  }
  const allowedKeys = allowedKeysInput ?? allowedTimeKeys(allowedTimeSet);
  const result = source.filter((entry) => {
    if (entry?.time == null) return false;
    if (allowedTimeSet.has(entry.time)) return true;
    const key = chartTimeKey(entry.time);
    return key !== null && allowedKeys?.has(key) === true;
  });
  filteredEntriesCache.set(source, {
    allowedTimeSet: allowedTimeSetKey,
    allowedTimeSetSize: allowedTimeSet.size,
    result,
  });
  return result;
}

export function buildAllowedTimeKeys(
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
): ReadonlySet<string> | null {
  if (!allowedTimeSet) return null;
  return allowedTimeKeys(allowedTimeSet);
}

export function normalizeLineSeriesData(
  line: IndicatorLine | null | undefined,
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
  allowedKeysInput?: ReadonlySet<string> | null,
): NormalizedIndicatorDataEntry[] {
  const allowedKeys = allowedKeysInput ?? buildAllowedTimeKeys(allowedTimeSet);
  const isHistogram = line?.type === "histogram";
  const source = line?.data || [];
  const allowedTimeSetKey = allowedTimeSet ? allowedTimeSet as object : null;
  const colorDataKey = Array.isArray(line?.colorData) ? line.colorData : null;
  const cached = normalizedLineCache.get(source);
  if (cached?.allowedTimeSet === allowedTimeSetKey
    && cached.allowedTimeSetSize === (allowedTimeSet?.size ?? -1)
    && cached.colorData === colorDataKey
    && cached.histogram === isHistogram) {
    return cached.result;
  }
  const sourceData = filterEntriesByTime(source, allowedTimeSet, allowedKeys);
  let result: NormalizedIndicatorDataEntry[];
  if (isHistogram && line.colorData && Array.isArray(line.colorData)) {
    const colorMap = histogramColorMap(
      filterEntriesByTime(line.colorData, allowedTimeSet, allowedKeys),
    );
    result = sourceData
      .filter((d): d is NormalizedIndicatorDataEntry => (
        d?.time != null && d?.value != null && isFinite(d.value)
      ))
      .map((d) => {
        const key = chartTimeKey(d.time);
        // Realtime histogram updates carry their color on the value point,
        // while historical snapshots carry a parallel colorData series.  A
        // snapshot can therefore have colorData without yet containing the
        // newest realtime timestamp.  Keep the point color authoritative and
        // use colorData only as the historical fallback; otherwise the newest
        // volume/MACD bars silently fall back to the series default color.
        const color = d.color || (key === null ? undefined : colorMap.get(key));
        return normalizedHistogramPoint(d, color);
      });
  } else {
    result = sourceData.filter((d): d is NormalizedIndicatorDataEntry => (
      d?.time != null && d?.value != null && isFinite(d.value)
    ));
  }
  normalizedLineCache.set(source, {
    allowedTimeSet: allowedTimeSetKey,
    allowedTimeSetSize: allowedTimeSet?.size ?? -1,
    colorData: colorDataKey,
    histogram: isHistogram,
    result,
  });
  return result;
}

export function alignIndicatorLinesToTimes(
  indicatorLines: IndicatorLine[] = [],
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
  allowedKeysInput?: ReadonlySet<string> | null,
): IndicatorLine[] {
  const allowedKeys = allowedKeysInput ?? buildAllowedTimeKeys(allowedTimeSet);
  return (indicatorLines || []).map((line) => ({
    ...line,
    data: normalizeLineSeriesData(line, allowedTimeSet, allowedKeys),
    ...(Array.isArray(line?.colorData)
      ? { colorData: filterEntriesByTime(line.colorData, allowedTimeSet, allowedKeys) }
      : {}),
  }));
}

export function alignIndicatorMarkersToTimes(
  indicatorMarkers: IndicatorMarkerGroup[] = [],
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
  allowedKeysInput?: ReadonlySet<string> | null,
): IndicatorMarkerGroup[] {
  const cacheKey = indicatorMarkers as object;
  const cached = alignedMarkerCache.get(cacheKey);
  if (
    cached
    && cached.allowedTimeSet === allowedTimeSet
    && cached.allowedTimeSize === (allowedTimeSet?.size ?? -1)
  ) {
    return cached.result;
  }
  const allowedKeys = allowedKeysInput ?? buildAllowedTimeKeys(allowedTimeSet);
  const result = (indicatorMarkers || []).map((group) => ({
    ...group,
    data: filterEntriesByTime(group?.data, allowedTimeSet, allowedKeys),
  }));
  alignedMarkerCache.set(cacheKey, {
    allowedTimeSet,
    allowedTimeSize: allowedTimeSet?.size ?? -1,
    result,
  });
  return result;
}

export function alignIndicatorBgcolorsToTimes(
  indicatorBgcolors: IndicatorBgcolorGroup[] = [],
  allowedTimeSet: ReadonlySet<ChartTime> | null | undefined,
  allowedKeysInput?: ReadonlySet<string> | null,
): IndicatorBgcolorGroup[] {
  const cacheKey = indicatorBgcolors as object;
  const cached = alignedBgcolorCache.get(cacheKey);
  if (
    cached
    && cached.allowedTimeSet === allowedTimeSet
    && cached.allowedTimeSize === (allowedTimeSet?.size ?? -1)
  ) {
    return cached.result;
  }
  const allowedKeys = allowedKeysInput ?? buildAllowedTimeKeys(allowedTimeSet);
  const result = (indicatorBgcolors || []).map((group) => ({
    ...group,
    data: filterEntriesByTime(group?.data, allowedTimeSet, allowedKeys),
    regions: filterEntriesByTime(group?.regions, allowedTimeSet, allowedKeys),
  }));
  alignedBgcolorCache.set(cacheKey, {
    allowedTimeSet,
    allowedTimeSize: allowedTimeSet?.size ?? -1,
    result,
  });
  return result;
}

export function linePointEquals(
  a: IndicatorDataEntry | null | undefined,
  b: IndicatorDataEntry | null | undefined,
): boolean {
  return chartTimesEqual(a?.time, b?.time)
    && a?.value === b?.value
    && (a?.color || null) === (b?.color || null);
}

export function candlePointEquals(
  a: ChartSeriesInputRow | null | undefined,
  b: ChartSeriesInputRow | null | undefined,
): boolean {
  return chartTimesEqual(a?.time, b?.time)
    && a?.open === b?.open
    && a?.high === b?.high
    && a?.low === b?.low
    && a?.close === b?.close
    && (a?.color || null) === (b?.color || null)
    && (a?.borderColor || null) === (b?.borderColor || null)
    && (a?.wickColor || null) === (b?.wickColor || null);
}

export function canUseTrailingSeriesUpdate(
  previousData: IndicatorDataEntry[] | null | undefined,
  nextData: IndicatorDataEntry[] | null | undefined,
): boolean {
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

export function canUseTrailingCandleUpdate(
  previousData: ChartSeriesInputRow[] | null | undefined,
  nextData: ChartSeriesInputRow[] | null | undefined,
): boolean {
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
  series: SeriesDataWriter<IndicatorDataEntry>,
  nextData: IndicatorDataEntry[],
  previousData: IndicatorDataEntry[],
  detail: Readonly<Record<string, unknown>>,
  recordPerfEvent: PerfEventRecorder | null | undefined,
  {
    preferSetData = false,
    trustedTrailingUpdate = false,
  }: { preferSetData?: boolean; trustedTrailingUpdate?: boolean } = {},
): "clear" | "empty" | "unchanged" | "update" | "setData" {
  if (nextData === previousData) return "unchanged";
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
  const trailingShapeMatches = Boolean(
    previousData?.length
    && nextData?.length
    && nextData.length >= previousData.length
    && nextData.length <= previousData.length + 1
    && chartTimesEqual(nextData[0]?.time, previousData[0]?.time)
    && chartTimesEqual(
      nextData[previousData.length - 1]?.time,
      previousData[previousData.length - 1]?.time,
    )
  );
  if (!preferSetData && (
    (trustedTrailingUpdate && trailingShapeMatches)
    || canUseTrailingSeriesUpdate(previousData, nextData)
  )) {
    const start = Math.max(0, previousData.length - 1);
    for (let i = start; i < nextData.length; i += 1) {
      const point = nextData[i];
      if (point) series.update(point);
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

export function buildFillRenderEntries(
  indicatorFills: IndicatorFillDefinition[] = [],
  indicatorLines: IndicatorLine[] = [],
  backgroundColor: string,
): FillRenderResult {
  if (!indicatorFills?.length || !indicatorLines?.length) {
    return {
      entries: [],
      signature: "empty",
      structureSignature: "empty",
      matchedFillCount: 0,
      pointCount: 0,
    };
  }

  const plotDataMap = new Map<string, IndicatorDataEntry[] | undefined>();
  for (const line of indicatorLines) {
    if (!line.id) continue;
    const scopedKey = `${line.indicatorId || ""}:${line.id}`;
    plotDataMap.set(scopedKey, line.data);
    if (!line.indicatorId && !plotDataMap.has(line.id)) {
      plotDataMap.set(line.id, line.data);
    }
  }

  const entries: FillRenderEntry[] = [];
  const signatureParts: string[] = [];
  const structureSignatureParts: string[] = [];
  let pointCount = 0;

  for (const fillDef of indicatorFills) {
    const { plot1_id, plot2_id } = fillDef;
    if (!plot1_id || !plot2_id) continue;
    const scope = fillDef.indicatorId || "";
    const data1 = plotDataMap.get(`${scope}:${plot1_id}`) || (!scope ? plotDataMap.get(plot1_id) : null);
    const data2 = plotDataMap.get(`${scope}:${plot2_id}`) || (!scope ? plotDataMap.get(plot2_id) : null);
    if (!data1 || !data2 || data1.length === 0 || data2.length === 0) continue;

    const map1 = new Map<string, { time: ChartTime; value: number }>();
    const map2 = new Map<string, { time: ChartTime; value: number }>();
    for (const d of data1) {
      const key = chartTimeKey(d?.time);
      if (key !== null && d.time != null && d.value != null && isFinite(d.value)) {
        map1.set(key, { time: d.time, value: d.value });
      }
    }
    for (const d of data2) {
      const key = chartTimeKey(d?.time);
      if (key !== null && d.time != null && d.value != null && isFinite(d.value)) {
        map2.set(key, { time: d.time, value: d.value });
      }
    }

    const sharedPoints: Array<{
      key: string;
      first: { time: ChartTime; value: number };
      second: { time: ChartTime; value: number };
    }> = [];
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
    structureSignatureParts.push(JSON.stringify([
      scope,
      plot1_id,
      plot2_id,
      fillColor,
      backgroundColor,
    ]));
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
    structureSignature: structureSignatureParts.length
      ? structureSignatureParts.join("|")
      : "empty",
    matchedFillCount: entries.length,
    pointCount,
  };
}
