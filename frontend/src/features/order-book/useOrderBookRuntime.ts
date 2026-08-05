import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { useOrderBookPreferences } from "./orderBookPreferencesStore.js";
import { createOrderBookStore } from "./orderBookStore.js";
import { OrderBookStreamController } from "./orderBookStreamController.js";
import type {
  OrderBookIdentity,
  OrderBookRuntime,
  OrderBookUpdateIntervalMs,
} from "./orderBookTypes.js";
import {
  FUTURES_UPDATE_INTERVALS_MS,
  SPOT_UPDATE_INTERVALS_MS,
} from "./orderBookTypes.js";

export interface UseOrderBookRuntimeOptions {
  identity: OrderBookIdentity;
  /** Whether the order-book rail view is currently open. */
  orderBookOpen: boolean;
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
  if (identity.marketType !== "spot" && identity.marketType !== "futures") {
    return "订单簿目前仅支持 Binance 现货与 U 本位合约";
  }
  if (!identity.symbol) return "请选择交易品种";
  return null;
}

function updateIntervals(identity: OrderBookIdentity): readonly OrderBookUpdateIntervalMs[] {
  return identity.marketType === "spot"
    ? SPOT_UPDATE_INTERVALS_MS
    : FUTURES_UPDATE_INTERVALS_MS;
}

export function useOrderBookRuntime({
  identity: rawIdentity,
  orderBookOpen,
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
  const enabled = supported && orderBookOpen;
  const availableUpdateIntervals = updateIntervals(identity);
  const defaultUpdateIntervalMs: OrderBookUpdateIntervalMs = (
    identity.marketType === "spot" ? 1000 : 250
  );
  const effectiveUpdateIntervalMs = availableUpdateIntervals.includes(
    preferences.updateIntervalMs,
  )
    ? preferences.updateIntervalMs
    : defaultUpdateIntervalMs;
  const streamPriceGrouping = preferences.mode === "full"
    ? preferences.fullPriceGrouping
    : "raw";

  useEffect(() => {
    if (!supported) {
      store.reset("unsupported", message);
      return undefined;
    }
    if (!enabled) {
      store.reset("idle", orderBookOpen ? "订单簿不可用" : "盘口面板未打开");
      return undefined;
    }
    const wsBase = httpBaseToWsBase(API_BASE);
    const controller = new OrderBookStreamController({
      url: `${wsBase}/stream/${preferences.mode === "partial" ? "order-book" : "full-order-book"}`,
      identity,
      mode: preferences.mode,
      partialDepth: preferences.partialDepth,
      updateIntervalMs: effectiveUpdateIntervalMs,
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
    effectiveUpdateIntervalMs,
    orderBookOpen,
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
      updateIntervalMs: effectiveUpdateIntervalMs,
      updateIntervalsMs: availableUpdateIntervals,
      store,
    },
    actions,
    status: { enabled },
  }), [
    actions,
    availableUpdateIntervals,
    effectiveUpdateIntervalMs,
    enabled,
    identity,
    message,
    preferences,
    store,
    supported,
  ]);
}
