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
import { computeIndicator, fetchPreset } from "../services/indicatorApi";

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const VOL_INIT_KEY = "candlescope-vol-initialized";

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

/**
 * @param {object} opts
 * @param {React.MutableRefObject} opts.chartRef        — ref-to-ref to main chart instance (for legacy compat)
 * @param {React.MutableRefObject} opts.seriesRef       — ref-to-ref to the candlestick series (for legacy compat)
 * @param {Array}                  opts.chartData       — current OHLCV data array
 * @param {string}                 opts.datasetKey      — changes when chart is recreated
 * @param {number}                 opts.seriesReady     — increments when chart series is ready
 */
export function useIndicators({ chartRef, seriesRef, chartData, datasetKey, seriesReady }) {
  // Active indicators: [{id, name, script, params, visible, lines: [...computedLines]}]
  const [activeIndicators, setActiveIndicators] = useState(loadActiveIndicators);
  const [computing, setComputing] = useState(false);

  // Structured output for multi-pane rendering
  const [mainOverlayLines, setMainOverlayLines] = useState([]);
  const [subPanes, setSubPanes] = useState([]);

  const lastComputeSignatureRef = useRef("");
  const queuedRecomputeRef = useRef(false);
  const queuedForceRecomputeRef = useRef(false);

  // Keep refs to always-latest values
  const activeIndicatorsRef = useRef(activeIndicators);
  activeIndicatorsRef.current = activeIndicators;
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;

  // Flag for forced compute
  const pendingForceComputeRef = useRef(false);
  const volInitRef = useRef(false);
  const computingRef = useRef(false);

  // Persist active indicators to localStorage
  useEffect(() => {
    const toSave = activeIndicators.map(({ lines, error, ...rest }) => rest);
    saveActiveIndicators(toSave);
  }, [activeIndicators]);

  // ── Auto-add "vol" indicator on first-ever load ───────────
  useEffect(() => {
    if (volInitRef.current) return;
    volInitRef.current = true;

    const current = loadActiveIndicators();
    if (current.some((i) => i.id === "vol")) return;

    const wasInit = localStorage.getItem(VOL_INIT_KEY);
    if (wasInit) return;

    localStorage.setItem(VOL_INIT_KEY, "1");
    fetchPreset("vol")
      .then((full) => {
        if (!full) return;
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

        if (pane === "main") {
          // Overlay on main chart
          overlayLines.push(line);
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
          paneMap.get(paneId).lines.push(line);
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

    const indicators = currentIndicators.filter((i) => i.script || i.name || i.id);
    if (indicators.length === 0) {
      computingRef.current = false;
      return;
    }

    setComputing(true);

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
            const result = await computeIndicator({
              name: ind.engineName || undefined,
              script: ind.script,
              ohlcv,
              params: ind.params || {},
            });
            return { id: ind.id, result, visible: ind.visible };
          } catch (err) {
            return { id: ind.id, result: { ok: false, error: err.message, lines: [] }, visible: ind.visible };
          }
        })
      );

      const processedResults = [];
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const { id, result, visible } = r.value;
        const isOk = result.ok === true || (result.ok == null && result.lines && result.lines.length > 0);
        if (isOk) {
          const mappedLines = (result.lines || []).map((line) => {
            const displayName = line.name || line.title || "";
            return {
              ...line,
              name: displayName,
              title: displayName,
              color: line.color || "#f59e0b",
              lineWidth: line.lineWidth || 2,
              lineStyle: line.lineStyle || 0,
              type: line.type || "line",
              overlay: line.pane !== "separate" && line.pane !== "volume",
              pane: line.pane || "main",
              colorData: line.colorData || null,
            };
          });
          processedResults.push({ id, mappedLines, visible, error: null });
        } else {
          processedResults.push({ id, mappedLines: [], visible, error: result.error || "Unknown error" });
        }
      }

      // Update state with computed line data
      setActiveIndicators((prev) => {
        const updated = [...prev];
        for (const { id, mappedLines, error } of processedResults) {
          const idx = updated.findIndex((i) => i.id === id);
          if (idx === -1) continue;
          updated[idx] = { ...updated[idx], lines: mappedLines, error };
        }
        return updated;
      });
      // buildPaneData will be called by the useEffect watching activeIndicators
    } finally {
      computingRef.current = false;
      setComputing(false);

      if (queuedRecomputeRef.current) {
        const forceNext = queuedForceRecomputeRef.current;
        queuedRecomputeRef.current = false;
        queuedForceRecomputeRef.current = false;
        queueMicrotask(() => computeAll(forceNext));
      }
    }
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

  // ── Trigger compute when indicators are added/changed ─────
  const prevIndicatorSignatureRef = useRef("");

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;

    const signature = activeIndicators
      .map((i) => `${i.id}:${i.script ? i.script.length : 0}:${JSON.stringify(i.params || {})}`)
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
    // data-only changes use a short debounce to batch rapid ticks.
    const timer = setTimeout(() => {
      fired = true;
      computeAll(forceNow);
    }, forceNow ? 0 : 30);
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
    // Multi-pane output
    mainOverlayLines,
    subPanes,
  };
}
