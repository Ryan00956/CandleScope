import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { getIndicatorStreamUrl } from "../../services/indicatorApi.js";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import {
  buildHostedSubscriptionMessage,
  buildHostedSubscriptionSignature,
  buildIndicatorWsSignature,
  dispatchIndicatorWsMessage,
  getVisibleHostedIndicators,
  parseIndicatorWsMessage,
  resolveIndicatorWsSequenceState,
} from "./indicatorWsRuntime.js";
import { formatIndicatorError } from "./indicatorPayloadRuntime.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IndicatorDefinition,
  IndicatorRecomputedMessage,
  IndicatorSubscribedMessage,
  IndicatorSubscriptionContext,
  IndicatorWsHandlers,
} from "./indicatorTypes.js";

const INDICATOR_WS_RECONNECT_MS = 3000;

export interface UseIndicatorStreamControllerOptions {
  activeIndicators: IndicatorDefinition[];
  activeIndicatorsRef: MutableRefObject<IndicatorDefinition[]>;
  applyWsPatch: NonNullable<IndicatorWsHandlers["onPatch"]>;
  applyWsReplaceRange: NonNullable<IndicatorWsHandlers["onReplaceRange"]>;
  applyWsSnapshot: NonNullable<IndicatorWsHandlers["onSnapshot"]>;
  applyWsValues: NonNullable<IndicatorWsHandlers["onValues"]>;
  candleDownColor: string;
  candleDownColorRef: MutableRefObject<string>;
  candleUpColor: string;
  candleUpColorRef: MutableRefObject<string>;
  chartData: KlineBar[];
  chartDataMeta: ChartDataCommitMeta | null;
  chartDataMetaRef: MutableRefObject<ChartDataCommitMeta | null>;
  chartDataReady: boolean;
  chartDataRef: MutableRefObject<KlineBar[]>;
  exchange: string;
  getIndicatorResumeState?: (
    indicator: IndicatorDefinition,
  ) => Partial<IndicatorSubscriptionContext> | null;
  handleIndicatorRecomputed?: (
    indicatorId: string,
    payload: IndicatorRecomputedMessage,
  ) => void;
  handleIndicatorSubscriptionPending?: (indicatorId: string) => void;
  handleIndicatorSubscribed?: (
    indicatorId: string,
    payload: IndicatorSubscribedMessage,
  ) => void;
  interval: string;
  marketType: string;
  resetHostedSubscriptionReadiness?: () => void;
  setIndicatorError(indicatorId: string, error: string): void;
  symbol: string;
}

export interface IndicatorStreamController {
  forceHostedSubscriptions(): void;
}

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
  getIndicatorResumeState,
  handleIndicatorRecomputed,
  handleIndicatorSubscriptionPending,
  handleIndicatorSubscribed,
  interval,
  marketType,
  resetHostedSubscriptionReadiness,
  setIndicatorError,
  symbol,
}: UseIndicatorStreamControllerOptions): IndicatorStreamController {
  const indicatorWsRef = useRef<WebSocket | null>(null);
  const indicatorWsSubscriptionsRef = useRef<Map<string, string>>(new Map());
  const recomputedRangeSignaturesRef = useRef<Set<string>>(new Set());
  const syncHostedSubscriptionsRef = useRef<(force?: boolean) => boolean>(() => false);

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

  const buildHostedMessage = useCallback((indicator: IndicatorDefinition) => {
    const resumeState = getIndicatorResumeState?.(indicator) || null;
    return buildHostedSubscriptionMessage(indicator, {
      ...getHostedSubscriptionContext(),
      ...(resumeState || {}),
    });
  }, [getHostedSubscriptionContext, getIndicatorResumeState]);

  const hostedSubscriptionSignature = useCallback((indicator: IndicatorDefinition) => {
    return buildHostedSubscriptionSignature(indicator, getHostedSubscriptionContext());
  }, [getHostedSubscriptionContext]);

  const requestRecomputedRange = useCallback((
    indicatorId: string,
    payload: IndicatorRecomputedMessage,
  ) => {
    if (typeof handleIndicatorRecomputed !== "function") return;
    const dirtyRange = payload?.dirtyRange || payload?.dirty_range || payload?.range;
    const start = Math.floor(Number(dirtyRange?.start));
    const end = Math.floor(Number(dirtyRange?.end));
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
      JSON.stringify(payload?.dataRevision || payload?.data_revision || payload?.revision || {}),
    ].join("|");
    if (recomputedRangeSignaturesRef.current.has(signature)) return;
    recomputedRangeSignaturesRef.current.add(signature);
    handleIndicatorRecomputed(indicatorId, payload);
  }, [exchange, handleIndicatorRecomputed, interval, marketType, symbol]);

  const syncHostedSubscriptions = useCallback((force = false) => {
    const socket = indicatorWsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
    const nextIds = new Set<string>();

    for (const indicator of hostedIndicators) {
      nextIds.add(indicator.id);
      const signature = hostedSubscriptionSignature(indicator);
      if (!force && indicatorWsSubscriptionsRef.current.get(indicator.id) === signature) {
        continue;
      }
      handleIndicatorSubscriptionPending?.(indicator.id);
      socket.send(JSON.stringify(buildHostedMessage(indicator)));
      indicatorWsSubscriptionsRef.current.set(indicator.id, signature);
    }

    for (const clientId of Array.from(indicatorWsSubscriptionsRef.current.keys())) {
      if (nextIds.has(clientId)) continue;
      socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
      indicatorWsSubscriptionsRef.current.delete(clientId);
    }

    return true;
  }, [
    activeIndicatorsRef,
    buildHostedMessage,
    handleIndicatorSubscriptionPending,
    hostedSubscriptionSignature,
  ]);

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
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = 0;
    let gapResubscribeTimer: ReturnType<typeof setTimeout> | null = null;
    let socketGeneration = 0;

    const subscribeAll = () => {
      syncHostedSubscriptionsRef.current(true);
    };

    const connect = () => {
      if (stopped) return;
      socketGeneration += 1;
      const wsGeneration = socketGeneration;
      socket = new WebSocket(getIndicatorStreamUrl());
      indicatorWsRef.current = socket;

      socket.onopen = () => {
        markPerf("indicator.ws.open", { symbol, interval, marketType, exchange, wsGeneration });
        lastSeq = 0;
        wsSubscriptions.clear();
        resetHostedSubscriptionReadiness?.();
        if (!stopped) subscribeAll();
      };

      socket.onmessage = (event) => {
        try {
          const parsed = parseIndicatorWsMessage(event.data);
          if (!parsed.ok) {
            console.warn("Indicator WS message parse failed:", parsed.error);
            return;
          }
          const message = parsed.message;
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
              applyWsPatch(indicatorId, payload);
              recordPerfEvent("indicator.ws.patch", { indicatorId, interval, wsGeneration });
            },
            onReplaceRange: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.replace_range", { indicatorId });
              applyWsReplaceRange(indicatorId, payload);
            },
            onRecomputed: (indicatorId, payload) => {
              recordPerfEvent("indicator.ws.recomputed", { indicatorId });
              requestRecomputedRange(indicatorId, payload);
            },
            onSubscribed: (indicatorId, payload) => {
              const dataRevision = payload?.dataRevision || payload?.data_revision || payload?.revision || {};
              recordPerfEvent("indicator.ws.subscribed", {
                indicatorId,
                interval: payload?.interval || interval,
                wsGeneration,
                resumeStatus: payload?.resumeStatus || payload?.resume_status || "legacy",
                resumeReason: payload?.resumeReason || payload?.resume_reason || null,
                closedThrough: dataRevision?.closedThrough ?? dataRevision?.closed_through ?? null,
              });
              handleIndicatorSubscribed?.(indicatorId, payload);
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
        if (!stopped) resetHostedSubscriptionReadiness?.();
        if (!stopped) {
          reconnectTimer = setTimeout(connect, INDICATOR_WS_RECONNECT_MS);
        }
      };

      socket.onerror = () => {
        try { socket?.close(); } catch { /* ignore */ }
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
    handleIndicatorSubscribed,
    interval,
    marketType,
    requestRecomputedRange,
    resetHostedSubscriptionReadiness,
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
