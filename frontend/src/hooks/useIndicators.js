/**
 * useIndicators — manages active indicators, computation, and multi-pane line data.
 *
 * **Multi-pane architecture (v2):**
 * Instead of adding series directly to a single chart, this hook now computes
 * indicator data and outputs structured pane information:
 *   - `mainOverlayLines` — line data for the main chart (overlay indicators)
 *   - `subPanes`         — array of {id, label, lines} for separate/volume panes
 *
 * The MultiPaneChart component uses this data to create independent chart instances
 * per pane, each with its own price scale and auto-scaling.
 *
 * Volume is auto-added as a built-in indicator on first load.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { computeIndicator, fetchPreset, getIndicatorStreamUrl } from "../services/indicatorApi";

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const VOL_INIT_KEY = "candlescope-vol-initialized";
const ENGINE_SCRIPT_MARKER = "# __ENGINE__:";
const INDICATOR_WS_RECONNECT_MS = 3000;
const INDICATOR_WS_INITIAL_HISTORY_LIMIT = 500;

function loadActiveIndicators() {
  try {
    const raw = localStorage.getItem(ACTIVE_INDICATORS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveActiveIndicators(list) {
  localStorage.setItem(ACTIVE_INDICATORS_KEY, JSON.stringify(list));
}

function buildDataSignature(data) {
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

function stringSignature(value = "") {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${hash}`;
}

function formatIndicatorError(payload, fallback = "Indicator error") {
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

function isEngineBackedScript(indicator) {
  return typeof indicator?.script === "string" && indicator.script.startsWith(ENGINE_SCRIPT_MARKER);
}

function isBuiltinIndicator(indicator) {
  return Boolean(indicator?.engineName || isEngineBackedScript(indicator));
}

function isWsHostedIndicator(indicator) {
  return isBuiltinIndicator(indicator) || Boolean(indicator?.script);
}

function getBuiltinIndicatorName(indicator) {
  if (indicator?.engineName) return indicator.engineName;
  if (isEngineBackedScript(indicator)) {
    return indicator.script.split("\n")[0].slice(ENGINE_SCRIPT_MARKER.length).trim();
  }
  return "";
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

function resolveWsValue(line, values, isSingleLine) {
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

function upsertLinePoint(data, point) {
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

function mergeIndicatorLines(existing = [], incoming = []) {
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

function mergeIndicatorItems(existing = [], incoming = []) {
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

function normalizeIndicatorPayload(payload, indicatorId) {
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

function normalizeParamSchema(schema) {
  return Array.isArray(schema) ? schema : [];
}

/**
 * @param {object} opts
 * @param {Array}                  opts.chartData       — current OHLCV data array
 * @param {string}                 opts.datasetKey      — changes when chart is recreated
 * @param {number}                 opts.seriesReady     — increments when chart series is ready
 * @param {string}                 [opts.candleUpColor]   — K-line up color (synced to VOL indicator)
 * @param {string}                 [opts.candleDownColor] — K-line down color (synced to VOL indicator)
 */
export function useIndicators({
  chartData,
  datasetKey,
  seriesReady,
  candleUpColor,
  candleDownColor,
  symbol,
  interval,
  marketType,
  exchange = "binance",
}) {
  // Active indicators: [{id, name, script, params, visible, lines: [...computedLines]}]
  const [activeIndicators, setActiveIndicators] = useState(loadActiveIndicators);
  const [computing, setComputing] = useState(false);

  // Structured output for multi-pane rendering
  const [mainOverlayLines, setMainOverlayLines] = useState([]);
  const [subPanes, setSubPanes] = useState([]);

  // Extended output types from Pyne runtime
  const [markers, setMarkers] = useState([]);      // [{data: [{time, shape, color, text, position}]}]
  const [fills, setFills] = useState([]);           // [{plot1_id, plot2_id, color}]
  const [hlines, setHlines] = useState([]);         // [{price, title, color, linestyle, pane}]
  const [bgcolors, setBgcolors] = useState([]);     // [{color, pane, regions: [{time}]}]
  const [barcolors, setBarcolors] = useState([]);   // [{data: [{time, color}]}]
  const [signals, setSignals] = useState([]);       // [{data: [{time, side, name, message}], indicatorId}]
  const [paramSchemas, setParamSchemas] = useState({}); // indicatorId → param_schema[]
  const lastComputeSignatureRef = useRef("");
  const queuedRecomputeRef = useRef(false);
  const queuedForceRecomputeRef = useRef(false);

  // Keep refs to always-latest values
  const activeIndicatorsRef = useRef(activeIndicators);
  activeIndicatorsRef.current = activeIndicators;
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;
  const candleUpColorRef = useRef(candleUpColor);
  candleUpColorRef.current = candleUpColor;
  const candleDownColorRef = useRef(candleDownColor);
  candleDownColorRef.current = candleDownColor;

  // Flag for forced compute
  const pendingForceComputeRef = useRef(false);
  const volInitRef = useRef(false);
  const computingRef = useRef(false);
  // Flag: only show "computing" UI when user manually triggers recompute
  const userTriggeredRef = useRef(false);
  const indicatorWsRef = useRef(null);
  const indicatorWsSubscriptionsRef = useRef(new Map());
  const syncHostedSubscriptionsRef = useRef(() => false);

  // Persist active indicators to localStorage
  useEffect(() => {
    const toSave = activeIndicators.map((indicator) => {
      const rest = { ...indicator };
      delete rest.lines;
      delete rest.error;
      return rest;
    });
    saveActiveIndicators(toSave);
  }, [activeIndicators]);

  // ── Auto-add "vol" indicator on first-ever load ───────────
  useEffect(() => {
    if (volInitRef.current) return;
    volInitRef.current = true;

    const current = loadActiveIndicators();
    if (current.some((i) => i.id === "vol")) return;

    // Always try to fetch and add vol — even if wasInit was set previously,
    // because older versions may have set the flag despite the fetch failing.
    fetchPreset("vol")
      .then((full) => {
        if (!full) return;
        localStorage.setItem(VOL_INIT_KEY, "1");
        setActiveIndicators((prev) => {
          if (prev.some((i) => i.id === "vol")) return prev;
          return [
            ...prev,
            {
              id: full.id,
              name: full.name,
              engineName: full.engineName || null,
              script: full.script,
              params: full.params || {},
              description: full.description || "",
              category: full.category || "",
              paneTarget: full.paneTarget || "sub",
              isPreset: true,
              visible: true,
              lines: [],
            },
          ];
        });
        pendingForceComputeRef.current = true;
      })
      .catch((err) => console.warn("Failed to auto-add vol indicator:", err));
  }, []);

  // ── Add an indicator ──────────────────────────────────────
  const addIndicator = useCallback((indicator) => {
    setActiveIndicators((prev) => {
      if (prev.some((i) => i.id === indicator.id)) return prev;
      return [...prev, { ...indicator, visible: true, lines: [] }];
    });
    pendingForceComputeRef.current = true;
  }, []);

  // ── Remove an indicator ───────────────────────────────────
  const removeIndicator = useCallback((indicatorId) => {
    setActiveIndicators((prev) => prev.filter((i) => i.id !== indicatorId));
    // The pane data will be rebuilt on next render cycle
  }, []);

  // ── Toggle visibility ─────────────────────────────────────
  const toggleVisibility = useCallback((indicatorId) => {
    setActiveIndicators((prev) =>
      prev.map((i) => (i.id === indicatorId ? { ...i, visible: !i.visible } : i))
    );
  }, []);

  // ── Update indicator params ───────────────────────────────
  const updateIndicatorParams = useCallback((indicatorId, newParams) => {
    setActiveIndicators((prev) =>
      prev.map((i) => (i.id === indicatorId ? { ...i, params: newParams } : i))
    );
    pendingForceComputeRef.current = true;
  }, []);

  // ── Update indicator script (for custom editing) ──────────
  const updateIndicatorScript = useCallback((indicatorId, newScript) => {
    setActiveIndicators((prev) =>
      prev.map((i) => (i.id === indicatorId ? { ...i, script: newScript } : i))
    );
    pendingForceComputeRef.current = true;
  }, []);

  const applyWsSnapshot = useCallback((indicatorId, payload) => {
    const error = payload?.ok === false ? formatIndicatorError(payload) : null;
    const schema = normalizeParamSchema(payload?.param_schema);
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    setActiveIndicators((prev) =>
      prev.map((ind) =>
        ind.id === indicatorId
          ? {
              ...ind,
              lines: normalized.lines,
              error,
              ...(schema.length > 0 ? { paramSchema: schema } : {}),
            }
          : ind
      )
    );
    setMarkers((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.markers,
    ]);
    setFills((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.fills,
    ]);
    setHlines((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.hlines,
    ]);
    setBgcolors((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.bgcolors,
    ]);
    setBarcolors((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.barcolors,
    ]);
    setSignals((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...normalized.signals,
    ]);
    if (schema.length > 0) {
      setParamSchemas((prev) => ({ ...prev, [indicatorId]: schema }));
    }
  }, []);

  const applyWsPatch = useCallback((indicatorId, payload) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    setActiveIndicators((prev) =>
      prev.map((ind) =>
        ind.id === indicatorId
          ? {
              ...ind,
              lines: mergeIndicatorLines(ind.lines || [], normalized.lines),
              error: payload?.ok === false ? formatIndicatorError(payload) : null,
            }
          : ind
      )
    );
    setMarkers((prev) => mergeIndicatorItems(
      prev.filter((item) => item.indicatorId !== indicatorId),
      [
        ...prev.filter((item) => item.indicatorId === indicatorId),
        ...normalized.markers,
      ],
    ));
    setFills((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...mergeIndicatorItems(
        prev.filter((item) => item.indicatorId === indicatorId),
        normalized.fills,
      ),
    ]);
    setHlines((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...mergeIndicatorItems(
        prev.filter((item) => item.indicatorId === indicatorId),
        normalized.hlines,
      ),
    ]);
    setBgcolors((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...mergeIndicatorItems(
        prev.filter((item) => item.indicatorId === indicatorId),
        normalized.bgcolors,
      ),
    ]);
    setBarcolors((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...mergeIndicatorItems(
        prev.filter((item) => item.indicatorId === indicatorId),
        normalized.barcolors,
      ),
    ]);
    setSignals((prev) => [
      ...prev.filter((item) => item.indicatorId !== indicatorId),
      ...mergeIndicatorItems(
        prev.filter((item) => item.indicatorId === indicatorId),
        normalized.signals,
      ),
    ]);
  }, []);

  const applyWsValues = useCallback((indicatorId, values, barTime) => {
    if (!values || !barTime) return;
    const currentChartData = chartDataRef.current || [];
    const bar = currentChartData.find((item) => item.time === barTime);
    const histogramColor = bar
      ? (bar.close >= bar.open ? candleUpColorRef.current : candleDownColorRef.current)
      : null;

    setActiveIndicators((prev) =>
      prev.map((ind) => {
        if (ind.id !== indicatorId || !Array.isArray(ind.lines)) return ind;
        const isSingleLine = ind.lines.length === 1 && Object.keys(values).length === 1;
        const lines = ind.lines.map((line) => {
          const value = resolveWsValue(line, values, isSingleLine);
          if (value === undefined) return line;
          const point = { time: barTime, value };
          if (line.type === "histogram" && histogramColor) {
            point.color = histogramColor;
          }
          return { ...line, data: upsertLinePoint(line.data, point) };
        });
        return { ...ind, lines, error: null };
      })
    );
  }, []);

  const setIndicatorError = useCallback((indicatorId, error) => {
    setActiveIndicators((prev) =>
      prev.map((ind) => (ind.id === indicatorId ? { ...ind, error } : ind))
    );
  }, []);

  // ── Build pane data from active indicators ────────────────
  // This is the core of the multi-pane system: we partition computed lines
  // into overlay (main chart) vs separate panes.
  const buildPaneData = useCallback((indicators) => {
    const overlayLines = [];
    const paneMap = new Map(); // paneId → {id, label, lines}

    for (const ind of indicators) {
      if (!ind.visible || !ind.lines || ind.lines.length === 0) continue;

      for (const line of ind.lines) {
        const pane = line.pane || "main";
        // Attach indicatorId so fill() can match plot references
        const lineWithId = { ...line, indicatorId: ind.id };

        if (pane === "main") {
          // Overlay on main chart
          overlayLines.push(lineWithId);
        } else {
          // Separate pane or volume pane — group by indicator id
          const paneId = `${pane}-${ind.id}`;
          if (!paneMap.has(paneId)) {
            paneMap.set(paneId, {
              id: paneId,
              label: ind.name || ind.id,
              lines: [],
            });
          }
          paneMap.get(paneId).lines.push(lineWithId);
        }
      }
    }

    setMainOverlayLines(overlayLines);
    setSubPanes(Array.from(paneMap.values()));
  }, []);

  // ── Rebuild pane data whenever activeIndicators changes ───
  useEffect(() => {
    buildPaneData(activeIndicators);
  }, [activeIndicators, buildPaneData]);

  const indicatorWsSignature = activeIndicators
    .filter((ind) => isWsHostedIndicator(ind) && ind.visible !== false)
    .map((ind) => [
      ind.id,
      getBuiltinIndicatorName(ind),
      ind.script?.startsWith(ENGINE_SCRIPT_MARKER) ? ind.script.split("\n")[0] : "",
      isBuiltinIndicator(ind) ? "builtin" : "script",
      stringSignature(ind.script || ""),
      ind.securityMode || "",
      JSON.stringify(ind.params || {}),
    ].join(":"))
    .join("|");
  const chartHistoryFirstTime = chartData?.[0]?.time ?? null;
  const hasWsHostedIndicators = activeIndicators.some(
    (ind) => isWsHostedIndicator(ind) && ind.visible !== false
  );
  const chartDataReady = Boolean(chartData?.length);

  const buildHostedIndicatorParams = useCallback((ind) => {
    let params = ind.params || {};
    const curUpColor = candleUpColorRef.current;
    const curDownColor = candleDownColorRef.current;
    if ((ind.id === "vol" || ind.engineName === "VOL") && (curUpColor || curDownColor)) {
      params = {
        ...params,
        up_color: curUpColor || params.up_color || "#22c55e",
        down_color: curDownColor || params.down_color || "#ef4444",
      };
    }
    return params;
  }, []);

  const buildHostedSubscriptionMessage = useCallback((ind) => {
    const builtin = isBuiltinIndicator(ind);
    const historyLimit = Math.min(
      Math.max(chartDataRef.current?.length || 0, 1),
      INDICATOR_WS_INITIAL_HISTORY_LIMIT,
    );
    return {
      action: "subscribe",
      clientId: ind.id,
      kind: builtin ? "builtin" : "script",
      exchange,
      marketType,
      symbol,
      interval,
      name: builtin ? getBuiltinIndicatorName(ind) : undefined,
      displayName: ind.name || ind.id,
      customId: !builtin ? ind.id : undefined,
      script: builtin ? undefined : ind.script,
      securityMode: builtin ? undefined : ind.securityMode,
      params: buildHostedIndicatorParams(ind),
      historyLimit,
    };
  }, [buildHostedIndicatorParams, exchange, interval, marketType, symbol]);

  const hostedSubscriptionSignature = useCallback((ind) => {
    const message = buildHostedSubscriptionMessage(ind);
    return JSON.stringify({
      kind: message.kind,
      exchange: message.exchange,
      marketType: message.marketType,
      symbol: message.symbol,
      interval: message.interval,
      name: message.name || "",
      scriptHash: stringSignature(message.script || ""),
      securityMode: message.securityMode || "",
      params: message.params || {},
      historyLimit: message.historyLimit,
    });
  }, [buildHostedSubscriptionMessage]);

  const syncHostedSubscriptions = useCallback((force = false) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    const hostedIndicators = activeIndicatorsRef.current.filter(
      (ind) => isWsHostedIndicator(ind) && ind.visible !== false
    );
    const nextIds = new Set();

    for (const ind of hostedIndicators) {
      nextIds.add(ind.id);
      const signature = hostedSubscriptionSignature(ind);
      if (!force && indicatorWsSubscriptionsRef.current.get(ind.id) === signature) {
        continue;
      }
      socket.send(JSON.stringify(buildHostedSubscriptionMessage(ind)));
      indicatorWsSubscriptionsRef.current.set(ind.id, signature);
    }

    for (const clientId of Array.from(indicatorWsSubscriptionsRef.current.keys())) {
      if (nextIds.has(clientId)) continue;
      socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
      indicatorWsSubscriptionsRef.current.delete(clientId);
    }

    return true;
  }, [buildHostedSubscriptionMessage, hostedSubscriptionSignature]);

  syncHostedSubscriptionsRef.current = syncHostedSubscriptions;

  // ── Backend-hosted indicators: builtin incremental + Pyne snapshot WS ──
  useEffect(() => {
    const wsSubscriptions = indicatorWsSubscriptionsRef.current;
    if (!symbol || !interval || !hasWsHostedIndicators || !chartDataReady) {
      if (indicatorWsRef.current) {
        try { indicatorWsRef.current.close(); } catch { /* ignore */ }
        indicatorWsRef.current = null;
        wsSubscriptions.clear();
      }
      return;
    }

    let stopped = false;
    let socket = null;
    let reconnectTimer = null;
    let lastSeq = 0;
    let gapResubscribeTimer = null;

    const subscribeAll = () => {
      syncHostedSubscriptionsRef.current(true);
    };

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(getIndicatorStreamUrl());
      indicatorWsRef.current = socket;

      socket.onopen = () => {
        lastSeq = 0;
        wsSubscriptions.clear();
        if (!stopped) subscribeAll();
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (Number.isFinite(msg.seq)) {
            if (lastSeq > 0 && msg.seq !== lastSeq + 1 && !gapResubscribeTimer) {
              console.warn(`Indicator WS sequence gap: expected ${lastSeq + 1}, got ${msg.seq}`);
              gapResubscribeTimer = setTimeout(() => {
                gapResubscribeTimer = null;
                subscribeAll();
              }, 100);
            }
            lastSeq = msg.seq;
          }
          if (msg.type === "heartbeat" || msg.type === "connected") return;
          if (!msg.clientId) return;
          if (msg.type === "indicator.snapshot") {
            applyWsSnapshot(msg.clientId, msg);
          } else if (msg.type === "indicator.patch") {
            applyWsPatch(msg.clientId, msg);
          } else if (msg.type === "indicator.preview" || msg.type === "indicator.update") {
            applyWsValues(msg.clientId, msg.values || {}, msg.barTime);
          } else if (msg.type === "indicator.error" || msg.type === "error") {
            setIndicatorError(msg.clientId, formatIndicatorError(msg, "Indicator WS error"));
          }
        } catch (err) {
          console.warn("Indicator WS message parse failed:", err);
        }
      };

      socket.onclose = () => {
        if (indicatorWsRef.current === socket) {
          indicatorWsRef.current = null;
          wsSubscriptions.clear();
        }
        if (!stopped) {
          reconnectTimer = setTimeout(connect, INDICATOR_WS_RECONNECT_MS);
        }
      };

      socket.onerror = () => {
        try { socket.close(); } catch { /* ignore */ }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (gapResubscribeTimer) clearTimeout(gapResubscribeTimer);
      if (socket) {
        try { socket.close(); } catch { /* ignore */ }
      }
      if (indicatorWsRef.current === socket) {
        indicatorWsRef.current = null;
        wsSubscriptions.clear();
      }
    };
  }, [
    applyWsSnapshot,
    applyWsPatch,
    applyWsValues,
    chartDataReady,
    exchange,
    hasWsHostedIndicators,
    interval,
    marketType,
    setIndicatorError,
    symbol,
  ]);

  useEffect(() => {
    if (!hasWsHostedIndicators || !chartDataReady) return;
    syncHostedSubscriptions(false);
  }, [
    candleDownColor,
    candleUpColor,
    chartDataReady,
    chartHistoryFirstTime,
    hasWsHostedIndicators,
    indicatorWsSignature,
    syncHostedSubscriptions,
  ]);

  // ── Compute all active indicators ─────────────────────────
  const computeAll = useCallback(async (force = false) => {
    if (computingRef.current) {
      queuedRecomputeRef.current = true;
      queuedForceRecomputeRef.current = queuedForceRecomputeRef.current || force;
      return;
    }
    computingRef.current = true;

    const currentChartData = chartDataRef.current;
    const currentIndicators = activeIndicatorsRef.current;

    if (!currentChartData || currentChartData.length === 0) {
      computingRef.current = false;
      return;
    }

    const dataSignature = buildDataSignature(currentChartData);
    if (!force && dataSignature === lastComputeSignatureRef.current) {
      computingRef.current = false;
      return;
    }
    lastComputeSignatureRef.current = dataSignature;

    const indicators = currentIndicators.filter(
      (i) => !isWsHostedIndicator(i) && (i.script || i.name || i.id)
    );
    if (indicators.length === 0) {
      computingRef.current = false;
      return;
    }

    // Only show "computing" UI when user manually triggered the recompute
    const showUI = userTriggeredRef.current;
    if (showUI) setComputing(true);

    const ohlcv = currentChartData.map((d) => ({
      time: d.time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume || 0,
    }));

    try {
      const results = await Promise.allSettled(
        indicators.map(async (ind) => {
          try {
            // For VOL indicator, inject K-line colors so volume bars follow candlestick colors
            let computeParams = ind.params || {};
            const curUpColor = candleUpColorRef.current;
            const curDownColor = candleDownColorRef.current;
            if ((ind.id === "vol" || ind.engineName === "VOL") && (curUpColor || curDownColor)) {
              computeParams = {
                ...computeParams,
                up_color: curUpColor || computeParams.up_color || "#22c55e",
                down_color: curDownColor || computeParams.down_color || "#ef4444",
              };
            }
            const isEngineBackedScript =
              typeof ind.script === "string" && ind.script.startsWith(ENGINE_SCRIPT_MARKER);
            const result = await computeIndicator({
              mode: ind.engineName || isEngineBackedScript ? "builtin" : "script",
              securityMode: ind.securityMode,
              name: ind.engineName || undefined,
              script: ind.script,
              ohlcv,
              params: computeParams,
              exchange,
              symbol,
              interval,
              marketType,
            });
            return { id: ind.id, result, visible: ind.visible };
          } catch (err) {
            return { id: ind.id, result: { ok: false, error: err.message, lines: [] }, visible: ind.visible };
          }
        })
      );

      const processedResults = [];
      // Collect extended outputs across all indicators
      const allMarkers = [];
      const allFills = [];
      const allHlines = [];
      const allBgcolors = [];
      const allBarcolors = [];
      const allSignals = [];
      const newParamSchemas = {};

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const { id, result, visible } = r.value;
        const isOk = result.ok === true
          || (result.ok == null && (
            (result.lines && result.lines.length > 0)
            || (result.series && result.series.length > 0)
          ));
        if (isOk) {
          const normalized = normalizeIndicatorPayload(result, id);
          const mappedLines = normalized.lines;
          processedResults.push({ id, mappedLines, visible, error: null });

          // Collect extended output types (only from visible indicators)
          if (visible) {
            allMarkers.push(...normalized.markers);
            allFills.push(...normalized.fills);
            allHlines.push(...normalized.hlines);
            allBgcolors.push(...normalized.bgcolors);
            allBarcolors.push(...normalized.barcolors);
            allSignals.push(...normalized.signals);
          }

          // Collect param schemas
          if (result.param_schema && result.param_schema.length > 0) {
            newParamSchemas[id] = normalizeParamSchema(result.param_schema);
          }
        } else {
          processedResults.push({
            id,
            mappedLines: [],
            visible,
            error: formatIndicatorError(result, "Unknown error"),
          });
        }
      }

      // Update extended output states
      const processedIds = new Set(processedResults.map((item) => item.id));
      setMarkers((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allMarkers,
      ]);
      setFills((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allFills,
      ]);
      setHlines((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allHlines,
      ]);
      setBgcolors((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allBgcolors,
      ]);
      setBarcolors((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allBarcolors,
      ]);
      setSignals((prev) => [
        ...prev.filter((item) => !processedIds.has(item.indicatorId)),
        ...allSignals,
      ]);
      if (Object.keys(newParamSchemas).length > 0) {
        setParamSchemas((prev) => ({ ...prev, ...newParamSchemas }));
      }

      // Update state with computed line data
      setActiveIndicators((prev) => {
        const updated = [...prev];
        for (const { id, mappedLines, error } of processedResults) {
          const idx = updated.findIndex((i) => i.id === id);
          if (idx === -1) continue;
          updated[idx] = {
            ...updated[idx],
            lines: mappedLines,
            error,
            ...(newParamSchemas[id] ? { paramSchema: newParamSchemas[id] } : {}),
          };
        }
        return updated;
      });
      // buildPaneData will be called by the useEffect watching activeIndicators
    } finally {
      computingRef.current = false;
      if (showUI) {
        setComputing(false);
        userTriggeredRef.current = false;
      }

      if (queuedRecomputeRef.current) {
        const forceNext = queuedForceRecomputeRef.current;
        queuedRecomputeRef.current = false;
        queuedForceRecomputeRef.current = false;
        queueMicrotask(() => computeAll(forceNext));
      }
    }
  }, [exchange, interval, marketType, symbol]);

  // ── User-triggered recompute (shows "computing" UI) ───────
  const recompute = useCallback((force = true) => {
    userTriggeredRef.current = true;
    lastComputeSignatureRef.current = "";  // force fresh compute
    syncHostedSubscriptionsRef.current(true);
    computeAll(force);
  }, [computeAll]);

  const requestIndicatorRange = useCallback((start, end) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const startSec = Math.floor(Number(start));
    const endSec = Math.floor(Number(end));
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0 || startSec > endSec) {
      return false;
    }

    const hostedIndicators = activeIndicatorsRef.current.filter(
      (ind) => isWsHostedIndicator(ind) && ind.visible !== false
    );
    for (const ind of hostedIndicators) {
      try {
        socket.send(JSON.stringify({
          action: "load_range",
          clientId: ind.id,
          start: startSec,
          end: endSec,
        }));
      } catch (err) {
        console.warn("Indicator range request failed:", err);
      }
    }
    return hostedIndicators.length > 0;
  }, []);

  // ── Reset compute tracking when dataset changes ──
  const prevDatasetKeyRef = useRef(datasetKey);
  useEffect(() => {
    if (datasetKey !== prevDatasetKeyRef.current) {
      prevDatasetKeyRef.current = datasetKey;
      lastComputeSignatureRef.current = "";
      prevIndicatorSignatureRef.current = "";
      pendingForceComputeRef.current = true;
    }
  }, [datasetKey]);

  // ── Re-compute VOL when candle colors change ──────────────
  const prevCandleColorsRef = useRef(`${candleUpColor}|${candleDownColor}`);
  useEffect(() => {
    const colorKey = `${candleUpColor}|${candleDownColor}`;
    if (colorKey !== prevCandleColorsRef.current) {
      prevCandleColorsRef.current = colorKey;
      // Check if VOL indicator is active before forcing recompute
      const hasVol = activeIndicatorsRef.current.some(
        (i) => i.id === "vol" || i.engineName === "VOL"
      );
      if (hasVol) {
        lastComputeSignatureRef.current = "";
        pendingForceComputeRef.current = true;
        computeAll(true);
      }
    }
  }, [candleUpColor, candleDownColor, computeAll]);

  // ── Trigger compute when indicators are added/changed ─────
  const prevIndicatorSignatureRef = useRef("");

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;

    const signature = activeIndicators
      .map((i) => `${i.id}:${stringSignature(i.script || "")}:${JSON.stringify(i.params || {})}`)
      .join("|");

    const signatureChanged = signature !== prevIndicatorSignatureRef.current;
    if (signatureChanged) {
      prevIndicatorSignatureRef.current = signature;
      pendingForceComputeRef.current = true;
    }

    const forceNow = pendingForceComputeRef.current;
    const dataChanged = buildDataSignature(chartData) !== lastComputeSignatureRef.current;
    if (!forceNow && !dataChanged) return;

    if (forceNow) {
      pendingForceComputeRef.current = false;
    }

    let fired = false;
    // Use minimal delay: force recompute fires nearly immediately,
    // data-only changes use a longer debounce to batch rapid real-time ticks
    // and avoid triggering indicator series rebuilds on every WS message.
    const timer = setTimeout(() => {
      fired = true;
      computeAll(forceNow);
    }, forceNow ? 0 : 500);
    return () => {
      clearTimeout(timer);
      if (forceNow && !fired) {
        pendingForceComputeRef.current = true;
      }
    };
  }, [chartData, activeIndicators, computeAll]);

  // ── Re-compute when chart is recreated ─────────────────────
  useEffect(() => {
    if (seriesReady === 0) return;
    lastComputeSignatureRef.current = "";
    prevIndicatorSignatureRef.current = "";
    pendingForceComputeRef.current = true;

    const currentIndicators = activeIndicatorsRef.current;
    const currentChartData = chartDataRef.current;

    if (currentIndicators.length > 0 && currentChartData?.length > 0) {
      const timer = setTimeout(() => computeAll(true), 50);
      return () => clearTimeout(timer);
    }
  }, [seriesReady, computeAll]);

  return {
    activeIndicators,
    computing,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    computeAll,
    recompute,
    requestIndicatorRange,
    // Multi-pane output
    mainOverlayLines,
    subPanes,
    // Extended output types (Pyne drawing API)
    markers,
    fills,
    hlines,
    bgcolors,
    barcolors,
    signals,
    paramSchemas,
  };
}
