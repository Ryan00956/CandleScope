import { useMemo } from "react";
import { useWatchlistStore } from "./watchlistStore";
import { useWatchlistSubscriptionRuntime } from "./watchlistSubscriptionRuntime";

export function useWatchlistRuntime({ subscriptionContext } = {}) {
  const store = useWatchlistStore();
  const subscriptions = useWatchlistSubscriptionRuntime({
    watchlists: store.watchlists,
    subscriptionContext,
  });

  const view = useMemo(() => ({
    watchlists: store.watchlists,
    layout: store.layout,
    prices: subscriptions.symbolPrices,
    subscriptionTiers: subscriptions.subscriptionTiers,
    subscriptionResourceSummaries: subscriptions.subscriptionResourceSummaries,
  }), [
    store.layout,
    store.watchlists,
    subscriptions.subscriptionResourceSummaries,
    subscriptions.subscriptionTiers,
    subscriptions.symbolPrices,
  ]);

  const actions = useMemo(() => ({
    ...store.actions,
    setSubscriptionTiers: subscriptions.setSubscriptionTiers,
    refreshSubscriptions: subscriptions.refreshSubscriptions,
    handleTierChange: subscriptions.handleTierChange,
  }), [
    store.actions,
    subscriptions.handleTierChange,
    subscriptions.refreshSubscriptions,
    subscriptions.setSubscriptionTiers,
  ]);

  return {
    view,
    actions,
    status: {},
  };
}
