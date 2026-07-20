import type { MarketSummary } from "./klineContracts.js";

export interface MarketDisplayData {
  time?: unknown;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
interface ExchangeMarketConfig {
  market_type: string;
  label?: string;
}

interface ExchangeConfig {
  label?: string;
  markets: readonly ExchangeMarketConfig[];
}

interface ChartDisplayStateOptions {
  crosshairData?: MarketDisplayData | null;
  lastPrice?: MarketDisplayData | null;
  wsStatus?: string;
  exchange?: string;
  exchangeConfig: ExchangeConfig;
  marketType?: string;
}

export function formatPrice(price: number | null | undefined): string {
  if (price == null) return "--";
  if (price >= 1000) {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(8);
}

export function formatPriceDiff(diff: number | null | undefined): string {
  if (diff == null) return "--";
  const abs = Math.abs(diff);
  let raw: string;
  if (abs >= 1000) raw = abs.toFixed(2);
  else if (abs >= 1) raw = abs.toFixed(4);
  else raw = abs.toFixed(8);
  return parseFloat(raw).toString();
}

export function formatVolume(volume: number | null | undefined): string {
  if (volume == null) return "--";
  if (volume >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(2)}B`;
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(2)}K`;
  return volume.toFixed(2);
}

export function buildMarketSummary(
  displayData: MarketDisplayData | null | undefined,
): MarketSummary & { displayData: MarketDisplayData | null } {
  const normalizedDisplayData = displayData || null;
  const priceChange = normalizedDisplayData
    ? ((normalizedDisplayData.close - normalizedDisplayData.open) / normalizedDisplayData.open) * 100
    : 0;
  const isUp = priceChange >= 0;
  const amplitude = normalizedDisplayData?.open
    ? ((normalizedDisplayData.high - normalizedDisplayData.low) / normalizedDisplayData.open * 100).toFixed(2)
    : "0.00";

  return {
    displayData: normalizedDisplayData,
    priceChange,
    isUp,
    amplitude,
  };
}

export function buildChartDisplayState({
  crosshairData,
  lastPrice,
  wsStatus,
  exchange,
  exchangeConfig,
  marketType,
}: ChartDisplayStateOptions): Omit<MarketSummary, "displayData"> & {
  displayData: MarketDisplayData | null;
  wsStatusLabel: string;
  exchangeLabel: string;
  marketLabel: string;
} {
  const displayData = crosshairData || lastPrice || null;
  const marketSummary = buildMarketSummary(displayData);
  const wsStatusLabel = {
    idle: "Realtime idle",
    loading: "Realtime waiting",
    connecting: "Connecting WS...",
    live: "Live (WebSocket)",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    fallback: "Polling fallback",
    mock: "Mock mode",
  }[wsStatus || ""] || "Unknown";
  const exchangeLabel = exchangeConfig.label || (
    exchange ? `${exchange.charAt(0).toUpperCase()}${exchange.slice(1)}` : "Unknown"
  );
  const marketLabel = exchangeConfig.markets.find((item) => item.market_type === marketType)?.label
    || (marketType === "futures" ? "Futures" : "Spot");

  return {
    ...marketSummary,
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  };
}
