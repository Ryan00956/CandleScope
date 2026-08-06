import {
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { defaultKlineApi } from "./feed/klineApi.js";
import { SharedKlineStreamCoordinator } from "./feed/sharedKlineStreamCoordinator.js";
import { MAX_SERIES_BARS } from "./phase1WindowPolicy.js";
import { SeriesWindowRegistry } from "./window/windowRegistry.js";
import {
  MarketDataWorkspaceContext,
  type MarketDataWorkspaceResources,
} from "./marketDataWorkspaceContext.js";

export function MarketDataWorkspaceProvider({ children }: PropsWithChildren) {
  const [resources] = useState<MarketDataWorkspaceResources>(() => ({
      streamCoordinator: new SharedKlineStreamCoordinator(defaultKlineApi),
      windowRegistry: new SeriesWindowRegistry({ maxBars: MAX_SERIES_BARS }),
  }));

  useEffect(() => {
    return () => resources.streamCoordinator.closeAll();
  }, [resources]);

  return (
    <MarketDataWorkspaceContext.Provider value={resources}>
      {children}
    </MarketDataWorkspaceContext.Provider>
  );
}
