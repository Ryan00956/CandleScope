import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { createTradeFlowMarkerSource } from "./tradeFlowMarkerSource.js";
import { useTradeFlowPreferences } from "./tradeFlowPreferencesStore.js";
import { createTradeFlowStore } from "./tradeFlowStore.js";
import { TradeFlowStreamController } from "./tradeFlowStreamController.js";
import {
  exchangeMarketProductSupport,
  supportsTradeFlowProduct,
} from "../exchange-support/exchangeSupportModel.js";
import type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";
import type { TradeFlowIdentity, TradeFlowRuntime } from "./tradeFlowTypes.js";

export interface UseTradeFlowRuntimeOptions {
  identity: TradeFlowIdentity;
  interval: IntervalString;
  seriesStore: SeriesWindowStore | null;
  buyColor: string;
  sellColor: string;
  /** True when tape and/or profile rail views are open. */
  tradeFlowOpen?: boolean;
  capability: ExchangeCapabilityPayload | null;
}

function normalizeIdentity(identity: TradeFlowIdentity): TradeFlowIdentity {
  return {
    exchange: identity.exchange.trim().toLowerCase(),
    marketType: identity.marketType.trim().toLowerCase(),
    symbol: identity.symbol.trim().toUpperCase(),
  };
}

function supportMessage(
  identity: TradeFlowIdentity,
  capability: ExchangeCapabilityPayload | null,
): string | null {
  if (!supportsTradeFlowProduct(capability, identity.marketType)) {
    return t("trade.rt.capabilityUnavailable");
  }
  if (!identity.symbol) return t("orderBook.rt.pickSymbol");
  return null;
}

export function useTradeFlowRuntime({
  identity: rawIdentity,
  interval,
  seriesStore,
  buyColor,
  sellColor,
  tradeFlowOpen,
  capability,
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
  const productSupport = useMemo(
    () => exchangeMarketProductSupport(capability, identity.marketType),
    [capability, identity.marketType],
  );
  const message = supportMessage(identity, capability);
  const supported = message === null;
  const continuityMode = productSupport?.trade_flow.mode === "observational"
    ? "observational"
    : "strict_repairable";
  const tradeChannel = productSupport?.trade_flow.channel === "trade" ? "trade" : "agg_trade";
  const deliveryMode = productSupport?.trade_flow.delivery_mode || null;
  // Prefer explicit rail open state; fall back to legacy dockView exclusivity.
  const streamOpen = tradeFlowOpen ?? preferences.dockView !== "order-book";
  const enabled = supported && streamOpen;

  useEffect(() => {
    if (!supported) {
      store.reset("unsupported", message);
      return undefined;
    }
    if (!streamOpen) {
      store.reset("idle", t("trade.rt.closed"));
      return undefined;
    }
    const controller = new TradeFlowStreamController({
      url: `${httpBaseToWsBase(API_BASE)}/stream/trade-flow`,
      identity,
      store,
      channel: tradeChannel,
      continuityMode,
    });
    // StrictMode immediately replays effect setup/cleanup in development. By
    // deferring the physical connection one cancellable turn, the rehearsal
    // cleanup never opens a socket or starts/stops the backend physical feed.
    const startTimer = setTimeout(() => controller.start(), 0);
    return () => {
      clearTimeout(startTimer);
      controller.close();
    };
  }, [continuityMode, deliveryMode, identity, message, retryRevision, store, streamOpen, supported, tradeChannel]);

  const intervalSeconds = parseIntervalSeconds(interval);
  const markerSource = useMemo(() => (
    enabled && seriesStore && intervalSeconds && preferences.largeTradeNotional > 0
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
      interval,
      supported,
      supportMessage: message,
      continuityMode,
      deliveryMode,
      preferences,
      store,
      markerSource,
    },
    actions,
    status: { enabled },
  }), [
    actions,
    continuityMode,
    deliveryMode,
    enabled,
    identity,
    interval,
    markerSource,
    message,
    preferences,
    store,
    supported,
  ]);
}
