/**
 * useIndicators 鈥?manages active indicators, computation, and multi-pane line data.
 *
 * **Multi-pane architecture (v2):**
 * Instead of adding series directly to a single chart, this hook now computes
 * indicator data and outputs structured pane information:
 *   - `mainOverlayLines` 鈥?line data for the main chart (overlay indicators)
 *   - `subPanes`         鈥?array of {id, label, lines} for separate/volume panes
 *
 * The MultiPaneChart component uses this data to create independent chart instances
 * per pane, each with its own price scale and auto-scaling.
 *
 * Volume is auto-added as a built-in indicator on first load.
 */
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  buildRuntimeDataSignature,
  formatIndicatorError,
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
  mergeIndicatorItems,
  mergeIndicatorLines,
  normalizeIndicatorPayload,
  normalizeParamSchema,
  resolveWsValue,
  upsertLinePoint,
} from "../runtime/indicators/indicatorPayloadRuntime";
import {
  buildCandleColorKey,
  buildIndicatorComputeParams,
  buildIndicatorMutationSignature,
  buildIndicatorOhlcv,
  collectIndicatorComputeResults,
  hasVolumeIndicator,
  resolveIndicatorComputeDelay,
  resolveSeriesReadyComputeDelay,
  shouldDeferIndicatorCompute,
} from "../runtime/indicators/indicatorComputeRuntime";
import { buildIndicatorPaneData } from "../runtime/indicators/indicatorPaneRuntime";
import {
  buildHostedRangeMessage,
  buildHostedSubscriptionMessage,
  buildHostedSubscriptionSignature,
  buildIndicatorRangeRequest,
  buildIndicatorWsSignature,
  dispatchIndicatorWsMessage,
  getVisibleHostedIndicators,
  parseIndicatorWsMessage,
  resolveIndicatorWsSequenceState,
} from "../runtime/indicators/indicatorWsRuntime";
import { markPerf, recordPerfEvent } from "../runtime/performance/perfMarks";
import { useActiveIndicators } from "../runtime/indicators/useActiveIndicators";
import { computeIndicator, getIndicatorStreamUrl } from "../services/indicatorApi";

const INDICATOR_WS_RECONNECT_MS = 3000;
/**
 * @param {object} opts
 * @param {Array}                  opts.chartData       鈥?current OHLCV data array
 * @param {object}                 [opts.chartDataMeta] 鈥?chart data version/status/coverage
 * @param {string}                 opts.datasetKey      鈥?changes when chart is recreated
 * @param {number}                 opts.seriesReady     鈥?increments when chart series is ready
 * @param {string}                 [opts.candleUpColor]   鈥?K-line up color (synced to VOL indicator)
 * @param {string}                 [opts.candleDownColor] 鈥?K-line down color (synced to VOL indicator)
 */
export function useIndicators({
  chartData,
  chartDataMeta = null,
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
  const pendingForceComputeRef = useRef(false);
  const requireIndicatorCompute = useCallback(() => {
    pendingForceComputeRef.current = true;
  }, []);
  const {
    activeIndicators,
    setActiveIndicators,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  } = useActiveIndicators({ onRequireCompute: requireIndicatorCompute });
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
  const [paramSchemas, setParamSchemas] = useState({}); // indicatorId 鈫?param_schema[]
  const lastComputeSignatureRef = useRef("");
  const queuedRecomputeRef = useRef(false);
  const queuedForceRecomputeRef = useRef(false);

  // Keep refs to always-latest values
  const activeIndicatorsRef = useRef(activeIndicators);
  activeIndicatorsRef.current = activeIndicators;
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;
  const chartDataMetaRef = useRef(chartDataMeta);
  chartDataMetaRef.current = chartDataMeta;
  const candleUpColorRef = useRef(candleUpColor);
  candleUpColorRef.current = candleUpColor;
  const candleDownColorRef = useRef(candleDownColor);
  candleDownColorRef.current = candleDownColor;

  // Flag for forced compute
  const computingRef = useRef(false);
  // Flag: only show "computing" UI when user manually triggers recompute
  const userTriggeredRef = useRef(false);
  const indicatorWsRef = useRef(null);
  const indicatorWsSubscriptionsRef = useRef(new Map());
  const syncHostedSubscriptionsRef = useRef(() => false);

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
  }, [setActiveIndicators]);

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
  }, [setActiveIndicators]);

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
  }, [setActiveIndicators]);

  const setIndicatorError = useCallback((indicatorId, error) => {
    setActiveIndicators((prev) =>
      prev.map((ind) => (ind.id === indicatorId ? { ...ind, error } : ind))
    );
  }, [setActiveIndicators]);

  // 鈹€鈹€ Build pane data from active indicators 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // This is the core of the multi-pane system: we partition computed lines
  // into overlay (main chart) vs separate panes.
  const buildPaneData = useCallback((indicators) => {
    const paneData = buildIndicatorPaneData(indicators);
    setMainOverlayLines(paneData.mainOverlayLines);
    setSubPanes(paneData.subPanes);
  }, []);

  // 鈹€鈹€ Rebuild pane data whenever activeIndicators changes 鈹€鈹€鈹€
  useEffect(() => {
    buildPaneData(activeIndicators);
  }, [activeIndicators, buildPaneData]);

  const indicatorWsSignature = buildIndicatorWsSignature(activeIndicators);
  const chartHistoryFirstTime = chartDataMeta?.firstTime ?? chartData?.[0]?.time ?? null;
  const chartDataVersion = chartDataMeta?.version ?? 0;
  const chartDataStatus = chartDataMeta?.status || "idle";
  const hasWsHostedIndicators = getVisibleHostedIndicators(activeIndicators).length > 0;
  const chartDataReady = Boolean(chartData?.length && chartDataStatus === "ready");

  const getHostedSubscriptionContext = useCallback(() => ({
    candleDownColor: candleDownColorRef.current,
    candleUpColor: candleUpColorRef.current,
    chartData: chartDataRef.current || [],
    chartDataMeta: chartDataMetaRef.current || {},
    chartDataLength: chartDataRef.current?.length || 0,
    exchange,
    interval,
    marketType,
    symbol,
  }), [exchange, interval, marketType, symbol]);

  const buildHostedMessage = useCallback((ind) => {
    return buildHostedSubscriptionMessage(ind, getHostedSubscriptionContext());
  }, [getHostedSubscriptionContext]);

  const hostedSubscriptionSignature = useCallback((ind) => {
    return buildHostedSubscriptionSignature(ind, getHostedSubscriptionContext());
  }, [getHostedSubscriptionContext]);

  const syncHostedSubscriptions = useCallback((force = false) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
    const nextIds = new Set();

    for (const ind of hostedIndicators) {
      nextIds.add(ind.id);
      const signature = hostedSubscriptionSignature(ind);
      if (!force && indicatorWsSubscriptionsRef.current.get(ind.id) === signature) {
        continue;
      }
      socket.send(JSON.stringify(buildHostedMessage(ind)));
      indicatorWsSubscriptionsRef.current.set(ind.id, signature);
    }

    for (const clientId of Array.from(indicatorWsSubscriptionsRef.current.keys())) {
      if (nextIds.has(clientId)) continue;
      socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
      indicatorWsSubscriptionsRef.current.delete(clientId);
    }

    return true;
  }, [buildHostedMessage, hostedSubscriptionSignature]);

  syncHostedSubscriptionsRef.current = syncHostedSubscriptions;

  useEffect(() => {
    setActiveIndicators((prev) =>
      prev.map((indicator) => ({
        ...indicator,
        lines: [],
        error: null,
      }))
    );
    setMainOverlayLines([]);
    setSubPanes([]);
    setMarkers([]);
    setFills([]);
    setHlines([]);
    setBgcolors([]);
    setBarcolors([]);
    setSignals([]);
  }, [exchange, marketType, setActiveIndicators, symbol, interval]);

  // 鈹€鈹€ Backend-hosted indicators: builtin incremental + Pyne snapshot WS 鈹€鈹€
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
        markPerf("indicator.ws.open", { symbol, interval, marketType, exchange });
        lastSeq = 0;
        wsSubscriptions.clear();
        if (!stopped) subscribeAll();
      };

      socket.onmessage = (event) => {
        try {
          const msg = parseIndicatorWsMessage(event.data);
          const seqState = resolveIndicatorWsSequenceState(msg, lastSeq);
          if (seqState.hasGap && !gapResubscribeTimer) {
              console.warn(`Indicator WS sequence gap: expected ${seqState.expectedSeq}, got ${seqState.actualSeq}`);
              gapResubscribeTimer = setTimeout(() => {
                gapResubscribeTimer = null;
                subscribeAll();
              }, 100);
          }
          lastSeq = seqState.nextSeq;
          dispatchIndicatorWsMessage(msg, {
            onSnapshot: (indicatorId, payload) => {
              markPerf("indicator.ws.snapshot", { indicatorId });
              applyWsSnapshot(indicatorId, payload);
            },
            onPatch: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.patch", { indicatorId });
              applyWsPatch(indicatorId, payload);
            },
            onValues: applyWsValues,
            onError: (indicatorId, payload) => {
              setIndicatorError(indicatorId, formatIndicatorError(payload, "Indicator WS error"));
            },
          });
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
    chartDataStatus,
    chartDataVersion,
    chartHistoryFirstTime,
    hasWsHostedIndicators,
    indicatorWsSignature,
    syncHostedSubscriptions,
  ]);

  // 鈹€鈹€ Compute all active indicators 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      recordPerfEvent("indicator.compute.skip", { reason: "no-chart-data" });
      computingRef.current = false;
      return;
    }

    const dataSignature = buildRuntimeDataSignature(currentChartData, chartDataMetaRef.current);
    if (!force && dataSignature === lastComputeSignatureRef.current) {
      recordPerfEvent("indicator.compute.skip", { reason: "same-data-signature" });
      computingRef.current = false;
      return;
    }
    lastComputeSignatureRef.current = dataSignature;

    const indicators = currentIndicators.filter(
      (i) => !isWsHostedIndicator(i) && (i.script || i.name || i.id)
    );
    if (indicators.length === 0) {
      recordPerfEvent("indicator.compute.skip", { reason: "no-local-indicators" });
      computingRef.current = false;
      return;
    }

    // Only show "computing" UI when user manually triggered the recompute
    const showUI = userTriggeredRef.current;
    if (showUI) setComputing(true);
    markPerf("indicator.compute.start", {
      force,
      indicatorCount: indicators.length,
      bars: currentChartData.length,
      symbol,
      interval,
      marketType,
      exchange,
    });

    const ohlcv = buildIndicatorOhlcv(currentChartData);

    try {
      const results = await Promise.allSettled(
        indicators.map(async (ind) => {
          try {
            const computeParams = buildIndicatorComputeParams(ind, {
              candleUpColor: candleUpColorRef.current,
              candleDownColor: candleDownColorRef.current,
            });
            const builtin = isBuiltinIndicator(ind);
            const result = await computeIndicator({
              mode: builtin ? "builtin" : "script",
              securityMode: ind.securityMode,
              name: builtin ? getBuiltinIndicatorName(ind) : undefined,
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

      const {
        processedResults,
        allMarkers,
        allFills,
        allHlines,
        allBgcolors,
        allBarcolors,
        allSignals,
        newParamSchemas,
      } = collectIndicatorComputeResults(results);

      startTransition(() => {
        // Update extended output states as non-urgent work so first K-line paint
        // is not blocked by pane/annotation rebuilds.
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
      });
      // buildPaneData will be called by the useEffect watching activeIndicators
    } finally {
      markPerf("indicator.compute.end", {
        force,
        indicatorCount: indicators.length,
        bars: currentChartData.length,
        symbol,
        interval,
        marketType,
        exchange,
      });
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
  }, [exchange, interval, marketType, setActiveIndicators, symbol]);

  // 鈹€鈹€ User-triggered recompute (shows "computing" UI) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const recompute = useCallback((force = true) => {
    userTriggeredRef.current = true;
    lastComputeSignatureRef.current = "";  // force fresh compute
    syncHostedSubscriptionsRef.current(true);
    computeAll(force);
  }, [computeAll]);

  const requestIndicatorRange = useCallback((start, end) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const range = buildIndicatorRangeRequest(start, end);
    if (!range) return false;

    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
    for (const ind of hostedIndicators) {
      try {
        socket.send(JSON.stringify(buildHostedRangeMessage(ind.id, range)));
      } catch (err) {
        console.warn("Indicator range request failed:", err);
      }
    }
    return hostedIndicators.length > 0;
  }, []);

  // 鈹€鈹€ Reset compute tracking when dataset changes 鈹€鈹€
  const prevDatasetKeyRef = useRef(datasetKey);
  useEffect(() => {
    if (datasetKey !== prevDatasetKeyRef.current) {
      prevDatasetKeyRef.current = datasetKey;
      lastComputeSignatureRef.current = "";
      prevIndicatorSignatureRef.current = "";
      pendingForceComputeRef.current = true;
    }
  }, [datasetKey]);

  // 鈹€鈹€ Re-compute VOL when candle colors change 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const prevCandleColorsRef = useRef(buildCandleColorKey(candleUpColor, candleDownColor));
  useEffect(() => {
    const colorKey = buildCandleColorKey(candleUpColor, candleDownColor);
    if (colorKey !== prevCandleColorsRef.current) {
      prevCandleColorsRef.current = colorKey;
      // Check if VOL indicator is active before forcing recompute
      if (hasVolumeIndicator(activeIndicatorsRef.current)) {
        lastComputeSignatureRef.current = "";
        pendingForceComputeRef.current = true;
        computeAll(true);
      }
    }
  }, [candleUpColor, candleDownColor, computeAll]);

  // 鈹€鈹€ Trigger compute when indicators are added/changed 鈹€鈹€鈹€鈹€鈹€
  const prevIndicatorSignatureRef = useRef("");

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;

    const signature = buildIndicatorMutationSignature(activeIndicators);

    const signatureChanged = signature !== prevIndicatorSignatureRef.current;
    if (signatureChanged) {
      prevIndicatorSignatureRef.current = signature;
      pendingForceComputeRef.current = true;
    }

    const forceNow = pendingForceComputeRef.current;
    const dataChanged = buildRuntimeDataSignature(chartData, chartDataMeta) !== lastComputeSignatureRef.current;
    if (!forceNow && !dataChanged) return;

    if (forceNow) {
      pendingForceComputeRef.current = false;
    }

    let fired = false;
    const delayMs = resolveIndicatorComputeDelay({ chartDataMeta, force: forceNow });
    if (shouldDeferIndicatorCompute(chartDataMeta)) {
      recordPerfEvent("indicator.compute.deferred", {
        reason: "provisional-chart-data",
        force: forceNow,
        bars: chartData.length,
      });
    }
    // Use minimal delay: force recompute fires nearly immediately,
    // data-only changes use a longer debounce to batch rapid real-time ticks
    // and avoid triggering indicator series rebuilds on every WS message.
    // Provisional first bars are deliberately delayed so the full history
    // response can win and avoid a duplicate first-screen indicator compute.
    const timer = setTimeout(() => {
      fired = true;
      computeAll(forceNow);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      if (forceNow && !fired) {
        pendingForceComputeRef.current = true;
      }
    };
  }, [chartData, chartDataMeta, activeIndicators, computeAll]);

  // 鈹€鈹€ Re-compute when chart is recreated 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  useEffect(() => {
    if (seriesReady === 0) return;
    lastComputeSignatureRef.current = "";
    prevIndicatorSignatureRef.current = "";
    pendingForceComputeRef.current = true;

    const currentIndicators = activeIndicatorsRef.current;
    const currentChartData = chartDataRef.current;
    const currentMeta = chartDataMetaRef.current;

    if (currentIndicators.length > 0 && currentChartData?.length > 0) {
      const delayMs = resolveSeriesReadyComputeDelay(currentMeta);
      const timer = setTimeout(() => computeAll(true), delayMs);
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
