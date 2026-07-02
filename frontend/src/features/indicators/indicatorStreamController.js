import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { getIndicatorStreamUrl } from "../../services/indicatorApi";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks";
import {
  buildHostedSubscriptionMessage,
  buildHostedSubscriptionSignature,
  buildIndicatorWsSignature,
  dispatchIndicatorWsMessage,
  getVisibleHostedIndicators,
  parseIndicatorWsMessage,
  resolveIndicatorWsSequenceState,
} from "./indicatorWsRuntime";
import { formatIndicatorError } from "./indicatorPayloadRuntime";

const INDICATOR_WS_RECONNECT_MS = 3000;

export function useIndicatorStreamController({
  activeIndicators,
  activeIndicatorsRef,
  applyWsPatch,
  applyWsReplaceRange,
  applyWsSnapshot,
  applyWsValues,
  candleDownColor,
  candleDownColorRef,
  candleUpColor,
  candleUpColorRef,
  chartData,
  chartDataMeta,
  chartDataMetaRef,
  chartDataReady,
  chartDataRef,
  exchange,
  interval,
  marketType,
  requestIndicatorRange,
  setIndicatorError,
  symbol,
}) {
  const indicatorWsRef = useRef(null);
  const indicatorWsSubscriptionsRef = useRef(new Map());
  const recomputedRangeSignaturesRef = useRef(new Set());
  const syncHostedSubscriptionsRef = useRef(() => false);

  const indicatorWsSignature = buildIndicatorWsSignature(activeIndicators);
  const chartHistoryFirstTime = chartDataMeta?.firstTime ?? chartData?.[0]?.time ?? null;
  const chartDataVersion = chartDataMeta?.version ?? 0;
  const chartDataStatus = chartDataMeta?.status || "idle";
  const hasWsHostedIndicators = getVisibleHostedIndicators(activeIndicators).length > 0;

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
  }), [candleDownColorRef, candleUpColorRef, chartDataMetaRef, chartDataRef, exchange, interval, marketType, symbol]);

  const buildHostedMessage = useCallback((indicator) => {
    return buildHostedSubscriptionMessage(indicator, getHostedSubscriptionContext());
  }, [getHostedSubscriptionContext]);

  const hostedSubscriptionSignature = useCallback((indicator) => {
    return buildHostedSubscriptionSignature(indicator, getHostedSubscriptionContext());
  }, [getHostedSubscriptionContext]);

  const requestRecomputedRange = useCallback((indicatorId, payload) => {
    if (typeof requestIndicatorRange !== "function") return;
    const start = Math.floor(Number(payload?.range?.start));
    const end = Math.floor(Number(payload?.range?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
      return;
    }
    const signature = [
      exchange,
      marketType,
      symbol,
      interval,
      indicatorId,
      start,
      end,
      payload?.timestampMs || "",
    ].join("|");
    if (recomputedRangeSignaturesRef.current.has(signature)) return;
    if (requestIndicatorRange(start, end, "recomputed", { indicatorIds: [indicatorId] })) {
      recomputedRangeSignaturesRef.current.add(signature);
    }
  }, [exchange, interval, marketType, requestIndicatorRange, symbol]);

  const syncHostedSubscriptions = useCallback((force = false) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
    const nextIds = new Set();

    for (const indicator of hostedIndicators) {
      nextIds.add(indicator.id);
      const signature = hostedSubscriptionSignature(indicator);
      if (!force && indicatorWsSubscriptionsRef.current.get(indicator.id) === signature) {
        continue;
      }
      socket.send(JSON.stringify(buildHostedMessage(indicator)));
      indicatorWsSubscriptionsRef.current.set(indicator.id, signature);
    }

    for (const clientId of Array.from(indicatorWsSubscriptionsRef.current.keys())) {
      if (nextIds.has(clientId)) continue;
      socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
      indicatorWsSubscriptionsRef.current.delete(clientId);
    }

    return true;
  }, [activeIndicatorsRef, buildHostedMessage, hostedSubscriptionSignature]);

  useLayoutEffect(() => {
    syncHostedSubscriptionsRef.current = syncHostedSubscriptions;
  }, [syncHostedSubscriptions]);

  useEffect(() => {
    const wsSubscriptions = indicatorWsSubscriptionsRef.current;
    const recomputedSignatures = recomputedRangeSignaturesRef.current;
    if (!symbol || !interval || !hasWsHostedIndicators || !chartDataReady) {
      if (indicatorWsRef.current) {
        try { indicatorWsRef.current.close(); } catch { /* ignore */ }
        indicatorWsRef.current = null;
        wsSubscriptions.clear();
        recomputedSignatures.clear();
      }
      return undefined;
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
          const message = parseIndicatorWsMessage(event.data);
          const seqState = resolveIndicatorWsSequenceState(message, lastSeq);
          if (seqState.hasGap && !gapResubscribeTimer) {
            console.warn(`Indicator WS sequence gap: expected ${seqState.expectedSeq}, got ${seqState.actualSeq}`);
            gapResubscribeTimer = setTimeout(() => {
              gapResubscribeTimer = null;
              subscribeAll();
            }, 100);
          }
          lastSeq = seqState.nextSeq;
          dispatchIndicatorWsMessage(message, {
            onSnapshot: (indicatorId, payload) => {
              markPerf("indicator.ws.snapshot", { indicatorId });
              applyWsSnapshot(indicatorId, payload);
            },
            onPatch: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.patch", { indicatorId });
              applyWsPatch(indicatorId, payload);
            },
            onReplaceRange: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.replace_range", { indicatorId });
              applyWsReplaceRange(indicatorId, payload);
            },
            onRecomputed: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.recomputed", { indicatorId });
              requestRecomputedRange(indicatorId, payload);
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
          recomputedSignatures.clear();
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
        recomputedSignatures.clear();
      }
    };
  }, [
    applyWsPatch,
    applyWsReplaceRange,
    applyWsSnapshot,
    applyWsValues,
    chartDataReady,
    exchange,
    hasWsHostedIndicators,
    interval,
    marketType,
    requestRecomputedRange,
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

  const forceHostedSubscriptions = useCallback(() => {
    syncHostedSubscriptionsRef.current(true);
  }, []);

  return {
    forceHostedSubscriptions,
  };
}
