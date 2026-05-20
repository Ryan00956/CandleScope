export function formatPrice(price) {
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

export function formatPriceDiff(diff) {
  if (diff == null) return "--";
  const abs = Math.abs(diff);
  let raw;
  if (abs >= 1000) raw = abs.toFixed(2);
  else if (abs >= 1) raw = abs.toFixed(4);
  else raw = abs.toFixed(8);
  return parseFloat(raw).toString();
}

export function formatVolume(volume) {
  if (volume == null) return "--";
  if (volume >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(2)}B`;
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(2)}K`;
  return volume.toFixed(2);
}

export function buildChartDisplayState({
  crosshairData,
  lastPrice,
  wsStatus,
  exchange,
  exchangeConfig,
  marketType,
}) {
  const displayData = crosshairData || lastPrice;
  const priceChange = displayData ? ((displayData.close - displayData.open) / displayData.open) * 100 : 0;
  const isUp = priceChange >= 0;
  const amplitude = displayData?.open
    ? ((displayData.high - displayData.low) / displayData.open * 100).toFixed(2)
    : "0.00";
  const wsStatusLabel = {
    idle: "Realtime idle",
    loading: "Realtime waiting",
    connecting: "Connecting WS...",
    live: "Live (WebSocket)",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    fallback: "Live (Polling fallback)",
    mock: "Mock mode",
  }[wsStatus] || "Unknown";
  const exchangeLabel = exchangeConfig.label || (
    exchange ? `${exchange.charAt(0).toUpperCase()}${exchange.slice(1)}` : "Unknown"
  );
  const marketLabel = exchangeConfig.markets.find((item) => item.market_type === marketType)?.label
    || (marketType === "futures" ? "Futures" : "Spot");

  return {
    displayData,
    priceChange,
    isUp,
    amplitude,
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  };
}
