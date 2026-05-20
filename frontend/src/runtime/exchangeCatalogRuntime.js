import { useEffect, useState } from "react";
import { fetchExchanges } from "../services/api";
import { groupIntervalsByDuration, parseIntervalSeconds } from "../utils/intervals";

const EXCHANGE_INTERVALS = {
  binance: {
    label: "Binance",
    intervals: [
      { value: "1s", label: "1s", seconds: 1 },
      { value: "1m", label: "1m", seconds: 60 },
      { value: "3m", label: "3m", seconds: 180 },
      { value: "5m", label: "5m", seconds: 300 },
      { value: "15m", label: "15m", seconds: 900 },
      { value: "30m", label: "30m", seconds: 1800 },
      { value: "1h", label: "1H", seconds: 3600 },
      { value: "2h", label: "2H", seconds: 7200 },
      { value: "4h", label: "4H", seconds: 14400 },
      { value: "6h", label: "6H", seconds: 21600 },
      { value: "8h", label: "8H", seconds: 28800 },
      { value: "12h", label: "12H", seconds: 43200 },
      { value: "1d", label: "1D", seconds: 86400 },
      { value: "3d", label: "3D", seconds: 259200 },
      { value: "1w", label: "1W", seconds: 604800 },
      { value: "1M", label: "1M", seconds: 2592000 },
    ],
    intervalDays: {
      "1s": 0.04, "1m": 1, "3m": 2, "5m": 3, "15m": 7, "30m": 14,
      "1h": 30, "2h": 60, "4h": 90, "6h": 120, "8h": 180, "12h": 180,
      "1d": 365, "3d": 730, "1w": 1095, "1M": 1095,
    },
  },
  okx: {
    label: "OKX",
    intervals: [
      { value: "1s", label: "1s", seconds: 1 },
      { value: "1m", label: "1m", seconds: 60 },
      { value: "3m", label: "3m", seconds: 180 },
      { value: "5m", label: "5m", seconds: 300 },
      { value: "15m", label: "15m", seconds: 900 },
      { value: "30m", label: "30m", seconds: 1800 },
      { value: "1h", label: "1H", seconds: 3600 },
      { value: "2h", label: "2H", seconds: 7200 },
      { value: "4h", label: "4H", seconds: 14400 },
      { value: "6h", label: "6H", seconds: 21600 },
      { value: "12h", label: "12H", seconds: 43200 },
      { value: "1d", label: "1D", seconds: 86400 },
      { value: "3d", label: "3D", seconds: 259200 },
      { value: "1w", label: "1W", seconds: 604800 },
      { value: "1M", label: "1M", seconds: 2592000 },
    ],
    intervalDays: {
      "1s": 0.04, "1m": 1, "3m": 2, "5m": 3, "15m": 7, "30m": 14,
      "1h": 30, "2h": 60, "4h": 90, "6h": 120, "12h": 180,
      "1d": 365, "3d": 730, "1w": 1095, "1M": 1095,
    },
  },
};

function labelInterval(value) {
  const match = String(value || "").match(/^(\d+)([a-zA-Z]+)$/);
  if (!match) return String(value || "");
  const [, amount, unit] = match;
  return ["h", "d", "w", "M"].includes(unit) ? `${amount}${unit.toUpperCase()}` : `${amount}${unit}`;
}

function intervalItemFromValue(value) {
  const seconds = parseIntervalSeconds(value);
  if (!seconds) return null;
  return { value, label: labelInterval(value), seconds };
}

function buildExchangeCatalog(exchanges) {
  const catalog = {};
  for (const item of exchanges || []) {
    const exchangeId = String(item.exchange || "").toLowerCase();
    if (!exchangeId) continue;
    const fallback = EXCHANGE_INTERVALS[exchangeId] || {};
    const intervals = (item.native_intervals || [])
      .map(intervalItemFromValue)
      .filter(Boolean);
    catalog[exchangeId] = {
      id: exchangeId,
      label: item.name || fallback.label || labelInterval(exchangeId),
      markets: Array.isArray(item.markets) ? item.markets : [],
      nativeIntervals: intervals.length > 0 ? intervals : (fallback.intervals || []),
      intervalDays: fallback.intervalDays || {},
      protocolFeatures: new Set(item.protocol_features || []),
      limits: item.limits || {},
      knownLimitations: item.known_limitations || [],
      wsConnectionModel: item.ws_connection_model || "path_per_stream",
      raw: item,
    };
  }
  return catalog;
}

export function getExchangeConfig(exchange, catalog = null) {
  const key = String(exchange || "binance").toLowerCase();
  return catalog?.[key] || {
    id: key,
    label: EXCHANGE_INTERVALS[key]?.label || labelInterval(key),
    markets: [],
    nativeIntervals: EXCHANGE_INTERVALS[key]?.intervals || EXCHANGE_INTERVALS.binance.intervals,
    intervalDays: EXCHANGE_INTERVALS[key]?.intervalDays || {},
    protocolFeatures: new Set(),
    limits: {},
    knownLimitations: [],
    wsConnectionModel: "path_per_stream",
    raw: null,
  };
}

export function getNativeIntervals(exchange, catalog = null) {
  return getExchangeConfig(exchange, catalog).nativeIntervals;
}

export function getBaseWsIntervals(exchange, catalog = null) {
  const config = getExchangeConfig(exchange, catalog);
  if (config.protocolFeatures.has("ws.polling_only") || config.wsConnectionModel === "polling_only") {
    return [];
  }
  return config.nativeIntervals.map((i) => i.value);
}

export function buildSortedIntervals(savedCustom, exchange = "binance", catalog = null) {
  const native = getNativeIntervals(exchange, catalog);
  const all = native.map((i) => ({ ...i, isCustom: false }));
  for (const intv of savedCustom) {
    const secs = parseIntervalSeconds(intv);
    if (secs && !all.some((a) => a.value === intv)) {
      all.push({ value: intv, label: intv, seconds: secs, isCustom: true });
    }
  }
  return groupIntervalsByDuration(all);
}

export function getIntervalDays(intv, exchange = "binance") {
  const config = EXCHANGE_INTERVALS[exchange] || EXCHANGE_INTERVALS.binance;
  if (config.intervalDays[intv]) return config.intervalDays[intv];
  const secs = parseIntervalSeconds(intv);
  if (!secs) return 7;
  if (secs <= 1) return 1;
  if (secs <= 60) return 1;
  if (secs <= 300) return 3;
  if (secs <= 900) return 7;
  if (secs <= 1800) return 14;
  if (secs <= 3600) return 30;
  if (secs <= 14400) return 90;
  if (secs <= 43200) return 180;
  return 365;
}

export function isNativeIntervalSupported(exchange, interval, catalog = null) {
  return getNativeIntervals(exchange, catalog).some((item) => item.value === interval);
}

export function useExchangeCatalog() {
  const [exchangeCatalog, setExchangeCatalog] = useState({});
  const [exchangeCatalogStatus, setExchangeCatalogStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    fetchExchanges()
      .then((payload) => {
        if (cancelled) return;
        setExchangeCatalog(buildExchangeCatalog(payload?.exchanges || []));
        setExchangeCatalogStatus("ready");
      })
      .catch((err) => {
        console.warn("Failed to load exchange capabilities:", err);
        if (!cancelled) setExchangeCatalogStatus("fallback");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { exchangeCatalog, exchangeCatalogStatus };
}
