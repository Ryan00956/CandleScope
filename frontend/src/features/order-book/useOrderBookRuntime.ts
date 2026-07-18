import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { useOrderBookPreferences } from "./orderBookPreferencesStore.js";
import { createOrderBookStore } from "./orderBookStore.js";
import { OrderBookStreamController } from "./orderBookStreamController.js";
import type {
  OrderBookIdentity,
  OrderBookRuntime,
} from "./orderBookTypes.js";

export interface UseOrderBookRuntimeOptions {
  identity: OrderBookIdentity;
  railCollapsed: boolean;
}

function normalizeIdentity(identity: OrderBookIdentity): OrderBookIdentity {
  return {
    exchange: identity.exchange.trim().toLowerCase(),
    marketType: identity.marketType.trim().toLowerCase(),
    symbol: identity.symbol.trim().toUpperCase(),
  };
}

function supportMessage(identity: OrderBookIdentity): string | null {
  if (identity.exchange !== "binance") return "订单簿目前仅支持 Binance";
  if (identity.marketType !== "futures") return "订单簿目前仅支持 Binance U 本位合约";
  if (!identity.symbol) return "请选择交易品种";
  return null;
}

export function useOrderBookRuntime({
  identity: rawIdentity,
  railCollapsed,
}: UseOrderBookRuntimeOptions): OrderBookRuntime {
  const { exchange, marketType, symbol } = rawIdentity;
  const identity = useMemo(() => normalizeIdentity({ exchange, marketType, symbol }), [
    exchange,
    marketType,
    symbol,
  ]);
  const { preferences, actions: preferenceActions } = useOrderBookPreferences();
  const [store] = useState(createOrderBookStore);
  const [retryRevision, setRetryRevision] = useState(0);
  const message = supportMessage(identity);
  const supported = message === null;
  const enabled = supported && !railCollapsed && !preferences.collapsed;
  const streamPriceGrouping = preferences.mode === "full"
    ? preferences.fullPriceGrouping
    : "raw";

  useEffect(() => {
    if (!supported) {
      store.reset("unsupported", message);
      return undefined;
    }
    if (!enabled) {
      store.reset("idle", railCollapsed ? "右侧栏已收起" : "订单簿已折叠");
      return undefined;
    }
    const wsBase = httpBaseToWsBase(API_BASE);
    const controller = new OrderBookStreamController({
      url: `${wsBase}/stream/${preferences.mode === "partial" ? "order-book" : "full-order-book"}`,
      identity,
      mode: preferences.mode,
      partialDepth: preferences.partialDepth,
      updateIntervalMs: preferences.updateIntervalMs,
      fullOutputLimit: preferences.fullOutputLimit,
      fullPriceGrouping: streamPriceGrouping,
      store,
    });
    controller.start();
    return () => controller.close();
  }, [
    enabled,
    identity,
    message,
    preferences.fullOutputLimit,
    preferences.mode,
    preferences.partialDepth,
    preferences.updateIntervalMs,
    railCollapsed,
    retryRevision,
    store,
    streamPriceGrouping,
    supported,
  ]);

  const retry = useCallback(() => setRetryRevision((current) => current + 1), []);
  const actions = useMemo(() => ({ ...preferenceActions, retry }), [preferenceActions, retry]);

  return useMemo<OrderBookRuntime>(() => ({
    view: {
      identity,
      supported,
      supportMessage: message,
      preferences,
      store,
    },
    actions,
    status: { enabled },
  }), [actions, enabled, identity, message, preferences, store, supported]);
}
