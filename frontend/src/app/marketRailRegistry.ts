import type { MarketRailViewDescriptor } from "./marketRailTypes.js";

/**
 * Runtime contribution registry for right-rail activity views.
 * First-party views are composed in RightMarketRail; plugins can
 * register additional descriptors here without shell rewrites.
 */
const contributedViews = new Map<string, MarketRailViewDescriptor>();
const listeners = new Set<() => void>();
const EMPTY_CONTRIBUTED_VIEWS: readonly MarketRailViewDescriptor[] = Object.freeze([]);
let contributedViewsSnapshot: readonly MarketRailViewDescriptor[] = EMPTY_CONTRIBUTED_VIEWS;

function rebuildSnapshot(): void {
  if (contributedViews.size === 0) {
    contributedViewsSnapshot = EMPTY_CONTRIBUTED_VIEWS;
    return;
  }
  contributedViewsSnapshot = Object.freeze(
    Array.from(contributedViews.values())
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
  );
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function registerMarketRailView(view: MarketRailViewDescriptor): () => void {
  contributedViews.set(view.id, view);
  rebuildSnapshot();
  emit();
  return () => {
    if (contributedViews.get(view.id) === view) {
      contributedViews.delete(view.id);
      rebuildSnapshot();
      emit();
    }
  };
}

export function listContributedMarketRailViews(): readonly MarketRailViewDescriptor[] {
  return contributedViewsSnapshot;
}

export function subscribeMarketRailRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mergeMarketRailViews(
  builtIn: readonly MarketRailViewDescriptor[],
  contributed: readonly MarketRailViewDescriptor[] = listContributedMarketRailViews(),
): MarketRailViewDescriptor[] {
  const byId = new Map<string, MarketRailViewDescriptor>();
  for (const view of builtIn) byId.set(view.id, view);
  // Contributions may override built-ins with the same id (plugin replace).
  for (const view of contributed) byId.set(view.id, view);
  return Array.from(byId.values())
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}
