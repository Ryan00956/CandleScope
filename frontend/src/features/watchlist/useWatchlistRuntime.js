import { useMemo } from "react";
import { useWatchlistStore } from "./watchlistStore";
import { useWatchlistSubscriptionRuntime } from "./watchlistSubscriptionRuntime";

export function useWatchlistRuntime() {
  const store = useWatchlistStore();
  const subscriptions = useWatchlistSubscriptionRuntime({ watchlists: store.watchlists });

  const view = useMemo(() => ({
    watchlists: store.watchlists,
    layout: store.layout,
    prices: subscriptions.symbolPrices,
    subscriptionTiers: subscriptions.subscriptionTiers,
  }), [
    store.layout,
    store.watchlists,
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
    watchlists: view.watchlists,
    setWatchlists: actions.setWatchlists,
    handleAddToWatchlist: actions.addToWatchlist,
    subscriptionTiers: view.subscriptionTiers,
    symbolPrices: view.prices,
    handleTierChange: actions.handleTierChange,
  };
}