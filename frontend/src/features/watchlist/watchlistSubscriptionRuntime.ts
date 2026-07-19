import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { createWatchlistPriceStore } from "./watchlistPriceStore.js";
import type {
  WatchlistPriceStore,
  WatchlistPriceTick,
} from "./watchlistPriceStore.js";
import type { SubscriptionTier, WatchlistGroup } from "./watchlistTypes.js";
import { createWatchlistPriceSocketSession } from "./watchlistPriceSocketSession.js";
import {
  WatchlistTierMutationCoordinator,
  type WatchlistTierMap,
} from "./watchlistTierMutationCoordinator.js";

export type { WatchlistPriceTick } from "./watchlistPriceStore.js";

const WATCHLIST_SYNC_DEBOUNCE_MS = 500;
const PRICE_WS_RECONNECT_MS = 3_000;

export interface WatchlistSubscriptionContext {
  exchange?: string;
  exchangeCatalog?: ExchangeCatalog | null;
  nativeIntervals?: NativeInterval[];
  customIntervalRecords?: CustomIntervalRecord[];
}

export interface UseWatchlistSubscriptionRuntimeOptions {
  watchlists: WatchlistGroup[];
  subscriptionContext?: WatchlistSubscriptionContext;
}

export interface WatchlistSubscriptionRuntime {
  subscriptionTiers: Record<string, SubscriptionTier>;
  subscriptionResourceSummaries: Record<string, ReturnType<typeof getFullSubscriptionResourceSummary>>;
  setSubscriptionTiers: Dispatch<SetStateAction<Record<string, SubscriptionTier>>>;
  priceStore: WatchlistPriceStore;
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
  const [priceStoreController] = useState(createWatchlistPriceStore);
  const [tierCoordinator] = useState(() => new WatchlistTierMutationCoordinator());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionTiersRef = useRef(subscriptionTiers);
  const lifecycleGenerationRef = useRef(0);
  const {
    exchange = "binance",
    exchangeCatalog = null,
    nativeIntervals = [],
    customIntervalRecords = [],
  } = subscriptionContext;

  useLayoutEffect(() => {
    subscriptionTiersRef.current = subscriptionTiers;
  }, [subscriptionTiers]);

  useLayoutEffect(() => {
    lifecycleGenerationRef.current += 1;
    const generation = lifecycleGenerationRef.current;
    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current += 1;
      }
      tierCoordinator.cancelPending();
    };
  }, [tierCoordinator]);

  const publishSubscriptionTiers = useCallback((next: WatchlistTierMap) => {
    if (subscriptionTiersRef.current === next) return;
    subscriptionTiersRef.current = next as Record<string, SubscriptionTier>;
    setSubscriptionTiers(next as Record<string, SubscriptionTier>);
  }, []);

  const refreshSubscriptions = useCallback(async () => {
    const lifecycleGeneration = lifecycleGenerationRef.current;
    const refresh = tierCoordinator.beginRefresh();
    const response = await fetchSubscriptions();
    if (lifecycleGenerationRef.current === lifecycleGeneration) {
      publishSubscriptionTiers(tierCoordinator.mergeRefresh(
        refresh,
        subscriptionTiersRef.current,
        buildTierMap(response.subscriptions),
      ));
    }
    return response;
  }, [publishSubscriptionTiers, tierCoordinator]);

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
    const lifecycleGeneration = lifecycleGenerationRef.current;
    const mutation = tierCoordinator.beginMutation(symbol, prevTier, tier);
    const options = getSubscriptionTierRequestOptions({
      symbol,
      tier,
      nativeIntervals: resolveNativeIntervals(symbol),
      customIntervalRecords,
    });
    publishSubscriptionTiers({ ...subscriptionTiersRef.current, [symbol]: tier });
    updateSubscriptionTier(symbol, tier, options)
      .then((response) => {
        if (lifecycleGenerationRef.current !== lifecycleGeneration) return;
        const resolution = tierCoordinator.resolveSuccess(mutation, response.tier);
        if (!resolution) return;
        publishSubscriptionTiers({
          ...subscriptionTiersRef.current,
          [resolution.symbol]: resolution.tier,
        });
      })
      .catch((err) => {
        if (lifecycleGenerationRef.current !== lifecycleGeneration) return;
        const resolution = tierCoordinator.resolveFailure(mutation);
        if (!resolution) return;
        console.warn("Failed to update tier:", err);
        publishSubscriptionTiers({
          ...subscriptionTiersRef.current,
          [resolution.symbol]: resolution.tier,
        });
      });
  }, [
    customIntervalRecords,
    publishSubscriptionTiers,
    resolveNativeIntervals,
    tierCoordinator,
  ]);

  useEffect(() => {
    refreshSubscriptions().catch(() => {});
  }, [refreshSubscriptions]);

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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const socketSession = createWatchlistPriceSocketSession<WebSocket>();

    function connect(): void {
      if (socketSession.isStopped()) return;
      const socket = new WebSocket(url);
      if (!socketSession.activate(socket)) {
        socket.close();
        return;
      }

      socket.onmessage = (event) => {
        if (!socketSession.accepts(socket)) return;
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
            const parsedTicks: WatchlistPriceTick[] = [];
            for (const tick of ticks) {
              const parsed = parseWatchlistPriceTick(tick);
              if (parsed) parsedTicks.push(parsed);
            }
            priceStoreController.enqueue(parsedTicks);
          }
        } catch {
          // Price ticks are best effort; ignore malformed packets.
        }
      };

      socket.onclose = () => {
        if (!socketSession.release(socket) || socketSession.isStopped()) return;
        reconnectTimer = setTimeout(connect, PRICE_WS_RECONNECT_MS);
      };

      socket.onerror = () => {
        if (socketSession.accepts(socket)) socket.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketSession.stop();
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      priceStoreController.cancelPending();
    };
  }, [priceStoreController]);

  return {
    subscriptionTiers,
    subscriptionResourceSummaries,
    setSubscriptionTiers,
    priceStore: priceStoreController.store,
    refreshSubscriptions,
    handleTierChange,
  };
}
