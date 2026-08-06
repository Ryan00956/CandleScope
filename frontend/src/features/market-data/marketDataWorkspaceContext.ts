import { createContext, useContext } from "react";
import type { SharedKlineStreamCoordinator } from "./feed/sharedKlineStreamCoordinator.js";
import type { SeriesWindowRegistry } from "./window/windowRegistry.js";

export interface MarketDataWorkspaceResources {
  streamCoordinator: SharedKlineStreamCoordinator;
  windowRegistry: SeriesWindowRegistry;
}

export const MarketDataWorkspaceContext = createContext<MarketDataWorkspaceResources | null>(null);

export function useMarketDataWorkspaceResources(): MarketDataWorkspaceResources | null {
  return useContext(MarketDataWorkspaceContext);
}
