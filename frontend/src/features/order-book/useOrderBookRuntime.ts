import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { useOrderBookPreferences } from "./orderBookPreferencesStore.js";
import { createOrderBookStore } from "./orderBookStore.js";
import { OrderBookStreamController } from "./orderBookStreamController.js";
import {
  exchangeChannelsForMarket,
  exchangeMarketProductSupport,
  supportsOrderBookProduct,
} from "../exchange-support/exchangeSupportModel.js";
import type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";
import type {
  OrderBookIdentity,
  OrderBookMode,
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
  capability: ExchangeCapabilityPayload | null;
}

function normalizeIdentity(identity: OrderBookIdentity): OrderBookIdentity {
  return {
    exchange: identity.exchange.trim().toLowerCase(),
    marketType: identity.marketType.trim().toLowerCase(),
    symbol: identity.symbol.trim().toUpperCase(),
  };
}

function supportMessage(
  identity: OrderBookIdentity,
  capability: ExchangeCapabilityPayload | null,
): string | null {
  if (!supportsOrderBookProduct(capability, identity.marketType)) {
    return t("orderBook.rt.capabilityUnavailable");
  }
  if (!identity.symbol) return t("orderBook.rt.pickSymbol");
  return null;
}

function updateIntervals(
  identity: OrderBookIdentity,
  capability: ExchangeCapabilityPayload | null,
): readonly OrderBookUpdateIntervalMs[] {
  const channels = capability ? exchangeChannelsForMarket(capability, identity.marketType) : [];
  const depth = channels.find((channel) => channel.channel.toLowerCase() === "depth");
  const strict = channels.find((channel) => channel.channel.toLowerCase() === "full_depth");
  const declared = (depth?.update_intervals_ms?.length
    ? depth.update_intervals_ms
    : strict?.update_intervals_ms) || [];
  const allowed = new Set<OrderBookUpdateIntervalMs>([
    ...SPOT_UPDATE_INTERVALS_MS,
    ...FUTURES_UPDATE_INTERVALS_MS,
  ]);
  const resolved = declared.filter((value): value is OrderBookUpdateIntervalMs => (
    allowed.has(value as OrderBookUpdateIntervalMs)
  ));
  return resolved.length > 0 ? resolved : [1000];
}

export function useOrderBookRuntime({
  identity: rawIdentity,
  orderBookOpen,
  capability,
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
  const productSupport = useMemo(
    () => exchangeMarketProductSupport(capability, identity.marketType),
    [capability, identity.marketType],
  );
  const message = supportMessage(identity, capability);
  const supported = message === null;
  const fullModeSupported = productSupport?.order_book.strict_full_depth === true;
  const snapshotMode = productSupport?.order_book.snapshot_mode ?? null;
  const enabled = supported && orderBookOpen;
  const availableUpdateIntervals = useMemo(
    () => updateIntervals(identity, capability),
    [capability, identity],
  );
  const preferredUpdateIntervalMs: OrderBookUpdateIntervalMs = (
    identity.marketType === "spot" ? 1000 : 250
  );
  const defaultUpdateIntervalMs = availableUpdateIntervals.includes(preferredUpdateIntervalMs)
    ? preferredUpdateIntervalMs
    : availableUpdateIntervals[0] ?? 1000;
  const effectiveUpdateIntervalMs = availableUpdateIntervals.includes(
    preferences.updateIntervalMs,
  )
    ? preferences.updateIntervalMs
    : defaultUpdateIntervalMs;
  const effectiveMode: OrderBookMode = (
    preferences.mode === "full" && fullModeSupported ? "full" : "partial"
  );
  const effectivePreferences = useMemo(() => ({
    ...preferences,
    mode: effectiveMode,
  }), [effectiveMode, preferences]);
  const streamPriceGrouping = effectiveMode === "full"
    ? preferences.fullPriceGrouping
    : "raw";

  useEffect(() => {
    if (!supported) {
      store.reset("unsupported", message);
      return undefined;
    }
    if (!enabled) {
      store.reset("idle", orderBookOpen ? t("orderBook.rt.unavailable") : t("orderBook.rt.panelClosed"));
      return undefined;
    }
    const wsBase = httpBaseToWsBase(API_BASE);
    const controller = new OrderBookStreamController({
      url: `${wsBase}/stream/${effectiveMode === "partial" ? "order-book" : "full-order-book"}`,
      identity,
      mode: effectiveMode,
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
    effectiveMode,
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
      fullModeSupported,
      snapshotMode,
      preferences: effectivePreferences,
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
    effectivePreferences,
    fullModeSupported,
    identity,
    message,
    snapshotMode,
    store,
    supported,
  ]);
}
