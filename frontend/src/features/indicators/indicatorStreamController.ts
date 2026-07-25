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
  shouldResubscribeForHostedSeedCoverage,
} from "./indicatorWsRuntime.js";
import {
  IndicatorStreamConnection,
  type IndicatorStreamSubscription,
} from "./indicatorStreamConnection.js";
import { formatIndicatorError } from "./indicatorPayloadRuntime.js";
import {
  buildCurrentHostedIndicatorSignatures,
  isCurrentHostedIndicatorMessage,
} from "./indicatorStreamIdentity.js";
import { canFlushHostedSeedCoverageRefresh } from "./indicatorWindowDeltaRuntime.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IndicatorDefinition,
  IndicatorRecomputedMessage,
  IndicatorSubscribedMessage,
  IndicatorSubscriptionContext,
  IndicatorWsHandlers,
} from "./indicatorTypes.js";

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
  historyWindowPending: boolean;
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
  realtimeEnabled: boolean;
  resetHostedSubscriptionReadiness?: () => void;
  setIndicatorError(indicatorId: string, error: string): void;
  subscriptionUpdatesReady: boolean;
  symbol: string;
}

export interface IndicatorStreamController {
  forceHostedSubscriptions(): void;
}

interface StreamHandlerRefs {
  applyWsPatch: NonNullable<IndicatorWsHandlers["onPatch"]>;
  applyWsReplaceRange: NonNullable<IndicatorWsHandlers["onReplaceRange"]>;
  applyWsSnapshot: NonNullable<IndicatorWsHandlers["onSnapshot"]>;
  applyWsValues: NonNullable<IndicatorWsHandlers["onValues"]>;
  exchange: string;
  handleIndicatorRecomputed: ((
    indicatorId: string,
    payload: IndicatorRecomputedMessage,
  ) => void) | undefined;
  handleIndicatorSubscriptionPending: ((indicatorId: string) => void) | undefined;
  handleIndicatorSubscribed: ((
    indicatorId: string,
    payload: IndicatorSubscribedMessage,
  ) => void) | undefined;
  interval: string;
  marketType: string;
  resetHostedSubscriptionReadiness: (() => void) | undefined;
  setIndicatorError: (indicatorId: string, error: string) => void;
  symbol: string;
}

interface HostedSeedCoverageState {
  acknowledged: boolean;
  historyLimit: number;
  refreshPending: boolean;
  signature: string;
}

function ensureHostedSeedCoverage(
  coverageByClient: Map<string, HostedSeedCoverageState>,
  subscriptions: readonly IndicatorStreamSubscription[],
): void {
  const clientIds = new Set<string>();
  for (const subscription of subscriptions) {
    clientIds.add(subscription.clientId);
    const current = coverageByClient.get(subscription.clientId);
    if (current?.signature === subscription.signature) continue;
    coverageByClient.set(subscription.clientId, {
      acknowledged: false,
      historyLimit: subscription.message.historyLimit,
      refreshPending: false,
      signature: subscription.signature,
    });
  }
  for (const clientId of coverageByClient.keys()) {
    if (!clientIds.has(clientId)) coverageByClient.delete(clientId);
  }
}

function indicatorDefinitionForHostedSeed(
  subscription: IndicatorStreamSubscription,
): IndicatorDefinition {
  const definition: IndicatorDefinition = {
    id: subscription.clientId,
    params: subscription.message.params,
  };
  if (subscription.message.name) definition.engineName = subscription.message.name;
  if (subscription.message.script !== undefined) {
    definition.script = subscription.message.script;
  }
  return definition;
}

function planHostedSeedCoverageRefresh(
  coverageByClient: Map<string, HostedSeedCoverageState>,
  subscriptions: readonly IndicatorStreamSubscription[],
  historyWindowPending: boolean,
): boolean {
  let shouldRefresh = false;
  for (const subscription of subscriptions) {
    const current = coverageByClient.get(subscription.clientId);
    if (!current || current.signature !== subscription.signature) continue;
    if (shouldResubscribeForHostedSeedCoverage(
      indicatorDefinitionForHostedSeed(subscription),
      current.historyLimit,
      subscription.message.historyLimit,
    )) {
      current.refreshPending = true;
    }
    if (canFlushHostedSeedCoverageRefresh({
      acknowledged: current.acknowledged,
      historyWindowPending,
      refreshPending: current.refreshPending,
    })) shouldRefresh = true;
  }
  return shouldRefresh;
}

function markHostedSeedCoverageRefreshRequested(
  coverageByClient: Map<string, HostedSeedCoverageState>,
  subscriptions: readonly IndicatorStreamSubscription[],
): void {
  for (const subscription of subscriptions) {
    const current = coverageByClient.get(subscription.clientId);
    if (
      !current
      || current.signature !== subscription.signature
      || !current.acknowledged
      || !current.refreshPending
    ) continue;
    current.historyLimit = subscription.message.historyLimit;
    current.refreshPending = false;
  }
}

function markHostedSeedCoverageAcknowledged(
  coverageByClient: Map<string, HostedSeedCoverageState>,
  clientId: string,
): void {
  const current = coverageByClient.get(clientId);
  if (current) current.acknowledged = true;
}

function markHostedSeedCoverageUnacknowledged(
  coverageByClient: Map<string, HostedSeedCoverageState>,
): void {
  for (const current of coverageByClient.values()) {
    current.acknowledged = false;
  }
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
  historyWindowPending,
  getIndicatorResumeState,
  handleIndicatorRecomputed,
  handleIndicatorSubscriptionPending,
  handleIndicatorSubscribed,
  interval,
  marketType,
  realtimeEnabled,
  resetHostedSubscriptionReadiness,
  setIndicatorError,
  subscriptionUpdatesReady,
  symbol,
}: UseIndicatorStreamControllerOptions): IndicatorStreamController {
  const connectionRef = useRef<IndicatorStreamConnection | null>(null);
  const recomputedRangeSignaturesRef = useRef<Set<string>>(new Set());
  const hostedSeedCoverageRef = useRef<Map<string, HostedSeedCoverageState>>(
    new Map(),
  );
  const historyWindowPendingRef = useRef(historyWindowPending);
  const subscriptionUpdatesReadyRef = useRef(subscriptionUpdatesReady);
  const readySubscriptionsRef = useRef<IndicatorStreamSubscription[]>([]);
  useLayoutEffect(() => {
    historyWindowPendingRef.current = historyWindowPending;
  }, [historyWindowPending]);
  useLayoutEffect(() => {
    subscriptionUpdatesReadyRef.current = subscriptionUpdatesReady;
  }, [subscriptionUpdatesReady]);

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
  }), [
    candleDownColorRef,
    candleUpColorRef,
    chartDataMetaRef,
    chartDataRef,
    exchange,
    interval,
    marketType,
    symbol,
  ]);

  const buildHostedMessage = useCallback((indicator: IndicatorDefinition) => {
    const resumeState = getIndicatorResumeState?.(indicator) || null;
    return buildHostedSubscriptionMessage(indicator, {
      ...getHostedSubscriptionContext(),
      ...(resumeState || {}),
    });
  }, [getHostedSubscriptionContext, getIndicatorResumeState]);

  const hostedSubscriptionSignature = useCallback((indicator: IndicatorDefinition) => (
    buildHostedSubscriptionSignature(indicator, getHostedSubscriptionContext())
  ), [getHostedSubscriptionContext]);

  const buildDesiredSubscriptions = useCallback((): IndicatorStreamSubscription[] => (
    getVisibleHostedIndicators(activeIndicatorsRef.current).map((indicator) => ({
      clientId: indicator.id,
      message: buildHostedMessage(indicator),
      signature: hostedSubscriptionSignature(indicator),
    }))
  ), [
    activeIndicatorsRef,
    buildHostedMessage,
    hostedSubscriptionSignature,
  ]);

  const buildDesiredSubscriptionsRef = useRef(buildDesiredSubscriptions);
  useLayoutEffect(() => {
    buildDesiredSubscriptionsRef.current = buildDesiredSubscriptions;
  }, [buildDesiredSubscriptions]);

  const handlerRefs = useRef<StreamHandlerRefs>({
    applyWsPatch,
    applyWsReplaceRange,
    applyWsSnapshot,
    applyWsValues,
    exchange,
    handleIndicatorRecomputed,
    handleIndicatorSubscriptionPending,
    handleIndicatorSubscribed,
    interval,
    marketType,
    resetHostedSubscriptionReadiness,
    setIndicatorError,
    symbol,
  });
  useLayoutEffect(() => {
    handlerRefs.current = {
      applyWsPatch,
      applyWsReplaceRange,
      applyWsSnapshot,
      applyWsValues,
      exchange,
      handleIndicatorRecomputed,
      handleIndicatorSubscriptionPending,
      handleIndicatorSubscribed,
      interval,
      marketType,
      resetHostedSubscriptionReadiness,
      setIndicatorError,
      symbol,
    };
  }, [
    applyWsPatch,
    applyWsReplaceRange,
    applyWsSnapshot,
    applyWsValues,
    exchange,
    handleIndicatorRecomputed,
    handleIndicatorSubscriptionPending,
    handleIndicatorSubscribed,
    interval,
    marketType,
    resetHostedSubscriptionReadiness,
    setIndicatorError,
    symbol,
  ]);

  const hasWsHostedIndicators = getVisibleHostedIndicators(activeIndicators).length > 0;
  const indicatorWsSignature = buildIndicatorWsSignature(activeIndicators);
  const chartHistoryFirstTime = chartDataMeta?.firstTime ?? chartData?.[0]?.time ?? null;
  const chartHistoryLength = chartData?.length || 0;
  const chartDataVersion = chartDataMeta?.version ?? 0;
  const chartDataStatus = chartDataMeta?.status || "idle";
  const currentHostedSignatureKey = JSON.stringify([
    exchange,
    marketType,
    symbol,
    interval,
    candleUpColor,
    candleDownColor,
    indicatorWsSignature,
  ]);
  const currentHostedSignaturesRef = useRef<ReadonlyMap<string, string> | null>(null);
  if (currentHostedSignaturesRef.current === null) {
    // React permits deterministic lazy ref initialization during render. Keep
    // line hydration/realtime output renders from rebuilding JSON identities;
    // later semantic changes publish only from the committed layout effect.
    currentHostedSignaturesRef.current = buildCurrentHostedIndicatorSignatures(
      activeIndicators,
      { candleDownColor, candleUpColor, exchange, interval, marketType, symbol },
    );
  }
  const currentHostedSignatureKeyRef = useRef(currentHostedSignatureKey);
  useLayoutEffect(() => {
    if (currentHostedSignatureKeyRef.current === currentHostedSignatureKey) return;
    currentHostedSignaturesRef.current = buildCurrentHostedIndicatorSignatures(
      activeIndicators,
      { candleDownColor, candleUpColor, exchange, interval, marketType, symbol },
    );
    currentHostedSignatureKeyRef.current = currentHostedSignatureKey;
  }, [
    activeIndicators,
    candleDownColor,
    candleUpColor,
    currentHostedSignatureKey,
    exchange,
    interval,
    marketType,
    symbol,
  ]);

  const syncConnectionSubscriptions = useCallback((
    connection: IndicatorStreamConnection,
    force = false,
  ): boolean => {
    if (!subscriptionUpdatesReadyRef.current) return false;
    const subscriptions = buildDesiredSubscriptionsRef.current();
    readySubscriptionsRef.current = subscriptions;
    const coverageByClient = hostedSeedCoverageRef.current;
    ensureHostedSeedCoverage(coverageByClient, subscriptions);
    const shouldRefreshSeed = planHostedSeedCoverageRefresh(
      coverageByClient,
      subscriptions,
      historyWindowPendingRef.current,
    );
    const synced = connection.setSubscriptions(subscriptions);
    if (!force && !shouldRefreshSeed) return synced;
    const resubscribed = connection.forceResubscribe();
    if (shouldRefreshSeed && resubscribed) {
      markHostedSeedCoverageRefreshRequested(coverageByClient, subscriptions);
    }
    return resubscribed || synced;
  }, []);

  const syncHostedSubscriptions = useCallback((force = false): boolean => {
    const connection = connectionRef.current;
    return connection ? syncConnectionSubscriptions(connection, force) : false;
  }, [syncConnectionSubscriptions]);

  const requestRecomputedRange = useCallback((
    indicatorId: string,
    payload: IndicatorRecomputedMessage,
  ) => {
    const handlers = handlerRefs.current;
    if (typeof handlers.handleIndicatorRecomputed !== "function") return;
    const dirtyRange = payload?.dirtyRange || payload?.dirty_range || payload?.range;
    const start = Math.floor(Number(dirtyRange?.start));
    const end = Math.floor(Number(dirtyRange?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
      return;
    }
    const signature = [
      handlers.exchange,
      handlers.marketType,
      handlers.symbol,
      handlers.interval,
      indicatorId,
      start,
      end,
      JSON.stringify(payload?.dataRevision || payload?.data_revision || payload?.revision || {}),
    ].join("|");
    if (recomputedRangeSignaturesRef.current.has(signature)) return;
    recomputedRangeSignaturesRef.current.add(signature);
    handlers.handleIndicatorRecomputed(indicatorId, payload);
  }, []);

  useEffect(() => {
    if (!symbol || !interval || !hasWsHostedIndicators || !chartDataReady || !realtimeEnabled) {
      const connection = connectionRef.current;
      if (connection) {
        connection.close();
        if (connectionRef.current === connection) connectionRef.current = null;
      }
      return undefined;
    }

    const connection = new IndicatorStreamConnection({
      url: getIndicatorStreamUrl(),
      onConnectionReset: () => {
        recomputedRangeSignaturesRef.current.clear();
        markHostedSeedCoverageUnacknowledged(hostedSeedCoverageRef.current);
        handlerRefs.current.resetHostedSubscriptionReadiness?.();
      },
      onError: (error) => {
        console.warn("Indicator WS connection recovery:", error);
      },
      onMessage: (message, { subscriptionSignature, wsGeneration }) => {
        const currentSignatures = currentHostedSignaturesRef.current;
        if (!currentSignatures || !isCurrentHostedIndicatorMessage(
          message,
          subscriptionSignature,
          currentSignatures,
        )) return;
        const handlers = handlerRefs.current;
        dispatchIndicatorWsMessage(message, {
          onSnapshot: (indicatorId, payload) => {
            markPerf("indicator.ws.snapshot", { indicatorId });
            handlers.applyWsSnapshot(indicatorId, payload);
          },
          onPatch: (indicatorId, payload) => {
            handlers.applyWsPatch(indicatorId, payload);
            recordPerfEvent("indicator.ws.patch", {
              indicatorId,
              interval: handlers.interval,
              wsGeneration,
            });
          },
          onReplaceRange: (indicatorId, payload) => {
            recordPerfEvent("indicator.ws.replace_range", { indicatorId });
            handlers.applyWsReplaceRange(indicatorId, payload);
          },
          onRecomputed: (indicatorId, payload) => {
            recordPerfEvent("indicator.ws.recomputed", { indicatorId });
            requestRecomputedRange(indicatorId, payload);
          },
          onSubscribed: (indicatorId, payload) => {
            const dataRevision = payload?.dataRevision || payload?.data_revision || payload?.revision || {};
            recordPerfEvent("indicator.ws.subscribed", {
              indicatorId,
              interval: payload?.interval || handlers.interval,
              wsGeneration,
              resumeStatus: payload?.resumeStatus || payload?.resume_status || "legacy",
              resumeReason: payload?.resumeReason || payload?.resume_reason || null,
              closedThrough: dataRevision?.closedThrough ?? dataRevision?.closed_through ?? null,
            });
            handlers.handleIndicatorSubscribed?.(indicatorId, payload);
            const subscriptions = buildDesiredSubscriptionsRef.current();
            ensureHostedSeedCoverage(hostedSeedCoverageRef.current, subscriptions);
            markHostedSeedCoverageAcknowledged(
              hostedSeedCoverageRef.current,
              indicatorId,
            );
            syncConnectionSubscriptions(connection);
          },
          onValues: handlers.applyWsValues,
          onError: (indicatorId, payload) => {
            handlers.setIndicatorError(
              indicatorId,
              formatIndicatorError(payload, "Indicator WS error"),
            );
          },
        }, subscriptionSignature);
      },
      onParseError: (error) => {
        console.warn("Indicator WS message parse failed:", error);
      },
      onSocketOpen: ({ wsGeneration }) => {
        const handlers = handlerRefs.current;
        markPerf("indicator.ws.open", {
          symbol: handlers.symbol,
          interval: handlers.interval,
          marketType: handlers.marketType,
          exchange: handlers.exchange,
          wsGeneration,
        });
      },
      onSubscriptionPending: (indicatorId) => {
        handlerRefs.current.handleIndicatorSubscriptionPending?.(indicatorId);
      },
    });
    connectionRef.current = connection;
    const initialSubscriptions = subscriptionUpdatesReadyRef.current
      ? buildDesiredSubscriptionsRef.current()
      : readySubscriptionsRef.current;
    readySubscriptionsRef.current = initialSubscriptions;
    ensureHostedSeedCoverage(hostedSeedCoverageRef.current, initialSubscriptions);
    markHostedSeedCoverageUnacknowledged(hostedSeedCoverageRef.current);
    connection.setSubscriptions(initialSubscriptions);
    connection.start();

    return () => {
      connection.close();
      if (connectionRef.current === connection) connectionRef.current = null;
      readySubscriptionsRef.current = [];
    };
  }, [
    chartDataReady,
    exchange,
    hasWsHostedIndicators,
    interval,
    marketType,
    realtimeEnabled,
    symbol,
    requestRecomputedRange,
    syncConnectionSubscriptions,
  ]);

  useEffect(() => {
    if (!hasWsHostedIndicators || !chartDataReady || !realtimeEnabled) return;
    syncHostedSubscriptions(false);
  }, [
    candleDownColor,
    candleUpColor,
    chartDataReady,
    chartDataStatus,
    chartDataVersion,
    chartHistoryFirstTime,
    chartHistoryLength,
    historyWindowPending,
    hasWsHostedIndicators,
    indicatorWsSignature,
    realtimeEnabled,
    subscriptionUpdatesReady,
    syncHostedSubscriptions,
  ]);

  const forceHostedSubscriptions = useCallback(() => {
    syncHostedSubscriptions(true);
  }, [syncHostedSubscriptions]);

  return {
    forceHostedSubscriptions,
  };
}
