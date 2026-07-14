import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  fetchSubscriptions,
  getPriceStreamUrl,
  syncWatchlistSymbols,
  updateSubscriptionTier,
} from "../../services/api.js";
import type { SubscriptionListPayload, SubscriptionPayload } from "../../services/apiPayloadParsers.js";
import { getNativeIntervals } from "../chart-session/exchangeCatalogRuntime.js";
import type {
  CustomIntervalRecord,
  ExchangeCatalog,
  NativeInterval,
} from "../chart-session/chartSessionTypes.js";
import { parseSymbolKey } from "../../utils/symbolKey.js";
import {
  getFullSubscriptionResourceSummary,
  getSubscriptionTierRequestOptions,
} from "./watchlistSubscriptionPolicy.js";
import type { SubscriptionTier, WatchlistGroup } from "./watchlistTypes.js";

const WATCHLIST_SYNC_DEBOUNCE_MS = 500;
const PRICE_WS_RECONNECT_MS = 3_000;

export interface WatchlistSubscriptionContext {
  exchange?: string;
  exchangeCatalog?: ExchangeCatalog | null;
  nativeIntervals?: NativeInterval[];
  customIntervalRecords?: CustomIntervalRecord[];
}

export interface WatchlistPriceTick extends Record<string, unknown> {
  symbol: string;
  price?: number;
  open?: number;
  daily_change?: number;
  daily_change_pct?: number;
  change_pct?: number;
}

export interface UseWatchlistSubscriptionRuntimeOptions {
  watchlists: WatchlistGroup[];
  subscriptionContext?: WatchlistSubscriptionContext;
}

export interface WatchlistSubscriptionRuntime {
  subscriptionTiers: Record<string, SubscriptionTier>;
  subscriptionResourceSummaries: Record<string, ReturnType<typeof getFullSubscriptionResourceSummary>>;
  setSubscriptionTiers: Dispatch<SetStateAction<Record<string, SubscriptionTier>>>;
  symbolPrices: Record<string, WatchlistPriceTick>;
  refreshSubscriptions(): Promise<SubscriptionListPayload>;
  handleTierChange(symbol: string, tier: SubscriptionTier): void;
}

function buildTierMap(subscriptions: SubscriptionPayload[] | null | undefined): Record<string, SubscriptionTier> {
  const tiers: Record<string, SubscriptionTier> = {};
  for (const subscription of subscriptions || []) {
    tiers[subscription.symbol] = subscription.tier;
  }
  return tiers;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWatchlistPriceTick(value: unknown): WatchlistPriceTick | null {
  if (!isRecord(value)) return null;
  const record = value;
  if (typeof record.symbol !== "string") return null;
  const price = optionalFiniteNumber(record.price);
  const open = optionalFiniteNumber(record.open);
  const dailyChange = optionalFiniteNumber(record.daily_change);
  const dailyChangePercent = optionalFiniteNumber(record.daily_change_pct);
  const changePercent = optionalFiniteNumber(record.change_pct);
  const parsed: WatchlistPriceTick = {
    ...record,
    symbol: record.symbol,
  };
  delete parsed.price;
  delete parsed.open;
  delete parsed.daily_change;
  delete parsed.daily_change_pct;
  delete parsed.change_pct;
  if (price !== undefined) parsed.price = price;
  if (open !== undefined) parsed.open = open;
  if (dailyChange !== undefined) parsed.daily_change = dailyChange;
  if (dailyChangePercent !== undefined) parsed.daily_change_pct = dailyChangePercent;
  if (changePercent !== undefined) parsed.change_pct = changePercent;
  return parsed;
}

export function useWatchlistSubscriptionRuntime({
  watchlists,
  subscriptionContext = {},
}: UseWatchlistSubscriptionRuntimeOptions): WatchlistSubscriptionRuntime {
  const [subscriptionTiers, setSubscriptionTiers] = useState<Record<string, SubscriptionTier>>({});
  const [symbolPrices, setSymbolPrices] = useState<Record<string, WatchlistPriceTick>>({});
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priceWsRef = useRef<WebSocket | null>(null);
  const subscriptionTiersRef = useRef(subscriptionTiers);
  const {
    exchange = "binance",
    exchangeCatalog = null,
    nativeIntervals = [],
    customIntervalRecords = [],
  } = subscriptionContext;

  useEffect(() => {
    subscriptionTiersRef.current = subscriptionTiers;
  }, [subscriptionTiers]);

  const refreshSubscriptions = useCallback(async () => {
    const response = await fetchSubscriptions();
    setSubscriptionTiers(buildTierMap(response.subscriptions));
    return response;
  }, []);

  const resolveNativeIntervals = useCallback((symbol: string) => {
    const parsed = parseSymbolKey(symbol);
    if (parsed.exchange === exchange) return nativeIntervals;
    return getNativeIntervals(parsed.exchange, exchangeCatalog);
  }, [exchange, exchangeCatalog, nativeIntervals]);

  const subscriptionResourceSummaries = useMemo(() => {
    const summaries: Record<string, ReturnType<typeof getFullSubscriptionResourceSummary>> = {};
    const symbols = new Set(watchlists.flatMap((watchlist) => watchlist.symbols || []));
    for (const symbol of symbols) {
      summaries[symbol] = getFullSubscriptionResourceSummary({
        nativeIntervals: resolveNativeIntervals(symbol),
        customIntervalRecords,
      });
    }
    return summaries;
  }, [customIntervalRecords, resolveNativeIntervals, watchlists]);

  const handleTierChange = useCallback((symbol: string, tier: SubscriptionTier) => {
    const prevTier = subscriptionTiersRef.current[symbol] || "none";
    const options = getSubscriptionTierRequestOptions({
      symbol,
      tier,
      nativeIntervals: resolveNativeIntervals(symbol),
      customIntervalRecords,
    });
    setSubscriptionTiers((prev) => ({ ...prev, [symbol]: tier }));
    updateSubscriptionTier(symbol, tier, options).catch((err) => {
      console.warn("Failed to update tier:", err);
      setSubscriptionTiers((current) => ({ ...current, [symbol]: prevTier }));
    });
  }, [customIntervalRecords, resolveNativeIntervals]);

  useEffect(() => {
    let cancelled = false;
    fetchSubscriptions()
      .then((response) => {
        if (!cancelled) {
          setSubscriptionTiers(buildTierMap(response.subscriptions));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const allSymbols = [...new Set(watchlists.flatMap((watchlist) => watchlist.symbols))];
    if (allSymbols.length === 0) return undefined;

    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncWatchlistSymbols(allSymbols)
        .then((response) => {
          if (response.auto_registered > 0) {
            refreshSubscriptions().catch(() => {});
          }
        })
        .catch(() => {});
    }, WATCHLIST_SYNC_DEBOUNCE_MS);

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [refreshSubscriptions, watchlists]);

  useEffect(() => {
    const url = getPriceStreamUrl();
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect(): void {
      if (stopped) return;
      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (
            message
            && typeof message === "object"
            && !Array.isArray(message)
            && (message as Record<string, unknown>).type === "prices"
            && Array.isArray((message as Record<string, unknown>).data)
          ) {
            const ticks = (message as Record<string, unknown>).data as unknown[];
            setSymbolPrices((prev) => {
              const next = { ...prev };
              for (const tick of ticks) {
                const parsed = parseWatchlistPriceTick(tick);
                if (!parsed) continue;
                next[parsed.symbol] = parsed;
              }
              return next;
            });
          }
        } catch {
          // Price ticks are best effort; ignore malformed packets.
        }
      };

      ws.onclose = () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, PRICE_WS_RECONNECT_MS);
        }
      };

      ws.onerror = () => ws?.close();
      priceWsRef.current = ws;
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
      priceWsRef.current = null;
    };
  }, []);

  return {
    subscriptionTiers,
    subscriptionResourceSummaries,
    setSubscriptionTiers,
    symbolPrices,
    refreshSubscriptions,
    handleTierChange,
  };
}
