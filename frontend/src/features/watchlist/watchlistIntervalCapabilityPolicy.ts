import {
  getBaseWsIntervals,
  getNativeIntervals,
} from "../chart-session/exchangeCatalogRuntime.js";
import type {
  ExchangeCatalog,
  ExchangeCatalogStatus,
  NativeInterval,
  NativeIntervalPurpose,
} from "../chart-session/chartSessionTypes.js";

export interface WatchlistIntervalCapabilityOptions {
  exchange: string;
  marketType: string;
  purpose: NativeIntervalPurpose;
  exchangeCatalog: ExchangeCatalog | null;
  exchangeCatalogStatus: ExchangeCatalogStatus;
}

function targetCapabilityMayResolve({
  exchange,
  exchangeCatalog,
  exchangeCatalogStatus,
}: WatchlistIntervalCapabilityOptions): boolean {
  if (exchangeCatalogStatus === "loading") return false;
  if (exchangeCatalogStatus === "ready") {
    return Boolean(exchangeCatalog?.[String(exchange).toLowerCase()]);
  }
  return true;
}

export function resolveWatchlistNativeIntervals({
  exchange,
  marketType,
  purpose,
  exchangeCatalog,
  exchangeCatalogStatus,
}: WatchlistIntervalCapabilityOptions): NativeInterval[] {
  const options = {
    exchange,
    marketType,
    purpose,
    exchangeCatalog,
    exchangeCatalogStatus,
  };
  if (!targetCapabilityMayResolve(options)) return [];

  // A fallback status is an explicit decision to use the built-in capability
  // table. Do not accidentally revive a stale or partial catalog entry.
  const resolvedCatalog = exchangeCatalogStatus === "fallback"
    ? null
    : exchangeCatalog;

  const nativeIntervals = getNativeIntervals(
    exchange,
    resolvedCatalog,
    marketType,
    purpose,
  );
  if (purpose === "history") return nativeIntervals;

  const websocketIntervals = new Set(getBaseWsIntervals(
    exchange,
    resolvedCatalog,
    marketType,
  ));
  return nativeIntervals.filter((item) => websocketIntervals.has(item.value));
}
