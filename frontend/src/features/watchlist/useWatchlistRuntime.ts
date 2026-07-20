import { useMemo } from "react";
import { useWatchlistStore } from "./watchlistStore.js";
import { useWatchlistSubscriptionRuntime } from "./watchlistSubscriptionRuntime.js";
import type {
  WatchlistSubscriptionContext,
  WatchlistSubscriptionRuntime,
} from "./watchlistSubscriptionRuntime.js";

export interface UseWatchlistRuntimeOptions {
  subscriptionContext?: WatchlistSubscriptionContext;
}

export interface WatchlistRuntime {
  view: {
    watchlists: ReturnType<typeof useWatchlistStore>["watchlists"];
    layout: ReturnType<typeof useWatchlistStore>["layout"];
    priceStore: WatchlistSubscriptionRuntime["priceStore"];
    subscriptionTiers: WatchlistSubscriptionRuntime["subscriptionTiers"];
    subscriptionResourceSummaries: WatchlistSubscriptionRuntime["subscriptionResourceSummaries"];
  };
  actions: ReturnType<typeof useWatchlistStore>["actions"] & Pick<
    WatchlistSubscriptionRuntime,
    "setSubscriptionTiers" | "refreshSubscriptions" | "handleTierChange"
  >;
  status: Record<string, never>;
}

const EMPTY_WATCHLIST_STATUS: Record<string, never> = Object.freeze({});

export function useWatchlistRuntime({
  subscriptionContext,
}: UseWatchlistRuntimeOptions = {}): WatchlistRuntime {
  const store = useWatchlistStore();
  const subscriptions = useWatchlistSubscriptionRuntime({
    watchlists: store.watchlists,
    ...(subscriptionContext === undefined ? {} : { subscriptionContext }),
  });

  const view = useMemo(() => ({
    watchlists: store.watchlists,
    layout: store.layout,
    priceStore: subscriptions.priceStore,
    subscriptionTiers: subscriptions.subscriptionTiers,
    subscriptionResourceSummaries: subscriptions.subscriptionResourceSummaries,
  }), [
    store.layout,
    store.watchlists,
    subscriptions.subscriptionResourceSummaries,
    subscriptions.subscriptionTiers,
    subscriptions.priceStore,
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

  return useMemo(() => ({
    view,
    actions,
    status: EMPTY_WATCHLIST_STATUS,
  }), [actions, view]);
}
