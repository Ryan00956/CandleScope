const ENGINE_SCRIPT_MARKER = "# __ENGINE__:";

export function buildDataSignature(data) {
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

export function buildRuntimeDataSignature(data, dataMeta = null) {
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

export function formatIndicatorError(payload, fallback = "Indicator error") {
  const detail = payload?.errorDetail;
  if (detail?.message) {
    const location = detail.line
      ? ` (line ${detail.line}${detail.column ? `:${detail.column}` : ""})`
      : "";
    return `${detail.message}${location}${detail.hint ? `\n${detail.hint}` : ""}`;
  }
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.detail === "string") return payload.detail;
  if (typeof payload?.detail?.error === "string") return payload.detail.error;
  return payload?.code || fallback;
}

export function isEngineBackedScript(indicator) {
  return typeof indicator?.script === "string" && indicator.script.startsWith(ENGINE_SCRIPT_MARKER);
}

export function isBuiltinIndicator(indicator) {
  return Boolean(indicator?.engineName || isEngineBackedScript(indicator));
}

export function isWsHostedIndicator(indicator) {
  return isBuiltinIndicator(indicator) || Boolean(indicator?.script);
}

export function getBuiltinIndicatorName(indicator) {
  if (indicator?.engineName) return indicator.engineName;
  if (isEngineBackedScript(indicator)) {
    return indicator.script.split("\n")[0].slice(ENGINE_SCRIPT_MARKER.length).trim();
  }
  return "";
}

export function isProvisionalChartData(dataMeta = null) {
  return dataMeta?.status === "provisional";
}

export function stringSignature(value = "") {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${hash}`;
}

function normalizeIndicatorLines(lines = []) {
  return lines.map((line) => {
    const displayName = line.name || line.title || "";
    return {
      ...line,
      name: displayName,
      title: displayName,
      outputName: line.outputName || line.output_name || null,
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

function normalizeSeriesToLines(series = []) {
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
      data: item.data || [],
    };
  });
}

export function resolveWsValue(line, values, isSingleLine) {
  const exactKeys = [line.outputName, line.name, line.title].filter(Boolean);
  for (const key of exactKeys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  }

  const lowerMap = new Map(
    Object.entries(values).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  for (const key of exactKeys) {
    const normalized = String(key).toLowerCase();
    if (lowerMap.has(normalized)) return lowerMap.get(normalized);
  }

  const entries = Object.entries(values);
  if (isSingleLine && entries.length === 1) return entries[0][1];
  return undefined;
}

export function upsertLinePoint(data, point) {
  const next = Array.isArray(data) ? [...data] : [];
  const idx = next.findIndex((item) => item.time === point.time);
  if (point.value == null || Number.isNaN(Number(point.value))) {
    if (idx !== -1) next.splice(idx, 1);
    return next;
  }
  const normalized = { ...point, value: Number(point.value) };
  if (idx === -1) {
    next.push(normalized);
    next.sort((a, b) => a.time - b.time);
  } else {
    next[idx] = { ...next[idx], ...normalized };
  }
  return next;
}

function mergeTimeData(existing = [], incoming = []) {
  const byTime = new Map();
  for (const item of existing || []) {
    if (item?.time == null) continue;
    byTime.set(item.time, item);
  }
  for (const item of incoming || []) {
    if (item?.time == null) continue;
    byTime.set(item.time, { ...(byTime.get(item.time) || {}), ...item });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function lineIdentity(line, index = 0) {
  return String(line?.outputName || line?.id || line?.localId || line?.name || line?.title || `line-${index}`);
}

export function mergeIndicatorLines(existing = [], incoming = []) {
  const merged = [...(existing || [])];
  const indexByKey = new Map();
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
    merged[existingIndex] = {
      ...current,
      ...line,
      data: mergeTimeData(current.data, line.data),
      ...(current.colorData || line.colorData
        ? { colorData: mergeTimeData(current.colorData, line.colorData) }
        : {}),
    };
  });

  return merged;
}

function itemIdentity(item, index = 0) {
  return String(item?.id || item?.name || item?.title || item?.indicatorId || `item-${index}`);
}

export function mergeIndicatorItems(existing = [], incoming = []) {
  const merged = [...(existing || [])];
  const indexByKey = new Map();
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
    merged[existingIndex] = {
      ...current,
      ...item,
      data: mergeTimeData(current.data, item.data),
    };
  });
  return merged;
}

function withIndicatorId(items, indicatorId) {
  return (items || []).map((item) => ({ ...item, indicatorId }));
}

function normalizeIndicatorFills(fills = [], indicatorId) {
  return (fills || []).map((fill) => {
    if (Array.isArray(fill.localSeriesIds) && fill.localSeriesIds.length >= 2) {
      return {
        plot1_id: fill.localSeriesIds[0],
        plot2_id: fill.localSeriesIds[1],
        color: fill.style?.color || fill.color,
        title: fill.style?.title || fill.title || "",
        pane: fill.pane,
        indicatorId,
      };
    }
    return { ...fill, indicatorId };
  });
}

function splitUnifiedAnnotations(annotations = [], indicatorId) {
  const markers = [];
  const hlines = [];
  const bgcolors = [];
  const barcolors = [];
  const signals = [];

  for (const item of annotations || []) {
    const style = item.style || {};
    const base = {
      id: item.id,
      indicatorId,
      pane: item.pane,
    };
    if (item.type === "marker") {
      markers.push({
        ...base,
        shape: style.shape || "circle",
        color: style.color || "#f59e0b",
        text: style.text || "",
        position: style.position || "above",
        size: style.size || "normal",
        data: item.data || [],
      });
    } else if (item.type === "hline") {
      hlines.push({
        ...base,
        price: item.data?.[0]?.value,
        title: style.title || "",
        color: style.color || "#787b86",
        linestyle: style.lineStyle ?? "dashed",
        linewidth: style.lineWidth || 1,
      });
    } else if (item.type === "bgcolor") {
      bgcolors.push({
        ...base,
        title: style.title || "",
        color: style.color || "rgba(59,130,246,0.1)",
        regions: item.data || [],
      });
    } else if (item.type === "barcolor") {
      barcolors.push({
        ...base,
        data: item.data || [],
      });
    } else if (item.type === "signal") {
      signals.push({
        ...base,
        name: style.name || "signal",
        side: style.side || "alert",
        message: style.message || "",
        data: item.data || [],
      });
    }
  }

  return { markers, hlines, bgcolors, barcolors, signals };
}

export function normalizeIndicatorPayload(payload, indicatorId) {
  const hasUnifiedSeries = Array.isArray(payload?.series) && payload.series.length > 0;
  const annotations = Array.isArray(payload?.annotations) ? payload.annotations : [];
  const splitAnnotations = splitUnifiedAnnotations(annotations, indicatorId);

  return {
    lines: normalizeIndicatorLines(
      hasUnifiedSeries ? normalizeSeriesToLines(payload.series) : (payload?.lines || [])
    ),
    markers: annotations.length > 0
      ? splitAnnotations.markers
      : withIndicatorId(payload?.markers, indicatorId),
    hlines: annotations.length > 0
      ? splitAnnotations.hlines
      : withIndicatorId(payload?.hlines, indicatorId),
    bgcolors: annotations.length > 0
      ? splitAnnotations.bgcolors
      : withIndicatorId(payload?.bgcolors, indicatorId),
    barcolors: annotations.length > 0
      ? splitAnnotations.barcolors
      : withIndicatorId(payload?.barcolors, indicatorId),
    signals: annotations.length > 0
      ? splitAnnotations.signals
      : withIndicatorId(payload?.signals, indicatorId),
    fills: normalizeIndicatorFills(payload?.legacyFills || payload?.fills, indicatorId),
  };
}

export function normalizeParamSchema(schema) {
  return Array.isArray(schema) ? schema : [];
}
