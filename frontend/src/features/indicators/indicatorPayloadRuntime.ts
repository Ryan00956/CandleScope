import {
  isIndicatorRecord,
  parseIndicatorParameterSchemas,
  parseIndicatorPayloadEnvelope,
} from "./indicatorContracts.js";
import type {
  IndicatorAnnotationPoint,
  IndicatorAuxiliaryItem,
  IndicatorColorPoint,
  IndicatorDefinition,
  IndicatorFill,
  IndicatorLine,
  IndicatorOutput,
  IndicatorParameterSchema,
  IndicatorPayloadEnvelope,
  IndicatorRange,
  IndicatorUnifiedAnnotation,
  IndicatorUnifiedSeries,
  IndicatorValuePoint,
  NormalizedIndicatorPayload,
} from "./indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";

const ENGINE_SCRIPT_MARKER = "# __ENGINE__:";

interface RuntimeDataMeta {
  version?: unknown;
  status?: unknown;
  firstTime?: unknown;
  lastTime?: unknown;
  bars?: unknown;
}

export function buildDataSignature(data: readonly KlineBar[]): string {
  if (!data || data.length === 0) return "0";
  const len = data.length;
  const first = data[0];
  const prev = data[len - 2] || null;
  const last = data[len - 1];
  return [
    len,
    first?.time ?? "",
    first?.open ?? "",
    first?.close ?? "",
    prev?.time ?? "",
    prev?.close ?? "",
    last?.time ?? "",
    last?.open ?? "",
    last?.high ?? "",
    last?.low ?? "",
    last?.close ?? "",
    last?.volume ?? "",
  ].join("|");
}

export function buildRuntimeDataSignature(
  data: readonly KlineBar[],
  dataMeta: RuntimeDataMeta | null = null,
): string {
  const dataSignature = buildDataSignature(data);
  if (!dataMeta) return dataSignature;
  return [
    dataMeta.version ?? "",
    dataMeta.status ?? "",
    dataMeta.firstTime ?? "",
    dataMeta.lastTime ?? "",
    dataMeta.bars ?? "",
    dataSignature,
  ].join("|");
}

export function formatIndicatorError(
  payload: unknown,
  fallback = "Indicator error",
): string {
  const record = isIndicatorRecord(payload) ? payload : {};
  const detail = isIndicatorRecord(record.errorDetail)
    ? record.errorDetail
    : null;
  if (detail?.message) {
    const message = String(detail.message);
    const line = typeof detail.line === "number" ? detail.line : null;
    const column = typeof detail.column === "number" ? detail.column : null;
    const hint = typeof detail.hint === "string" ? detail.hint : "";
    const location = line ? ` (line ${line}${column ? `:${column}` : ""})` : "";
    return `${message}${location}${hint ? `\n${hint}` : ""}`;
  }
  if (typeof record.error === "string") return record.error;
  if (typeof record.detail === "string") return record.detail;
  if (
    isIndicatorRecord(record.detail) &&
    typeof record.detail.error === "string"
  )
    return record.detail.error;
  return typeof record.code === "string" ? record.code : fallback;
}

export function isEngineBackedScript(
  indicator: IndicatorDefinition | null | undefined,
): boolean {
  return (
    typeof indicator?.script === "string" &&
    indicator.script.startsWith(ENGINE_SCRIPT_MARKER)
  );
}

export function isBuiltinIndicator(
  indicator: IndicatorDefinition | null | undefined,
): boolean {
  return Boolean(indicator?.engineName || isEngineBackedScript(indicator));
}

export function isWsHostedIndicator(
  indicator: IndicatorDefinition | null | undefined,
): boolean {
  if (indicator?.executionTarget === "local") return false;
  return isBuiltinIndicator(indicator) || Boolean(indicator?.script);
}

export function getBuiltinIndicatorName(
  indicator: IndicatorDefinition | null | undefined,
): string {
  if (indicator?.engineName) return indicator.engineName;
  const script = indicator?.script;
  if (typeof script === "string" && script.startsWith(ENGINE_SCRIPT_MARKER)) {
    const markerLine = script.split("\n", 1)[0] ?? "";
    return markerLine
      .slice(ENGINE_SCRIPT_MARKER.length)
      .trim();
  }
  return "";
}

export function isProvisionalChartData(
  dataMeta: RuntimeDataMeta | null = null,
): boolean {
  return dataMeta?.status === "provisional";
}

export function stringSignature(value = ""): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${hash}`;
}

function normalizeIndicatorLines(lines: IndicatorLine[] = []): IndicatorLine[] {
  return lines.map((line) => {
    const displayName = line.name || line.title || "";
    return {
      ...line,
      name: displayName,
      title: displayName,
      outputName: line.outputName || null,
      color: line.color || "#f59e0b",
      lineWidth: line.lineWidth || 2,
      lineStyle: line.lineStyle || 0,
      type: line.type || "line",
      overlay: line.pane !== "separate" && line.pane !== "volume",
      pane: line.pane || "main",
      colorData: line.colorData || null,
    };
  });
}

function normalizeSeriesToLines(
  series: IndicatorUnifiedSeries[] = [],
): IndicatorLine[] {
  return (series || []).map((item) => {
    const style = item.style || {};
    const displayName = style.title || item.localId || item.id || "";
    return {
      id: item.localId || item.id,
      name: displayName,
      title: displayName,
      outputName: item.localId || item.id || null,
      color: style.color || "#f59e0b",
      lineWidth: style.lineWidth || 2,
      lineStyle: style.lineStyle || 0,
      type: item.type || "line",
      pane: item.pane || "main",
      overlay: item.pane !== "separate" && item.pane !== "volume",
      colorData: style.colorData || null,
      ...(style.visible !== undefined ? { visible: style.visible } : {}),
      ...(style.base !== undefined ? { base: style.base } : {}),
      ...(style.trackPrice !== undefined
        ? { trackPrice: style.trackPrice }
        : {}),
      data: item.data || [],
    };
  });
}

export function resolveWsValue(
  line: IndicatorLine,
  values: Record<string, unknown>,
  isSingleLine: boolean,
): unknown {
  const exactKeys = [line.outputName, line.name, line.title].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  for (const key of exactKeys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  }

  const lowerMap = new Map(
    Object.entries(values).map(([key, value]) => [
      String(key).toLowerCase(),
      value,
    ]),
  );
  for (const key of exactKeys) {
    const normalized = String(key).toLowerCase();
    if (lowerMap.has(normalized)) return lowerMap.get(normalized);
  }

  const entries = Object.entries(values);
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  if (isSingleLine && onlyEntry !== undefined) return onlyEntry[1];
  return undefined;
}

export function upsertLinePoint(
  data: IndicatorValuePoint[],
  point: { time: number; value: unknown; color?: string },
): IndicatorValuePoint[] {
  const current = Array.isArray(data) ? data : [];
  const tail = current.at(-1);
  const idx = tail?.time === point.time
    ? current.length - 1
    : current.findIndex((item) => item.time === point.time);
  if (point.value == null || Number.isNaN(Number(point.value))) {
    if (idx === -1) return current;
    const next = [...current];
    next.splice(idx, 1);
    return next;
  }
  const normalized = { ...point, value: Number(point.value) };
  if (idx !== -1) {
    const existing = current[idx];
    if (
      existing?.value === normalized.value
      && existing.color === normalized.color
    ) {
      return current;
    }
  }
  const next = [...current];
  if (idx === -1) {
    next.push(normalized);
    if (tail && tail.time > normalized.time) next.sort((a, b) => a.time - b.time);
  } else {
    next[idx] = { ...next[idx], ...normalized };
  }
  return next;
}

export function clearIndicatorLineData(
  lines: IndicatorLine[] = [],
): IndicatorLine[] {
  return (lines || []).map((line) => ({
    ...line,
    data: [],
    ...(Array.isArray(line?.colorData) ? { colorData: [] } : {}),
  }));
}

function mergeTimeData<T extends { time?: number }>(
  existing: T[] = [],
  incoming: T[] = [],
): T[] {
  const byTime = new Map<number, T>();
  for (const item of existing || []) {
    if (item?.time == null) continue;
    byTime.set(item.time, item);
  }
  for (const item of incoming || []) {
    if (item?.time == null) continue;
    byTime.set(item.time, { ...(byTime.get(item.time) || {}), ...item });
  }
  return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

function normalizeRange(range: IndicatorRange | null | undefined): IndicatorRange | null {
  const start = Math.floor(Number(range?.start));
  const end = Math.floor(Number(range?.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    return null;
  return { start, end };
}

function pointTime(item: { time?: number }): number | null {
  const time = Number(item.time);
  return Number.isFinite(time) ? time : null;
}

function isInRange(item: { time?: number }, range: IndicatorRange): boolean {
  const time = pointTime(item);
  return time != null && time >= range.start && time <= range.end;
}

function hasTimedData(items: Array<{ time?: number }> = []): boolean {
  return items.some((item) => pointTime(item) != null);
}

function replaceTimeDataRange<T extends { time?: number }>(
  existing: T[] = [],
  incoming: T[] = [],
  rangeInput: IndicatorRange | null = null,
): T[] {
  const range = normalizeRange(rangeInput);
  if (!range) return mergeTimeData(existing, incoming);

  const byTime = new Map<number, T>();
  for (const item of existing || []) {
    if (item?.time == null || isInRange(item, range)) continue;
    byTime.set(item.time, item);
  }
  for (const item of incoming || []) {
    if (item?.time == null || !isInRange(item, range)) continue;
    byTime.set(item.time, { ...(byTime.get(item.time) || {}), ...item });
  }
  return Array.from(byTime.values()).sort((a, b) => Number(a.time) - Number(b.time));
}

function lineIdentity(line: IndicatorLine, index = 0): string {
  return String(
    line?.outputName ||
      line?.id ||
      line?.localId ||
      line?.name ||
      line?.title ||
      `line-${index}`,
  );
}

export function mergeIndicatorLines(
  existing: IndicatorLine[] = [],
  incoming: IndicatorLine[] = [],
): IndicatorLine[] {
  const merged = [...(existing || [])];
  const indexByKey = new Map<string, number>();
  merged.forEach((line, index) => {
    indexByKey.set(lineIdentity(line, index), index);
  });

  incoming.forEach((line, incomingIndex) => {
    const key = lineIdentity(line, incomingIndex);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      merged.push(line);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const current = merged[existingIndex];
    if (current === undefined) {
      merged.push(line);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    merged[existingIndex] = {
      ...current,
      ...line,
      data: mergeTimeData(current.data, line.data),
      renderUpdate: "full",
      ...(current.colorData || line.colorData
        ? { colorData: mergeTimeData(current.colorData ?? [], line.colorData ?? []) }
        : {}),
    };
  });

  return merged;
}

export function replaceIndicatorLinesRange(
  existing: IndicatorLine[] = [],
  incoming: IndicatorLine[] = [],
  rangeInput: IndicatorRange | null = null,
): IndicatorLine[] {
  const range = normalizeRange(rangeInput);
  if (!range) return mergeIndicatorLines(existing, incoming);

  const merged: IndicatorLine[] = (existing || []).map((line) => ({
    ...line,
    data: replaceTimeDataRange(line.data, [], range),
    renderUpdate: "full" as const,
    ...(line.colorData
      ? { colorData: replaceTimeDataRange(line.colorData, [], range) }
      : {}),
  }));
  const indexByKey = new Map<string, number>();
  merged.forEach((line, index) => {
    indexByKey.set(lineIdentity(line, index), index);
  });

  incoming.forEach((line, incomingIndex) => {
    const key = lineIdentity(line, incomingIndex);
    const existingIndex = indexByKey.get(key);
    const incomingLine = {
      ...line,
      data: replaceTimeDataRange([], line.data, range),
      renderUpdate: "full" as const,
      ...(line.colorData
        ? { colorData: replaceTimeDataRange([], line.colorData, range) }
        : {}),
    };
    if (existingIndex == null) {
      merged.push(incomingLine);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const current = merged[existingIndex];
    if (current === undefined) {
      merged.push(incomingLine);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    merged[existingIndex] = {
      ...current,
      ...line,
      data: replaceTimeDataRange(current.data, line.data, range),
      renderUpdate: "full",
      ...(current.colorData || line.colorData
        ? {
            colorData: replaceTimeDataRange(
              current.colorData ?? [],
              line.colorData ?? [],
              range,
            ),
          }
        : {}),
    };
  });

  return merged;
}

function itemIdentity(item: IndicatorAuxiliaryItem, index = 0): string {
  return String(
    item.id ||
      ("name" in item ? item.name : undefined) ||
      ("title" in item ? item.title : undefined) ||
      item.indicatorId ||
      `item-${index}`,
  );
}

function auxiliaryData(item: IndicatorAuxiliaryItem): IndicatorAnnotationPoint[] | undefined {
  return "data" in item && Array.isArray(item.data) ? item.data : undefined;
}

export function mergeIndicatorItems<T extends IndicatorAuxiliaryItem>(
  existing: T[] = [],
  incoming: T[] = [],
): T[] {
  const merged = [...(existing || [])];
  const indexByKey = new Map<string, number>();
  merged.forEach((item, index) => {
    indexByKey.set(itemIdentity(item, index), index);
  });
  incoming.forEach((item, incomingIndex) => {
    const key = itemIdentity(item, incomingIndex);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      merged.push(item);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const current = merged[existingIndex];
    if (current === undefined) {
      merged.push(item);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const currentData = auxiliaryData(current);
    const itemData = auxiliaryData(item);
    merged[existingIndex] = {
      ...current,
      ...item,
      ...(currentData || itemData
        ? { data: mergeTimeData(currentData || [], itemData || []) }
        : {}),
    };
  });
  return merged;
}

export function replaceIndicatorItemsRange<T extends IndicatorAuxiliaryItem>(
  existing: T[] = [],
  incoming: T[] = [],
  rangeInput: IndicatorRange | null = null,
): T[] {
  const range = normalizeRange(rangeInput);
  if (!range) return mergeIndicatorItems(existing, incoming);

  const merged = (existing || []).map((item) => {
    const data = auxiliaryData(item);
    if (!data || !hasTimedData(data)) return item;
    return { ...item, data: replaceTimeDataRange(data, [], range) };
  });
  const indexByKey = new Map<string, number>();
  merged.forEach((item, index) => {
    indexByKey.set(itemIdentity(item, index), index);
  });

  incoming.forEach((item, incomingIndex) => {
    const key = itemIdentity(item, incomingIndex);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      const itemData = auxiliaryData(item);
      merged.push({
        ...item,
        ...(itemData && hasTimedData(itemData)
          ? { data: replaceTimeDataRange([], itemData, range) }
          : {}),
      });
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const current = merged[existingIndex];
    if (current === undefined) {
      merged.push(item);
      indexByKey.set(key, merged.length - 1);
      return;
    }
    const currentData = auxiliaryData(current);
    const itemData = auxiliaryData(item);
    const timed = hasTimedData(currentData || []) || hasTimedData(itemData || []);
    merged[existingIndex] = {
      ...current,
      ...item,
      ...(timed
        ? { data: replaceTimeDataRange(currentData || [], itemData || [], range) }
        : {}),
    };
  });

  return merged;
}

function withIndicatorId<T extends IndicatorAuxiliaryItem>(
  items: T[],
  indicatorId: string,
): T[] {
  return (items || []).map((item) => ({ ...item, indicatorId }));
}

function normalizeIndicatorFills(
  fills: IndicatorFill[] = [],
  indicatorId: string,
): IndicatorFill[] {
  return (fills || []).map((fill) => {
    if (Array.isArray(fill.localSeriesIds) && fill.localSeriesIds.length >= 2) {
      const normalized: IndicatorFill = {
        title: fill.style?.title || fill.title || "",
        indicatorId,
      };
      const plot1Id = fill.localSeriesIds[0];
      const plot2Id = fill.localSeriesIds[1];
      const color = fill.style?.color || fill.color;
      if (plot1Id !== null && plot1Id !== undefined) {
        normalized.plot1_id = plot1Id;
      }
      if (plot2Id !== null && plot2Id !== undefined) {
        normalized.plot2_id = plot2Id;
      }
      if (color !== undefined) normalized.color = color;
      if (fill.pane !== undefined) normalized.pane = fill.pane;
      return normalized;
    }
    return { ...fill, indicatorId };
  });
}

function styleString(
  style: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return typeof style[key] === "string" ? style[key] : fallback;
}

function styleNumber(
  style: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  return typeof style[key] === "number" && Number.isFinite(style[key])
    ? style[key]
    : fallback;
}

function splitUnifiedAnnotations(
  annotations: IndicatorUnifiedAnnotation[] = [],
  indicatorId: string,
): Omit<NormalizedIndicatorPayload, "lines" | "fills"> {
  const outputs: IndicatorOutput[] = [];

  for (const item of annotations) {
    const style = item.style;
    const base = {
      id: item.id,
      indicatorId,
      pane: item.pane,
    };
    if (item.type === "marker") {
      outputs.push({
        kind: "marker",
        value: {
          ...base,
          shape: styleString(style, "shape", "circle"),
          color: styleString(style, "color", "#f59e0b"),
          text: styleString(style, "text", ""),
          position: styleString(style, "position", "above"),
          size: styleString(style, "size", "normal"),
          data: item.data,
        },
      });
    } else if (item.type === "hline") {
      const lineStyle = style.lineStyle;
      const hline: Extract<IndicatorOutput, { kind: "hline" }>["value"] = {
        ...base,
        title: styleString(style, "title", ""),
        color: styleString(style, "color", "#787b86"),
        linestyle:
          typeof lineStyle === "number" || typeof lineStyle === "string"
            ? lineStyle
            : "dashed",
        linewidth: styleNumber(style, "lineWidth", 1),
      };
      const price = item.data[0]?.value;
      if (price !== undefined) hline.price = price;
      outputs.push({
        kind: "hline",
        value: hline,
      });
    } else if (item.type === "bgcolor") {
      outputs.push({
        kind: "bgcolor",
        value: {
          ...base,
          title: styleString(style, "title", ""),
          color: styleString(style, "color", "rgba(59,130,246,0.1)"),
          regions: item.data,
        },
      });
    } else if (item.type === "barcolor") {
      const data: IndicatorColorPoint[] = [];
      for (const point of item.data) {
        if (typeof point.time !== "number" || typeof point.color !== "string") {
          continue;
        }
        const colorPoint: IndicatorColorPoint = {
          time: point.time,
          color: point.color,
        };
        if (point.value !== undefined) colorPoint.value = point.value;
        data.push(colorPoint);
      }
      outputs.push({
        kind: "barcolor",
        value: {
          ...base,
          data,
        },
      });
    } else if (item.type === "signal") {
      outputs.push({
        kind: "signal",
        value: {
          ...base,
          name: styleString(style, "name", "signal"),
          side: styleString(style, "side", "alert"),
          message: styleString(style, "message", ""),
          data: item.data,
        },
      });
    }
  }

  const normalized: Omit<NormalizedIndicatorPayload, "lines" | "fills"> = {
    markers: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
  };
  for (const output of outputs) {
    switch (output.kind) {
      case "marker":
        normalized.markers.push(output.value);
        break;
      case "hline":
        normalized.hlines.push(output.value);
        break;
      case "bgcolor":
        normalized.bgcolors.push(output.value);
        break;
      case "barcolor":
        normalized.barcolors.push(output.value);
        break;
      case "signal":
        normalized.signals.push(output.value);
        break;
      case "line":
      case "fill":
        throw new Error(`Unexpected annotation output kind: ${output.kind}`);
      default: {
        const unreachable: never = output;
        return unreachable;
      }
    }
  }
  return normalized;
}

export function normalizeIndicatorPayload(
  payload: unknown,
  indicatorId: string,
): NormalizedIndicatorPayload {
  return normalizeParsedIndicatorPayload(
    parseIndicatorPayloadEnvelope(payload),
    indicatorId,
  );
}

/** Normalize an envelope that already crossed the strict wire-contract parser. */
export function normalizeParsedIndicatorPayload(
  parsed: IndicatorPayloadEnvelope,
  indicatorId: string,
): NormalizedIndicatorPayload {
  const hasUnifiedSeries = parsed.series.length > 0;
  const annotations = parsed.annotations;
  const splitAnnotations = splitUnifiedAnnotations(annotations, indicatorId);

  return {
    lines: normalizeIndicatorLines(
      hasUnifiedSeries ? normalizeSeriesToLines(parsed.series) : parsed.lines,
    ),
    markers:
      annotations.length > 0
        ? splitAnnotations.markers
      : withIndicatorId(parsed.markers, indicatorId),
    hlines:
      annotations.length > 0
        ? splitAnnotations.hlines
      : withIndicatorId(parsed.hlines, indicatorId),
    bgcolors:
      annotations.length > 0
        ? splitAnnotations.bgcolors
      : withIndicatorId(parsed.bgcolors, indicatorId),
    barcolors:
      annotations.length > 0
        ? splitAnnotations.barcolors
      : withIndicatorId(parsed.barcolors, indicatorId),
    signals:
      annotations.length > 0
        ? splitAnnotations.signals
      : withIndicatorId(parsed.signals, indicatorId),
    fills: normalizeIndicatorFills(
      parsed.legacyFills.length > 0 ? parsed.legacyFills : parsed.fills,
      indicatorId,
    ),
  };
}

export function normalizeParamSchema(schema: unknown): IndicatorParameterSchema[] {
  try {
    return parseIndicatorParameterSchemas(schema);
  } catch {
    return [];
  }
}
