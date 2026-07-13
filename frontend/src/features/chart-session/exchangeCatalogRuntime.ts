import { useEffect, useState } from "react";
import { fetchExchanges } from "../../services/api.js";
import type { ExchangeCapabilityPayload } from "../../services/apiPayloadParsers.js";
import { groupIntervalsByDuration, parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import type {
  AvailableInterval,
  ExchangeCatalog,
  ExchangeCatalogEntry,
  ExchangeCatalogRuntime,
  ExchangeCatalogStatus,
  GroupedAvailableIntervals,
  IntervalDayMap,
  NativeInterval,
} from "./chartSessionTypes.js";

interface ExchangeIntervalFallback {
  label: string;
  intervals: NativeInterval[];
  intervalDays: IntervalDayMap;
}

const EXCHANGE_INTERVALS: Record<string, ExchangeIntervalFallback> = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIntervalDayMap(value: unknown): IntervalDayMap {
  if (!value) return {};
  if (Array.isArray(value)) {
    const entries: Array<[string, number]> = [];
    for (const item of value) {
      if (!isRecord(item)) continue;
      const interval = item.interval ?? item.value;
      const days = item.days ?? item.history_days ?? item.default_days;
      if ((typeof interval !== "string" && typeof interval !== "number")
        || !Number.isFinite(Number(days))) continue;
      entries.push([String(interval), Number(days)]);
    }
    return Object.fromEntries(entries);
  }
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, days]) => Number.isFinite(Number(days)))
      .map(([interval, days]) => [interval, Number(days)]),
  );
}

function getCapabilityIntervalDays(item: ExchangeCapabilityPayload): IntervalDayMap {
  return {
    ...normalizeIntervalDayMap(item.default_history_days),
    ...normalizeIntervalDayMap(item.default_history_days_by_interval),
    ...normalizeIntervalDayMap(item.history_window_days),
    ...normalizeIntervalDayMap(item.history_windows),
  };
}

function labelInterval(value: unknown): string {
  const match = String(value || "").match(/^(\d+)([a-zA-Z]+)$/);
  if (!match) return String(value || "");
  const [, amount, unit] = match;
  return ["h", "d", "w", "M"].includes(unit) ? `${amount}${unit.toUpperCase()}` : `${amount}${unit}`;
}

function intervalItemFromValue(value: unknown): NativeInterval | null {
  const seconds = parseIntervalSeconds(value);
  if (!seconds) return null;
  return { value: String(value), label: labelInterval(value), seconds };
}

function buildExchangeCatalog(
  exchanges: readonly ExchangeCapabilityPayload[],
): ExchangeCatalog {
  const catalog: ExchangeCatalog = {};
  for (const item of exchanges || []) {
    const exchangeId = String(item.exchange || "").toLowerCase();
    if (!exchangeId) continue;
    const fallback = EXCHANGE_INTERVALS[exchangeId] || {};
    const intervals = (item.native_intervals || [])
      .map(intervalItemFromValue)
      .filter((interval): interval is NativeInterval => interval !== null);
    const capabilityIntervalDays = getCapabilityIntervalDays(item);
    const fallbackIntervalDays = fallback.intervalDays || {};
    catalog[exchangeId] = {
      id: exchangeId,
      label: item.name || fallback.label || labelInterval(exchangeId),
      markets: Array.isArray(item.markets) ? item.markets : [],
      nativeIntervals: intervals.length > 0 ? intervals : (fallback.intervals || []),
      intervalDays: Object.keys(capabilityIntervalDays).length > 0
        ? capabilityIntervalDays
        : fallbackIntervalDays,
      intervalDaysSource: Object.keys(capabilityIntervalDays).length > 0 ? "capability" : "fallback",
      protocolFeatures: new Set(item.protocol_features || []),
      limits: item.limits || {},
      knownLimitations: item.known_limitations || [],
      wsConnectionModel: typeof item.ws_connection_model === "string"
        ? item.ws_connection_model
        : "path_per_stream",
      raw: item,
    };
  }
  return catalog;
}

export function getExchangeConfig(
  exchange: unknown,
  catalog: ExchangeCatalog | null = null,
): ExchangeCatalogEntry {
  const key = String(exchange || "binance").toLowerCase();
  return catalog?.[key] || {
    id: key,
    label: EXCHANGE_INTERVALS[key]?.label || labelInterval(key),
    markets: [],
    nativeIntervals: EXCHANGE_INTERVALS[key]?.intervals || EXCHANGE_INTERVALS.binance.intervals,
    intervalDays: EXCHANGE_INTERVALS[key]?.intervalDays || {},
    intervalDaysSource: "fallback",
    protocolFeatures: new Set<string>(),
    limits: {},
    knownLimitations: [],
    wsConnectionModel: "path_per_stream",
    raw: null,
  };
}

export function getNativeIntervals(
  exchange: unknown,
  catalog: ExchangeCatalog | null = null,
): NativeInterval[] {
  return getExchangeConfig(exchange, catalog).nativeIntervals;
}

export function getBaseWsIntervals(
  exchange: unknown,
  catalog: ExchangeCatalog | null = null,
): IntervalString[] {
  const config = getExchangeConfig(exchange, catalog);
  if (config.protocolFeatures.has("ws.polling_only") || config.wsConnectionModel === "polling_only") {
    return [];
  }
  return config.nativeIntervals.map((i) => i.value);
}

export function buildSortedIntervals(
  savedCustom: readonly IntervalString[],
  exchange: unknown = "binance",
  catalog: ExchangeCatalog | null = null,
): GroupedAvailableIntervals {
  const native = getNativeIntervals(exchange, catalog);
  const all: AvailableInterval[] = native.map((i) => ({ ...i, isCustom: false }));
  for (const intv of savedCustom) {
    const secs = parseIntervalSeconds(intv);
    if (secs && !all.some((a) => a.value === intv)) {
      all.push({ value: intv, label: intv, seconds: secs, isCustom: true });
    }
  }
  return groupIntervalsByDuration(all);
}

export function getIntervalDays(
  intv: IntervalString,
  exchange: unknown = "binance",
  catalog: ExchangeCatalog | null = null,
): number {
  const config = getExchangeConfig(exchange, catalog);
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

export function isNativeIntervalSupported(
  exchange: unknown,
  interval: IntervalString,
  catalog: ExchangeCatalog | null = null,
): boolean {
  return getNativeIntervals(exchange, catalog).some((item) => item.value === interval);
}

export function useExchangeCatalog(): ExchangeCatalogRuntime {
  const [exchangeCatalog, setExchangeCatalog] = useState<ExchangeCatalog>({});
  const [exchangeCatalogStatus, setExchangeCatalogStatus] = useState<ExchangeCatalogStatus>("loading");

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
