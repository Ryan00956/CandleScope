import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSubscriptions,
  getPriceStreamUrl,
  syncWatchlistSymbols,
} from "../services/api";

const WATCHLIST_SYNC_DEBOUNCE_MS = 500;
const PRICE_WS_RECONNECT_MS = 3_000;

function buildTierMap(subscriptions) {
  const tiers = {};
  for (const sub of subscriptions || []) {
    tiers[sub.symbol] = sub.tier;
  }
  return tiers;
}

export function useWatchlistRuntime({ watchlists }) {
  const [subscriptionTiers, setSubscriptionTiers] = useState({});
  const [symbolPrices, setSymbolPrices] = useState({});
  const syncTimerRef = useRef(null);
  const priceWsRef = useRef(null);

  const refreshSubscriptions = useCallback(async () => {
    const res = await fetchSubscriptions();
    setSubscriptionTiers(buildTierMap(res.subscriptions));
    return res;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSubscriptions()
      .then((res) => {
        if (!cancelled) {
          setSubscriptionTiers(buildTierMap(res.subscriptions));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const allSymbols = [...new Set(watchlists.flatMap((wl) => wl.symbols))];
    if (allSymbols.length === 0) return undefined;

    clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncWatchlistSymbols(allSymbols)
        .then((res) => {
          if (res.auto_registered > 0) {
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

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "prices" && Array.isArray(msg.data)) {
            setSymbolPrices((prev) => {
              const next = { ...prev };
              for (const tick of msg.data) {
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
    setSubscriptionTiers,
    symbolPrices,
    refreshSubscriptions,
  };
}
