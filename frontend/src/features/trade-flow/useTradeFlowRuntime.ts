import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { createTradeFlowMarkerSource } from "./tradeFlowMarkerSource.js";
import { useTradeFlowPreferences } from "./tradeFlowPreferencesStore.js";
import { createTradeFlowStore } from "./tradeFlowStore.js";
import { TradeFlowStreamController } from "./tradeFlowStreamController.js";
import type { TradeFlowIdentity, TradeFlowRuntime } from "./tradeFlowTypes.js";

export interface UseTradeFlowRuntimeOptions {
  identity: TradeFlowIdentity;
  interval: IntervalString;
  seriesStore: SeriesWindowStore | null;
  buyColor: string;
  sellColor: string;
}

function normalizeIdentity(identity: TradeFlowIdentity): TradeFlowIdentity {
  return {
    exchange: identity.exchange.trim().toLowerCase(),
    marketType: identity.marketType.trim().toLowerCase(),
    symbol: identity.symbol.trim().toUpperCase(),
  };
}

function supportMessage(identity: TradeFlowIdentity): string | null {
  if (identity.exchange !== "binance") return "逐笔订单流目前仅支持 Binance";
  if (identity.marketType !== "futures" && identity.marketType !== "spot") {
    return "逐笔订单流目前仅支持 Binance 现货与 U 本位合约";
  }
  if (!identity.symbol) return "请选择交易品种";
  return null;
}

export function useTradeFlowRuntime({
  identity: rawIdentity,
  interval,
  seriesStore,
  buyColor,
  sellColor,
}: UseTradeFlowRuntimeOptions): TradeFlowRuntime {
  const { exchange, marketType, symbol } = rawIdentity;
  const identity = useMemo(() => normalizeIdentity({ exchange, marketType, symbol }), [
    exchange,
    marketType,
    symbol,
  ]);
  const { preferences, actions: preferenceActions } = useTradeFlowPreferences();
  // This store intentionally has no effect cleanup. StrictMode replays effects
  // while preserving state, so destroying it there would permanently disable
  // the remounted realtime stream; it is released normally with the component.
  const [store] = useState(createTradeFlowStore);
  const [retryRevision, setRetryRevision] = useState(0);
  const message = supportMessage(identity);
  const supported = message === null;
  const enabled = supported && preferences.dockView !== "order-book";

  useEffect(() => {
    if (!supported) {
      store.reset("unsupported", message);
      return undefined;
    }
    if (preferences.dockView === "order-book") {
      store.reset("idle", "右侧实时订单流未打开");
      return undefined;
    }
    const controller = new TradeFlowStreamController({
      url: `${httpBaseToWsBase(API_BASE)}/stream/trade-flow`,
      identity,
      store,
    });
    // StrictMode immediately replays effect setup/cleanup in development. By
    // deferring the physical connection one cancellable turn, the rehearsal
    // cleanup never opens a socket or starts/stops the backend physical feed.
    const startTimer = setTimeout(() => controller.start(), 0);
    return () => {
      clearTimeout(startTimer);
      controller.close();
    };
  }, [identity, message, preferences.dockView, retryRevision, store, supported]);

  const intervalSeconds = parseIntervalSeconds(interval);
  const markerSource = useMemo(() => (
    enabled && seriesStore && intervalSeconds
      ? createTradeFlowMarkerSource({
        store,
        seriesStore,
        intervalSeconds,
        threshold: preferences.largeTradeNotional,
        buyColor,
        sellColor,
      })
      : null
  ), [
    buyColor,
    enabled,
    intervalSeconds,
    preferences.largeTradeNotional,
    sellColor,
    seriesStore,
    store,
  ]);
  const retry = useCallback(() => setRetryRevision((current) => current + 1), []);
  const actions = useMemo(() => ({ ...preferenceActions, retry }), [preferenceActions, retry]);

  return useMemo<TradeFlowRuntime>(() => ({
    view: {
      identity,
      supported,
      supportMessage: message,
      preferences,
      store,
      markerSource,
    },
    actions,
    status: { enabled },
  }), [actions, enabled, identity, markerSource, message, preferences, store, supported]);
}
