import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSubscriptions,
  getPriceStreamUrl,
  syncWatchlistSymbols,
  updateSubscriptionTier,
} from "../../services/api";
import { getNativeIntervals } from "../chart-session/exchangeCatalogRuntime";
import { parseSymbolKey } from "../../utils/symbolKey";
import {
  getFullSubscriptionResourceSummary,
  getSubscriptionTierRequestOptions,
} from "./watchlistSubscriptionPolicy";

const WATCHLIST_SYNC_DEBOUNCE_MS = 500;
const PRICE_WS_RECONNECT_MS = 3_000;

function buildTierMap(subscriptions) {
  const tiers = {};
  for (const subscription of subscriptions || []) {
    tiers[subscription.symbol] = subscription.tier;
  }
  return tiers;
}

export function useWatchlistSubscriptionRuntime({
  watchlists,
  subscriptionContext = {},
}) {
  const [subscriptionTiers, setSubscriptionTiers] = useState({});
  const [symbolPrices, setSymbolPrices] = useState({});
  const syncTimerRef = useRef(null);
  const priceWsRef = useRef(null);
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

  const resolveNativeIntervals = useCallback((symbol) => {
    const parsed = parseSymbolKey(symbol);
    if (parsed.exchange === exchange) return nativeIntervals;
    return getNativeIntervals(parsed.exchange, exchangeCatalog);
  }, [exchange, exchangeCatalog, nativeIntervals]);

  const subscriptionResourceSummaries = useMemo(() => {
    const summaries = {};
    const symbols = new Set(watchlists.flatMap((watchlist) => watchlist.symbols || []));
    for (const symbol of symbols) {
      summaries[symbol] = getFullSubscriptionResourceSummary({
        nativeIntervals: resolveNativeIntervals(symbol),
        customIntervalRecords,
      });
    }
    return summaries;
  }, [customIntervalRecords, resolveNativeIntervals, watchlists]);

  const handleTierChange = useCallback((symbol, tier) => {
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

    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncWatchlistSymbols(allSymbols)
        .then((response) => {
          if (response.auto_registered > 0) {
            refreshSubscriptions().catch(() => {});
          }
        })
        .catch(() => {});
    }, WATCHLIST_SYNC_DEBOUNCE_MS);

    return () => clearTimeout(syncTimerRef.current);
  }, [refreshSubscriptions, watchlists]);

  useEffect(() => {
    const url = getPriceStreamUrl();
    let ws = null;
    let reconnectTimer = null;
    let stopped = false;

    function connect() {
      if (stopped) return;
      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "prices" && Array.isArray(message.data)) {
            setSymbolPrices((prev) => {
              const next = { ...prev };
              for (const tick of message.data) {
                next[tick.symbol] = tick;
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

      ws.onerror = () => ws.close();
      priceWsRef.current = ws;
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
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
