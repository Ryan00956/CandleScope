import { createContext, useContext } from "react";
import type { SharedKlineRequestCoordinator } from "./feed/sharedKlineRequestCoordinator.js";
import type { SeriesWindowRegistry } from "./window/windowRegistry.js";
import type { KlineApi } from "./klineContracts.js";
import type { SharedIndicatorStreamCoordinator } from "../indicators/sharedIndicatorStreamCoordinator.js";
import type { ChartWorkScheduler } from "./chartWorkScheduler.js";

export interface KlineStreamCoordinator {
  subscribe: import("./klineContracts.js").KlineStreamFactory;
  diagnostics(): object;
  closeAll(): void;
}

export interface MarketDataWorkspaceResources {
  brokerEnabled: boolean;
  indicatorStreamCoordinator: SharedIndicatorStreamCoordinator | null;
  klineApi: KlineApi;
  requestCoordinator: SharedKlineRequestCoordinator | null;
  streamCoordinator: KlineStreamCoordinator;
  workScheduler: ChartWorkScheduler | null;
  windowRegistry: SeriesWindowRegistry;
}

export const MarketDataWorkspaceContext = createContext<MarketDataWorkspaceResources | null>(null);

export function useMarketDataWorkspaceResources(): MarketDataWorkspaceResources | null {
  return useContext(MarketDataWorkspaceContext);
}
