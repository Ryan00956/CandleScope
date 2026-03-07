/**
 * useIndicators — manages active indicators, computation, and line series on the chart.
 *
 * Each active indicator gets its own LineSeries / HistogramSeries (or multiple) on the chart.
 * Volume is now a built-in indicator (id="vol") that is auto-added on first load.
 * Each separate-pane indicator gets its own price scale with visible axis labels.
 * Recomputes automatically when chartData changes or indicators are added/removed.
 *
 * NOTE: chartRef / seriesRef are "ref-to-ref" — i.e. chartRef.current is itself
 * a React ref whose .current holds the live lightweight-charts instance.  This
 * guarantees the indicator system always reads the exact same chart object that
 * ChartWidget is using, even after chart recreation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LineSeries, HistogramSeries } from "lightweight-charts";
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

/**
 * Safely dereference a "ref-to-ref" to get the live chart / series instance.
 * Handles both patterns:
 *   - ref-to-ref:  outerRef.current is a React ref → outerRef.current.current
 *   - plain ref:   outerRef.current is the object itself (legacy)
 *
 * We detect a React ref by checking if the object is a plain wrapper with
 * only a `current` property (Object.keys length ≤ 1) and not a complex
 * chart/DOM object.
 */
function deref(outerRef) {
  const inner = outerRef?.current;
  if (!inner) return null;
  // A React ref is a plain object like { current: <value> }.
  // Chart instances, DOM nodes, and series objects have many own properties
  // or are instances of specific classes — they won't match this check.
  if (
    inner &&
    typeof inner === "object" &&
    "current" in inner &&
    Object.getPrototypeOf(inner) === Object.prototype
  ) {
    return inner.current;
  }
  return inner;
}

/**
 * Calculate scaleMargins for each separate pane so they don't overlap.
 * The main chart area occupies the top portion, and separate panes
 * (volume + each separate indicator) are stacked below.
 *
 * @param {number} totalSeparatePanes - total number of separate panes (volume counts as 1)
 * @param {number} paneIndex - 0-based index of this pane among separate panes
 * @returns {{ top: number, bottom: number }}
 */
function calculatePaneMargins(totalSeparatePanes, paneIndex) {
  // Reserve the top portion for the main chart (candlesticks + overlay indicators)
  const mainChartRatio = 0.65; // main chart gets 65% of height
  const separateAreaRatio = 1 - mainChartRatio; // 35% for all separate panes
  const gap = 0.008; // small gap between panes
  const totalGaps = Math.max(0, totalSeparatePanes - 1) * gap;
  const usableArea = separateAreaRatio - totalGaps;
  const paneHeight = usableArea / totalSeparatePanes;

  const top = mainChartRatio + paneIndex * (paneHeight + gap);
  const bottom = 1 - top - paneHeight;

  return {
    top: Math.min(Math.max(top, 0), 0.95),
    bottom: Math.min(Math.max(bottom, 0.01), 0.95),
  };
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
 * @param {React.MutableRefObject} opts.chartRef        — ref-to-ref to lightweight-charts chart instance
 * @param {React.MutableRefObject} opts.seriesRef       — ref-to-ref to the candlestick series
 * @param {Array}                  opts.chartData       — current OHLCV data array
 * @param {string}                 opts.datasetKey      — changes when chart is recreated
 * @param {number}                 opts.seriesReady     — increments when chart series is ready
 */
export function useIndicators({ chartRef, seriesRef, chartData, datasetKey, seriesReady }) {
  // Active indicators: [{id, name, script, params, visible, lines: [...computedLines]}]
  const [activeIndicators, setActiveIndicators] = useState(loadActiveIndicators);
  const [computing, setComputing] = useState(false);

  // Map: indicatorId -> [series instances on the chart]
  const lineSeriesMapRef = useRef(new Map());
  const lastComputeSignatureRef = useRef("");
  const queuedRecomputeRef = useRef(false);
  const queuedForceRecomputeRef = useRef(false);

  // Keep a ref to activeIndicators so computeAll always sees the latest
  const activeIndicatorsRef = useRef(activeIndicators);
  activeIndicatorsRef.current = activeIndicators;

  // Keep a ref to chartData so computeAll always sees the latest
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;

  // Flag to indicate a forced compute is pending (survives effect re-runs)
  const pendingForceComputeRef = useRef(false);

  // Flag to prevent double-init of vol indicator
  const volInitRef = useRef(false);

  // Track if computeAll is currently running to prevent overlapping calls
  const computingRef = useRef(false);

  // Persist active indicators to localStorage
  useEffect(() => {
    // Strip computed line data before saving (only save config)
    const toSave = activeIndicators.map(({ lines, error, ...rest }) => rest);
    saveActiveIndicators(toSave);
  }, [activeIndicators]);

  // ── Auto-add "vol" indicator on first-ever load ───────────
  useEffect(() => {
    if (volInitRef.current) return;
    volInitRef.current = true;

    // Check if vol is already in active indicators
    const current = loadActiveIndicators();
    if (current.some((i) => i.id === "vol")) return;

    // Check if we've ever initialized (don't re-add if user explicitly removed it)
    const wasInit = localStorage.getItem(VOL_INIT_KEY);
    if (wasInit) return;

    // First time: fetch vol preset and add it
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
              engineName: full.engineName || null,  // registry key for compute API
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

  // ── Recalculate layout for all separate panes ─────────────
  // Accepts optional explicit indicator list to avoid stale ref issues
  const relayoutPanes = useCallback((explicitIndicators) => {
    const chart = deref(chartRef);
    if (!chart) return;

    const indicators = explicitIndicators || activeIndicatorsRef.current;

    // Collect volume-pane and separate-pane indicator IDs
    let hasVolume = false;
    const separatePaneIds = [];

    for (const ind of indicators) {
      if (!ind.visible) continue;
      if (ind.lines && ind.lines.length > 0) {
        for (const l of ind.lines) {
          if (l.pane === "volume") {
            hasVolume = true;
          } else if (l.pane === "separate") {
            if (!separatePaneIds.includes(ind.id)) {
              separatePaneIds.push(ind.id);
            }
          }
        }
      }
    }

    // Total separate panes: volume (if present) + N separate indicators
    const totalPanes = (hasVolume ? 1 : 0) + separatePaneIds.length;

    if (totalPanes === 0) {
      // No separate panes — main chart gets full height
      try {
        chart.priceScale("right").applyOptions({
          scaleMargins: { top: 0.05, bottom: 0.05 },
          alignLabels: true,
        });
      } catch { /* */ }
      return;
    }

    // Adjust main chart right price scale margins to leave room for separate panes.
    const mainBottom = 1 - 0.65; // leave 35% for separate panes
    try {
      chart.priceScale("right").applyOptions({
        scaleMargins: {
          top: 0.05,
          bottom: mainBottom,
        },
        alignLabels: false,
        entireTextOnly: true,
      });
    } catch { /* */ }

    let paneIdx = 0;

    // Layout volume pane (always pane index 0 if present)
    if (hasVolume) {
      const volMargins = calculatePaneMargins(totalPanes, paneIdx);
      try {
        chart.priceScale("volume").applyOptions({
          scaleMargins: volMargins,
          visible: false, // volume scale doesn't need axis labels
          autoScale: true,
        });
      } catch { /* */ }
      paneIdx++;
    }

    // Layout each separate indicator pane
    separatePaneIds.forEach((indId) => {
      const margins = calculatePaneMargins(totalPanes, paneIdx);
      try {
        chart.priceScale(indId).applyOptions({
          scaleMargins: margins,
          visible: true,
          autoScale: true,
          borderVisible: false,
          alignLabels: false,
          entireTextOnly: true,
          ticksVisible: true,
        });
      } catch { /* */ }
      paneIdx++;
    });
  }, [chartRef]);

  // ── Remove all chart series for a given indicator ─────────
  const removeSeriesFromChart = useCallback((indicatorId) => {
    const chart = deref(chartRef);
    const existing = lineSeriesMapRef.current.get(indicatorId);
    if (chart && existing) {
      existing.forEach((s) => {
        try { chart.removeSeries(s); } catch { /* */ }
      });
    }
    lineSeriesMapRef.current.delete(indicatorId);

    // Hide any price scales created for this indicator
    if (chart) {
      try {
        const scale = chart.priceScale(indicatorId);
        if (scale) scale.applyOptions({ visible: false });
      } catch { /* scale may not exist */ }
      try {
        const overlayScale = chart.priceScale(`indicator-${indicatorId}`);
        if (overlayScale) overlayScale.applyOptions({ visible: false });
      } catch { /* scale may not exist */ }
    }
  }, [chartRef]);

  // ── Add an indicator ──────────────────────────────────────
  const addIndicator = useCallback((indicator) => {
    setActiveIndicators((prev) => {
      // Don't add duplicates
      if (prev.some((i) => i.id === indicator.id)) return prev;
      return [...prev, { ...indicator, visible: true, lines: [] }];
    });
    // Flag for forced compute
    pendingForceComputeRef.current = true;
  }, []);

  // ── Remove an indicator ───────────────────────────────────
  const removeIndicator = useCallback((indicatorId) => {
    // Remove line series and associated price scales from chart
    removeSeriesFromChart(indicatorId);

    setActiveIndicators((prev) => {
      const updated = prev.filter((i) => i.id !== indicatorId);
      // Re-layout after removal — use a microtask to let React process the state update
      // Pass the updated list directly so we don't rely on stale refs
      queueMicrotask(() => relayoutPanes(updated));
      return updated;
    });
  }, [removeSeriesFromChart, relayoutPanes]);

  // ── Toggle visibility ─────────────────────────────────────
  const toggleVisibility = useCallback((indicatorId) => {
    setActiveIndicators((prev) => {
      const updated = prev.map((i) => {
        if (i.id !== indicatorId) return i;
        const newVisible = !i.visible;
        // Show/hide all line series for this indicator
        const existing = lineSeriesMapRef.current.get(indicatorId);
        if (existing) {
          existing.forEach((s) => {
            try { s.applyOptions({ visible: newVisible }); } catch { /* */ }
          });
        }
        return { ...i, visible: newVisible };
      });
      // Re-layout after visibility change with updated list
      queueMicrotask(() => relayoutPanes(updated));
      return updated;
    });
  }, [relayoutPanes]);

  // ── Update indicator params ───────────────────────────────
  const updateIndicatorParams = useCallback((indicatorId, newParams) => {
    setActiveIndicators((prev) =>
      prev.map((i) => (i.id === indicatorId ? { ...i, params: newParams } : i))
    );
    // Flag for forced compute when params change
    pendingForceComputeRef.current = true;
  }, []);

  // ── Update indicator script (for custom editing) ──────────
  const updateIndicatorScript = useCallback((indicatorId, newScript) => {
    setActiveIndicators((prev) =>
      prev.map((i) => (i.id === indicatorId ? { ...i, script: newScript } : i))
    );
    // Flag for forced compute when script changes
    pendingForceComputeRef.current = true;
  }, []);

  // ── Render computed lines onto the chart (synchronous) ────
  const renderLines = useCallback((indicatorId, lines, visible) => {
    const chart = deref(chartRef);
    if (!chart) return;

    // Remove old series for this indicator first
    removeSeriesFromChart(indicatorId);

    if (!lines || lines.length === 0) return;

    const newSeries = [];
    for (const line of lines) {
      if (!line.data || line.data.length === 0) continue;

      // Determine pane placement: overlay (main chart), volume, or separate
      const isVolume = line.pane === "volume";
      const isSeparate = line.pane === "separate";
      const isOverlay = !isVolume && !isSeparate;

      // Volume-pane indicators share the "volume" priceScaleId.
      // Separate-pane indicators use their indicator ID as the priceScaleId.
      // Overlay indicators use a unique hidden scale.
      const priceScaleId = isVolume
        ? "volume"
        : isSeparate
          ? indicatorId
          : `indicator-${indicatorId}`;

      // Choose series type: histogram or line
      const isHistogram = line.type === "histogram";
      const SeriesType = isHistogram ? HistogramSeries : LineSeries;

      const seriesOptions = {
        color: line.color || "#f59e0b",
        lineWidth: isHistogram ? undefined : (line.lineWidth || 2),
        lineStyle: isHistogram ? undefined : (line.lineStyle || 0),
        title: "",              // no title label on chart
        visible: visible,
        priceScaleId,
        lastValueVisible: false,  // no last-value label on price axis
        priceLineVisible: false,  // no horizontal price line
      };

      // For histogram, set priceFormat to volume if it's volume pane
      if (isHistogram && isVolume) {
        seriesOptions.priceFormat = { type: "volume" };
      }

      let series;
      try {
        series = chart.addSeries(SeriesType, seriesOptions);
      } catch (err) {
        console.warn(`Failed to add series for indicator ${indicatorId}:`, err);
        continue;
      }

      if (isVolume) {
        // Volume pane: will be configured by relayoutPanes
      } else if (isOverlay) {
        // Overlay: share the chart area but use an invisible price scale
        try {
          chart.priceScale(priceScaleId).applyOptions({
            visible: false,
            scaleMargins: { top: 0.05, bottom: 0.35 },
          });
        } catch { /* */ }
      } else {
        // Separate pane: set initial margins (refined by relayoutPanes)
        try {
          chart.priceScale(priceScaleId).applyOptions({
            visible: true,
            autoScale: true,
            borderVisible: false,
            alignLabels: false,
            entireTextOnly: true,
            ticksVisible: true,
            scaleMargins: { top: 0.7, bottom: 0.05 },
          });
        } catch { /* */ }
      }

      // Build data — handle per-bar colors for histograms (colorData)
      let validData;
      if (isHistogram && line.colorData && Array.isArray(line.colorData)) {
        // Build a time→color map from colorData
        const colorMap = new Map();
        for (const cd of line.colorData) {
          colorMap.set(cd.time, cd.color);
        }

        validData = line.data
          .filter((d) => d && d.time != null && d.value != null && isFinite(d.value))
          .map((d) => {
            const entry = { time: d.time, value: d.value };
            const barColor = colorMap.get(d.time);
            if (barColor) entry.color = barColor;
            return entry;
          });
      } else {
        validData = line.data.filter(
          (d) => d && d.time != null && d.value != null && isFinite(d.value)
        );
      }

      if (validData.length > 0) {
        try {
          series.setData(validData);
        } catch (err) {
          console.warn(`Failed to set data for indicator ${indicatorId}:`, err);
        }
      }

      newSeries.push(series);
    }
    lineSeriesMapRef.current.set(indicatorId, newSeries);
  }, [chartRef, removeSeriesFromChart]);

  // ── Compute all active indicators ─────────────────────────
  const computeAll = useCallback(async (force = false) => {
    // Prevent overlapping computations — set flag BEFORE any async work
    if (computingRef.current) {
      queuedRecomputeRef.current = true;
      queuedForceRecomputeRef.current = queuedForceRecomputeRef.current || force;
      return;
    }
    computingRef.current = true;

    // Use refs to always get the latest values, avoiding stale closures
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

    // Prepare OHLCV in minimal format
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
              name: ind.engineName || undefined,  // use registry key, not display name
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

      // Pre-process results outside of setState
      const processedResults = [];
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const { id, result, visible } = r.value;
        // Check result.ok — may be true, false, or undefined (network error)
        const isOk = result.ok === true || (result.ok == null && result.lines && result.lines.length > 0);
        if (isOk) {
          // Map backend fields to frontend format
          const mappedLines = (result.lines || []).map((line) => {
            const displayName = line.name || line.title || "";
            return {
              ...line,
              name: displayName,   // keep name field consistent
              title: displayName,  // keep title field consistent
              color: line.color || "#f59e0b",
              lineWidth: line.lineWidth || 2,
              lineStyle: line.lineStyle || 0,
              type: line.type || "line",  // "line" or "histogram"
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

      // Render lines on chart FIRST (before state update to avoid flash)
      for (const { id, mappedLines, visible } of processedResults) {
        renderLines(id, mappedLines, visible);
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

      // Build the updated indicator list for layout calculation
      // We need to use the current ref value merged with processed results
      const currentInds = activeIndicatorsRef.current;
      const updatedForLayout = currentInds.map((ind) => {
        const processed = processedResults.find((r) => r.id === ind.id);
        if (processed) {
          return { ...ind, lines: processed.mappedLines, visible: ind.visible };
        }
        return ind;
      });

      // Re-layout all panes with the correct data immediately
      relayoutPanes(updatedForLayout);
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
  }, [renderLines, relayoutPanes]);

  // ── Reset compute tracking when dataset changes (interval switch) ──
  const prevDatasetKeyRef = useRef(datasetKey);
  useEffect(() => {
    if (datasetKey !== prevDatasetKeyRef.current) {
      prevDatasetKeyRef.current = datasetKey;
      // Reset so next compute isn't skipped due to stale input signature.
      lastComputeSignatureRef.current = "";
      prevIndicatorSignatureRef.current = "";
      pendingForceComputeRef.current = true;
    }
  }, [datasetKey]);

  // ── Trigger compute when indicators are added/changed ─────
  // Track the list of indicator IDs + their scripts/params to detect additions
  const prevIndicatorSignatureRef = useRef("");

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;

    // Build a signature of active indicators to detect when one is added/changed.
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
    const timer = setTimeout(() => {
      fired = true;
      computeAll(forceNow);
    }, forceNow ? 100 : 150);
    return () => {
      clearTimeout(timer);
      if (forceNow && !fired) {
        pendingForceComputeRef.current = true;
      }
    };
  }, [chartData, activeIndicators, computeAll]);

  // ── Re-render when chart is recreated ─────────────────────
  useEffect(() => {
    if (seriesReady === 0) return;
    // Chart was recreated, clear old series refs and re-render
    lineSeriesMapRef.current.clear();
    lastComputeSignatureRef.current = "";
    prevIndicatorSignatureRef.current = ""; // force recompute
    pendingForceComputeRef.current = true;

    const currentIndicators = activeIndicatorsRef.current;
    const currentChartData = chartDataRef.current;

    if (currentIndicators.length > 0 && currentChartData?.length > 0) {
      const timer = setTimeout(() => computeAll(true), 200);
      return () => clearTimeout(timer);
    }
  }, [seriesReady, computeAll]);

  // ── Cleanup on unmount ────────────────────────────────────
  useEffect(() => {
    return () => {
      lineSeriesMapRef.current.clear();
    };
  }, []);

  return {
    activeIndicators,
    computing,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    computeAll,
    relayoutPanes,
  };
}
