import type {
  ExchangeAdvancedChannelProductPayload,
  ExchangeCapabilityPayload,
  ExchangeChannelCapabilityPayload,
  ExchangeMarketProductPayload,
} from "../../services/apiPayloadParsers.js";

export type ExchangeSupportFilter =
  | "all"
  | "primary"
  | "streaming"
  | "polling"
  | "derivatives"
  | "unroutable";

export type ExchangeConnectionCheckStatus = "running" | "success" | "error";

export interface ExchangeConnectionCheck {
  status: ExchangeConnectionCheckStatus;
  symbolCount?: number;
  checkedAt?: number;
  error?: string;
}

export interface ExchangeProductSurfaceSupport {
  chart: boolean;
  advancedMarketData: boolean;
  orderBook: boolean;
  tradeFlow: boolean;
}

const DERIVATIVE_MARKET_TYPES = new Set(["futures", "swap", "future", "option"]);
const ADVANCED_STATE_CHANNELS = [
  "mark_price",
  "index_price",
  "funding_rate",
  "open_interest",
] as const;

export function exchangeMarketCheckKey(exchange: string, marketType: string): string {
  return `${exchange.trim().toLowerCase()}:${marketType.trim().toLowerCase()}`;
}

export function exchangeIsRoutable(exchange: ExchangeCapabilityPayload): boolean {
  if (exchange.support) return exchange.support.routable;
  const schemaVersion = Number(exchange.capability_schema_version ?? 1);
  return exchange.markets.length > 0
    && (schemaVersion <= 1 || Boolean(exchange.channels?.length));
}

export function exchangeProvider(exchange: ExchangeCapabilityPayload): string {
  if (exchange.support?.provider) return exchange.support.provider;
  if (exchange.protocol_features.includes("provider.ccxt_primary")) return "ccxt_primary";
  if (exchange.protocol_features.includes("provider.ccxt_unified")) return "ccxt_unified";
  return "plugin";
}

export function channelSupportsMarket(
  channel: ExchangeChannelCapabilityPayload,
  marketType: string,
): boolean {
  const normalized = marketType.trim().toLowerCase();
  return channel.market_types.some((value) => value.trim().toLowerCase() === normalized);
}

export function exchangeChannelsForMarket(
  exchange: ExchangeCapabilityPayload,
  marketType: string,
): ExchangeChannelCapabilityPayload[] {
  return (exchange.channels || []).filter((channel) => channelSupportsMarket(channel, marketType));
}

export function exchangeHasPluginStream(exchange: ExchangeCapabilityPayload): boolean {
  return (exchange.channels || []).some((channel) => (
    channel.realtime === true
    && Array.isArray(channel.realtime_transports)
    && channel.realtime_transports.includes("plugin_stream")
  ));
}

export function exchangeIsPollingOnly(exchange: ExchangeCapabilityPayload): boolean {
  const realtimeChannels = (exchange.channels || []).filter((channel) => channel.realtime === true);
  return realtimeChannels.length > 0 && realtimeChannels.every((channel) => {
    const transports = Array.isArray(channel.realtime_transports)
      ? channel.realtime_transports
      : [];
    return transports.length > 0 && transports.every((transport) => (
      transport === "rest_poll" || transport === "rest_snapshot"
    ));
  });
}

export function exchangeHasDerivatives(exchange: ExchangeCapabilityPayload): boolean {
  return exchange.markets.some((market) => {
    const base = market.market_type.trim().toLowerCase().split(".")[0] || "";
    return DERIVATIVE_MARKET_TYPES.has(base);
  });
}

function liveTransport(channel: ExchangeChannelCapabilityPayload | undefined): boolean {
  return Boolean(channel?.realtime && (
    channel.realtime_transports?.includes("websocket")
    || channel.realtime_transports?.includes("plugin_stream")
  ));
}

function snapshotBookMode(
  channel: ExchangeChannelCapabilityPayload | undefined,
): "live_snapshot" | "polling_snapshot" | null {
  if (!channel?.realtime || channel.delivery !== "snapshot" || channel.snapshot !== true) {
    return null;
  }
  if (liveTransport(channel)) return "live_snapshot";
  return channel.realtime_transports?.includes("rest_snapshot")
    ? "polling_snapshot"
    : null;
}

function stateDeliveryMode(
  channel: ExchangeChannelCapabilityPayload | undefined,
): "live_snapshot" | "polling_snapshot" | "history_only" | null {
  if (channel?.realtime && channel.delivery === "latest" && channel.snapshot === true) {
    if (liveTransport(channel)) return "live_snapshot";
    if (channel.realtime_transports?.includes("rest_poll")) return "polling_snapshot";
  }
  return channel?.history === true ? "history_only" : null;
}

function observationalDeliveryMode(
  channel: ExchangeChannelCapabilityPayload | undefined,
): "live_observational" | "polling_observational" | null {
  if (!channel?.realtime || channel.delivery !== "append" || channel.sequence !== "none") {
    return null;
  }
  if (liveTransport(channel)) return "live_observational";
  return channel.realtime_transports?.includes("rest_poll")
    ? "polling_observational"
    : null;
}

export function exchangeMarketProductSupport(
  exchange: ExchangeCapabilityPayload | null | undefined,
  marketType: string,
): ExchangeMarketProductPayload | null {
  if (!exchange) return null;
  const normalizedMarket = marketType.trim().toLowerCase();
  const projected = exchange.support?.products?.markets?.[normalizedMarket];
  if (projected) return projected;

  // Backward-compatible projection for a server that has not restarted yet.
  // It remains capability-driven and does not restore an exchange allowlist.
  const channels = exchangeChannelsForMarket(exchange, normalizedMarket);
  const depth = channels.find((channel) => channel.channel.toLowerCase() === "depth");
  const fullDepth = channels.find((channel) => channel.channel.toLowerCase() === "full_depth");
  const aggregateTrade = channels.find((channel) => channel.channel.toLowerCase() === "agg_trade");
  const trade = channels.find((channel) => channel.channel.toLowerCase() === "trade");
  const strictTrade = Boolean(liveTransport(aggregateTrade)
    && aggregateTrade?.history === true
    && aggregateTrade.delivery === "append"
    && aggregateTrade.sequence === "monotonic_id"
    && aggregateTrade.resync === "snapshot_replay"
    && aggregateTrade.history_transports?.includes("rest_history"));
  const tradeDeliveryMode = trade?.delivery === "append"
    ? (liveTransport(trade)
        ? "live_stream"
        : trade.realtime_transports?.includes("rest_poll")
          ? "polling_observational"
          : null)
    : null;
  const observationalTrade = tradeDeliveryMode !== null;
  const depthSnapshotMode = snapshotBookMode(depth);
  const strictBook = Boolean(liveTransport(fullDepth)
    && fullDepth?.delivery === "ordered_delta"
    && fullDepth.snapshot === true
    && fullDepth.delta === true
    && typeof fullDepth.sequence === "string"
    && fullDepth.sequence !== "none");
  const kline = channels.find((channel) => channel.channel.toLowerCase() === "kline");
  const advancedChannels: Record<string, ExchangeAdvancedChannelProductPayload> = Object.fromEntries(
    ADVANCED_STATE_CHANNELS.map((channelName) => {
      const channel = channels.find((item) => item.channel.toLowerCase() === channelName);
      const deliveryMode = stateDeliveryMode(channel);
      return [channelName, {
        supported: deliveryMode !== null,
        realtime: channel?.realtime === true,
        history: channel?.history === true,
        delivery_mode: deliveryMode,
      }];
    }),
  );
  const liquidation = channels.find((channel) => channel.channel.toLowerCase() === "liquidation");
  const liquidationMode = observationalDeliveryMode(liquidation);
  advancedChannels.liquidation = {
    supported: liquidationMode !== null,
    realtime: liquidation?.realtime === true,
    history: liquidation?.history === true,
    delivery_mode: liquidationMode,
  };
  const mark = advancedChannels.mark_price!;
  const index = advancedChannels.index_price!;
  const basisSupported = mark.realtime && mark.supported && index.realtime && index.supported;
  advancedChannels.basis = {
    supported: basisSupported,
    realtime: basisSupported,
    history: false,
    delivery_mode: basisSupported
      ? mark.delivery_mode === "live_snapshot" && index.delivery_mode === "live_snapshot"
        ? "derived_live"
        : "derived_polling"
      : null,
  };
  return {
    chart: Boolean(kline?.realtime || kline?.history),
    order_book: {
      supported: depthSnapshotMode !== null,
      channel: depthSnapshotMode !== null ? "depth" : null,
      mode: depthSnapshotMode !== null ? "snapshot" : null,
      snapshot_mode: depthSnapshotMode,
      strict_full_depth: strictBook,
    },
    trade_flow: {
      supported: strictTrade || observationalTrade,
      channel: strictTrade ? "agg_trade" : observationalTrade ? "trade" : null,
      mode: strictTrade ? "strict_repairable" : observationalTrade ? "observational" : null,
      sequence_continuity: strictTrade,
      history: strictTrade,
      delivery_mode: strictTrade ? "live_stream" : tradeDeliveryMode,
    },
    advanced_market_data: {
      supported: Object.values(advancedChannels).some((item) => item.supported),
      channels: advancedChannels,
    },
  };
}

export function supportsOrderBookProduct(
  exchange: ExchangeCapabilityPayload | null | undefined,
  marketType: string,
): boolean {
  return exchangeMarketProductSupport(exchange, marketType)?.order_book.supported === true;
}

export function supportsTradeFlowProduct(
  exchange: ExchangeCapabilityPayload | null | undefined,
  marketType: string,
): boolean {
  return exchangeMarketProductSupport(exchange, marketType)?.trade_flow.supported === true;
}

export function exchangeProductSurfaces(
  exchange: ExchangeCapabilityPayload,
): ExchangeProductSurfaceSupport {
  const channels = exchange.channels || [];
  const chart = channels.some((channel) => (
    channel.channel.toLowerCase() === "kline"
    && (channel.realtime || channel.history)
  ));
  const advancedMarketData = exchange.markets.some((market) => (
    exchangeMarketProductSupport(exchange, market.market_type)
      ?.advanced_market_data.supported === true
  ));
  const orderBook = exchange.markets.some((market) => (
    supportsOrderBookProduct(exchange, market.market_type)
  ));
  const tradeFlow = exchange.markets.some((market) => (
    supportsTradeFlowProduct(exchange, market.market_type)
  ));
  return { chart, advancedMarketData, orderBook, tradeFlow };
}

export function filterExchangeCapabilities(
  exchanges: readonly ExchangeCapabilityPayload[],
  search: string,
  filter: ExchangeSupportFilter,
  currentExchange = "",
): ExchangeCapabilityPayload[] {
  const normalizedSearch = search.trim().toLowerCase();
  const normalizedCurrent = currentExchange.trim().toLowerCase();
  return exchanges
    .filter((exchange) => {
      if (normalizedSearch && !`${exchange.name} ${exchange.exchange}`.toLowerCase().includes(normalizedSearch)) {
        return false;
      }
      if (filter === "primary") return exchangeProvider(exchange) === "ccxt_primary";
      if (filter === "streaming") return exchangeHasPluginStream(exchange);
      if (filter === "polling") return exchangeIsPollingOnly(exchange);
      if (filter === "derivatives") return exchangeHasDerivatives(exchange);
      if (filter === "unroutable") return !exchangeIsRoutable(exchange);
      return true;
    })
    .sort((left, right) => {
      const leftCurrent = left.exchange.toLowerCase() === normalizedCurrent ? 0 : 1;
      const rightCurrent = right.exchange.toLowerCase() === normalizedCurrent ? 0 : 1;
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
      const leftRoutable = exchangeIsRoutable(left) ? 0 : 1;
      const rightRoutable = exchangeIsRoutable(right) ? 0 : 1;
      if (leftRoutable !== rightRoutable) return leftRoutable - rightRoutable;
      const leftPrimary = exchangeProvider(left) === "ccxt_primary" ? 0 : 1;
      const rightPrimary = exchangeProvider(right) === "ccxt_primary" ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      return left.name.localeCompare(right.name);
    });
}
