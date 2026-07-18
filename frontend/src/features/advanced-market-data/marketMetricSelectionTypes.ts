export const MARKET_METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "market:funding-rate",
    channel: "funding_rate",
  }),
  Object.freeze({
    id: "market:open-interest",
    channel: "open_interest",
  }),
  Object.freeze({
    id: "market:liquidations",
    channel: "liquidation",
  }),
] as const);

export type MarketMetricId = (typeof MARKET_METRIC_DEFINITIONS)[number]["id"];
export type MarketMetricChannel = (typeof MARKET_METRIC_DEFINITIONS)[number]["channel"];
export type MarketStateMetricChannel = Exclude<MarketMetricChannel, "liquidation">;

export function isMarketStateMetricChannel(
  value: MarketMetricChannel,
): value is MarketStateMetricChannel {
  return value === "funding_rate" || value === "open_interest";
}

export interface MarketMetricSelectionItem {
  readonly id: MarketMetricId;
  readonly channel: MarketMetricChannel;
  readonly added: boolean;
  readonly visible: boolean;
}

export type MarketMetricSelectionSnapshot = readonly MarketMetricSelectionItem[];

export function isMarketMetricId(value: unknown): value is MarketMetricId {
  return MARKET_METRIC_DEFINITIONS.some((definition) => definition.id === value);
}

export function createDefaultMarketMetricSelection(): MarketMetricSelectionSnapshot {
  return Object.freeze(MARKET_METRIC_DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    added: false,
    visible: false,
  })));
}
