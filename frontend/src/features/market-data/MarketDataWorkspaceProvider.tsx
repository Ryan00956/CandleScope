import {
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import {
  fetchIndicatorWebSocketLimits,
  getIndicatorStreamUrl,
} from "../../services/indicatorApi.js";
import { SharedIndicatorStreamCoordinator } from "../indicators/sharedIndicatorStreamCoordinator.js";
import { ChartWorkScheduler } from "./chartWorkScheduler.js";
import { CHART_WINDOW_BROKER_ENABLED } from "./chartWindowBrokerFeature.js";
import { KLINE_BATCH_STREAM_ENABLED } from "./klineBatchFeature.js";
import { BatchKlineStreamCoordinator } from "./feed/batchKlineStreamCoordinator.js";
import { defaultKlineApi } from "./feed/klineApi.js";
import { SharedKlineRequestCoordinator } from "./feed/sharedKlineRequestCoordinator.js";
import { SharedKlineStreamCoordinator } from "./feed/sharedKlineStreamCoordinator.js";
import { MAX_SERIES_BARS } from "./phase1WindowPolicy.js";
import { SeriesWindowRegistry } from "./window/windowRegistry.js";
import {
  MarketDataWorkspaceContext,
  type MarketDataWorkspaceResources,
} from "./marketDataWorkspaceContext.js";
import { desktopWindowManager } from "../../desktop/desktopWindowManager.js";

export interface MarketDataWorkspaceProviderProps extends PropsWithChildren {
  brokerEnabled?: boolean;
  batchStreamEnabled?: boolean;
}

interface WindowBrokerDiagnosticsHandle {
  snapshot(): Record<string, unknown>;
}

export function MarketDataWorkspaceProvider({
  brokerEnabled = CHART_WINDOW_BROKER_ENABLED,
  batchStreamEnabled = KLINE_BATCH_STREAM_ENABLED,
  children,
}: MarketDataWorkspaceProviderProps) {
  const [resources] = useState<MarketDataWorkspaceResources>(() => {
    const requestCoordinator = brokerEnabled
      ? new SharedKlineRequestCoordinator(defaultKlineApi)
      : null;
    return {
      brokerEnabled,
      indicatorStreamCoordinator: brokerEnabled
        ? new SharedIndicatorStreamCoordinator({
            // Fail closed until /indicators/diagnostics advertises its limit.
            maxSubscriptions: 1,
            url: getIndicatorStreamUrl(),
          })
        : null,
      klineApi: requestCoordinator || defaultKlineApi,
      requestCoordinator,
      streamCoordinator: batchStreamEnabled
        ? new BatchKlineStreamCoordinator()
        : new SharedKlineStreamCoordinator(defaultKlineApi),
      workScheduler: brokerEnabled ? new ChartWorkScheduler() : null,
      windowRegistry: new SeriesWindowRegistry({ maxBars: MAX_SERIES_BARS }),
    };
  });

  useEffect(() => {
    if (!resources.indicatorStreamCoordinator) return undefined;
    const controller = new AbortController();
    void fetchIndicatorWebSocketLimits(controller.signal)
      .then(({ maxSubscriptions }) => {
        resources.indicatorStreamCoordinator?.setMaxSubscriptions(maxSubscriptions);
      })
      .catch(() => {
        // The broker remains at the safe one-subscription shard fallback.
      });
    return () => controller.abort();
  }, [resources]);

  useEffect(() => {
    const scheduler = resources.workScheduler;
    if (!scheduler || typeof document === "undefined") return undefined;
    const syncVisibility = () => scheduler.setWindowVisible(document.visibilityState !== "hidden");
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, [resources]);

  useEffect(() => {
    const scheduler = resources.workScheduler;
    if (!scheduler) return undefined;
    return desktopWindowManager.onLifecycle((event) => {
      if (event.windowId !== desktopWindowManager.windowId) return;
      scheduler.setWindowVisible(event.visible && !event.minimized && event.state !== "hidden");
    });
  }, [resources]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const globalRef = window as unknown as {
      __CANDLESCOPE_WINDOW_BROKER__?: WindowBrokerDiagnosticsHandle;
    };
    const handle: WindowBrokerDiagnosticsHandle = {
      snapshot: () => ({
        enabled: resources.brokerEnabled,
        klineBatchEnabled: batchStreamEnabled,
        indicator: resources.indicatorStreamCoordinator?.diagnostics() || null,
        klineHttp: resources.requestCoordinator?.diagnostics() || null,
        klineStream: resources.streamCoordinator.diagnostics(),
        scheduler: resources.workScheduler?.diagnostics() || null,
        seriesStores: resources.windowRegistry.entries().length,
      }),
    };
    globalRef.__CANDLESCOPE_WINDOW_BROKER__ = handle;
    return () => {
      if (globalRef.__CANDLESCOPE_WINDOW_BROKER__ === handle) {
        delete globalRef.__CANDLESCOPE_WINDOW_BROKER__;
      }
    };
  }, [batchStreamEnabled, resources]);

  useEffect(() => {
    return () => {
      resources.streamCoordinator.closeAll();
      resources.requestCoordinator?.closeAll();
      resources.indicatorStreamCoordinator?.closeAll();
      resources.workScheduler?.dispose();
    };
  }, [resources]);

  return (
    <MarketDataWorkspaceContext.Provider value={resources}>
      {children}
    </MarketDataWorkspaceContext.Provider>
  );
}
