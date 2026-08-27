import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExchangeCapabilityPayload,
  ExchangeChannelCapabilityPayload,
} from "../../../services/apiPayloadParsers.js";
import {
  exchangeChannelsForMarket,
  exchangeHasPluginStream,
  exchangeIsPollingOnly,
  exchangeIsRoutable,
  exchangeMarketProductSupport,
  exchangeProductSurfaces,
  filterExchangeCapabilities,
} from "../exchangeSupportModel.js";

function channel(
  name: string,
  marketTypes: string[],
  realtimeTransports: string[],
  history = false,
): ExchangeChannelCapabilityPayload {
  const payload: ExchangeChannelCapabilityPayload = {
    channel: name,
    market_types: marketTypes,
    realtime: true,
    history,
    realtime_transports: realtimeTransports,
    history_transports: history ? ["rest_history"] : [],
    params: {},
  };
  if (name === "depth") {
    payload.delivery = "snapshot";
    payload.snapshot = true;
  }
  if (name === "trade") {
    payload.delivery = "append";
    payload.sequence = "none";
  }
  if (name === "agg_trade") {
    payload.delivery = "append";
    payload.sequence = "monotonic_id";
    payload.resync = "snapshot_replay";
  }
  if (name === "full_depth") {
    payload.delivery = "ordered_delta";
    payload.snapshot = true;
    payload.delta = true;
    payload.sequence = "range";
  }
  if (["mark_price", "index_price", "funding_rate", "open_interest"].includes(name)) {
    payload.delivery = "latest";
    payload.snapshot = true;
  }
  if (name === "liquidation") {
    payload.delivery = "append";
    payload.sequence = "none";
  }
  return payload;
}

function capability({
  exchange,
  markets = ["spot"],
  channels = [],
  provider = "ccxt_unified",
  routable = true,
}: {
  exchange: string;
  markets?: string[];
  channels?: ExchangeChannelCapabilityPayload[];
  provider?: "ccxt_primary" | "ccxt_unified" | "plugin";
  routable?: boolean;
}): ExchangeCapabilityPayload {
  return {
    exchange,
    name: exchange.toUpperCase(),
    markets: markets.map((marketType) => ({
      market_type: marketType,
      product_type: marketType.split(".")[0] || marketType,
      label: marketType,
    })),
    native_intervals: [],
    capability_schema_version: 3,
    channels,
    protocol_features: [`provider.${provider}`],
    limits: {},
    known_limitations: [],
    support: {
      provider,
      routable,
      verification_level: routable ? "capability_contract" : "catalog_only",
      qualification: null,
      qualifications: [],
      products: { markets: {} },
    },
  };
}

test("support metadata prevents catalog-only exchanges from being presented as routable", () => {
  const catalogOnly = capability({ exchange: "aster", markets: [], routable: false });
  assert.equal(exchangeIsRoutable(catalogOnly), false);
  assert.deepEqual(
    filterExchangeCapabilities([catalogOnly], "", "unroutable").map((item) => item.exchange),
    ["aster"],
  );
});

test("streaming and polling filters use declared transport semantics", () => {
  const streaming = capability({
    exchange: "bybit",
    channels: [channel("kline", ["spot"], ["plugin_stream", "rest_poll"], true)],
  });
  const polling = capability({
    exchange: "alpaca",
    channels: [channel("kline", ["spot"], ["rest_poll"], true)],
  });

  assert.equal(exchangeHasPluginStream(streaming), true);
  assert.equal(exchangeIsPollingOnly(streaming), false);
  assert.equal(exchangeHasPluginStream(polling), false);
  assert.equal(exchangeIsPollingOnly(polling), true);
  assert.deepEqual(
    filterExchangeCapabilities([polling, streaming], "", "streaming").map((item) => item.exchange),
    ["bybit"],
  );
});

test("market channel projection does not leak capabilities across market types", () => {
  const exchange = capability({
    exchange: "sample",
    markets: ["spot", "swap.linear"],
    channels: [
      channel("kline", ["spot", "swap.linear"], ["rest_poll"], true),
      channel("funding_rate", ["swap.linear"], ["rest_poll"], true),
    ],
  });

  assert.deepEqual(
    exchangeChannelsForMarket(exchange, "spot").map((item) => item.channel),
    ["kline"],
  );
  assert.deepEqual(
    exchangeChannelsForMarket(exchange, "swap.linear").map((item) => item.channel),
    ["kline", "funding_rate"],
  );
});

test("product surfaces distinguish observational and strict multi-exchange products", () => {
  const bybit = capability({
    exchange: "bybit",
    markets: ["spot", "swap.linear"],
    channels: [
      channel("kline", ["spot", "swap.linear"], ["plugin_stream"], true),
      channel("depth", ["spot", "swap.linear"], ["plugin_stream"]),
      channel("trade", ["spot", "swap.linear"], ["plugin_stream"]),
      channel("funding_rate", ["swap.linear"], ["rest_poll"], true),
    ],
  });
  const binance = capability({
    exchange: "binance",
    markets: ["spot", "futures"],
    provider: "ccxt_primary",
    channels: [
      channel("kline", ["spot", "futures"], ["plugin_stream"], true),
      channel("depth", ["spot", "futures"], ["plugin_stream"]),
      channel("agg_trade", ["spot", "futures"], ["plugin_stream"], true),
      channel("full_depth", ["spot", "futures"], ["plugin_stream", "rest_snapshot"]),
    ],
  });

  assert.deepEqual(exchangeProductSurfaces(bybit), {
    chart: true,
    advancedMarketData: true,
    orderBook: true,
    tradeFlow: true,
  });
  assert.deepEqual(exchangeProductSurfaces(binance), {
    chart: true,
    advancedMarketData: false,
    orderBook: true,
    tradeFlow: true,
  });
  assert.equal(exchangeMarketProductSupport(bybit, "swap.linear")?.trade_flow.mode, "observational");
  assert.equal(
    exchangeMarketProductSupport(bybit, "swap.linear")?.trade_flow.delivery_mode,
    "live_stream",
  );
  assert.deepEqual(
    exchangeMarketProductSupport(bybit, "swap.linear")?.advanced_market_data.channels.funding_rate,
    {
      supported: true,
      realtime: true,
      history: true,
      delivery_mode: "polling_snapshot",
    },
  );
  assert.equal(exchangeMarketProductSupport(binance, "futures")?.trade_flow.mode, "strict_repairable");
  assert.equal(exchangeMarketProductSupport(bybit, "spot")?.order_book.strict_full_depth, false);
  assert.equal(exchangeMarketProductSupport(binance, "spot")?.order_book.strict_full_depth, true);
  assert.equal(
    exchangeMarketProductSupport(bybit, "spot")?.order_book.snapshot_mode,
    "live_snapshot",
  );
});

test("REST-only trades and advanced state are projected as honest polling products", () => {
  const restOnly = capability({
    exchange: "bigone",
    markets: ["swap.linear"],
    channels: [
      channel("trade", ["swap.linear"], ["rest_poll"]),
      channel("open_interest", ["swap.linear"], ["rest_poll"], true),
      channel("liquidation", ["swap.linear"], ["rest_poll"]),
    ],
  });

  assert.deepEqual(exchangeMarketProductSupport(restOnly, "swap.linear")?.trade_flow, {
    supported: true,
    channel: "trade",
    mode: "observational",
    sequence_continuity: false,
    history: false,
    delivery_mode: "polling_observational",
  });
  assert.equal(
    exchangeMarketProductSupport(restOnly, "swap.linear")
      ?.advanced_market_data.channels.open_interest?.delivery_mode,
    "polling_snapshot",
  );
  assert.equal(
    exchangeMarketProductSupport(restOnly, "swap.linear")
      ?.advanced_market_data.channels.liquidation?.delivery_mode,
    "polling_observational",
  );
});

test("REST-only depth is projected as a polling order-book snapshot", () => {
  const restOnly = capability({
    exchange: "bigone",
    channels: [channel("depth", ["spot"], ["rest_snapshot"])],
  });

  assert.equal(exchangeProductSurfaces(restOnly).orderBook, true);
  assert.deepEqual(exchangeMarketProductSupport(restOnly, "spot")?.order_book, {
    supported: true,
    channel: "depth",
    mode: "snapshot",
    snapshot_mode: "polling_snapshot",
    strict_full_depth: false,
  });
});

test("directory sorting keeps the active exchange first", () => {
  const binance = capability({ exchange: "binance", provider: "ccxt_primary" });
  const okx = capability({ exchange: "okx", provider: "ccxt_primary" });
  assert.deepEqual(
    filterExchangeCapabilities([binance, okx], "", "all", "okx").map((item) => item.exchange),
    ["okx", "binance"],
  );
});
