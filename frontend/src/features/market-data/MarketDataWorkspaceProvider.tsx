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
import { MarketDataWorkspaceEffectGuard } from "./marketDataWorkspaceLifecycle.js";
import { desktopWindowManager } from "../../desktop/desktopWindowManager.js";
import { CHART_WORKSPACE_FEATURE_FLAGS } from "../chart-workspace/chartWorkspaceCapacity.js";
import { defaultWorkspaceBus } from "../chart-workspace/workspaceBus.js";

export interface MarketDataWorkspaceProviderProps extends PropsWithChildren {
  brokerEnabled?: boolean;
  batchStreamEnabled?: boolean;
}

interface WindowBrokerDiagnosticsHandle {
  snapshot(options?: { compact?: boolean }): Record<string, unknown>;
}

export function MarketDataWorkspaceProvider({
  brokerEnabled = CHART_WINDOW_BROKER_ENABLED,
  batchStreamEnabled = KLINE_BATCH_STREAM_ENABLED,
  children,
}: MarketDataWorkspaceProviderProps) {
  const [resources] = useState<MarketDataWorkspaceResources>(() => {
    const workspaceBus = CHART_WORKSPACE_FEATURE_FLAGS.multiChart64Enabled
      ? defaultWorkspaceBus(desktopWindowManager.windowId)
      : null;
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
      workScheduler: brokerEnabled ? new ChartWorkScheduler({
        appBudget: workspaceBus?.isNative()
          ? {
              acquire: (cellId, lane) => workspaceBus.acquireWork(cellId, lane),
              release: (lease) => workspaceBus.releaseWork(lease as Awaited<ReturnType<typeof workspaceBus.acquireWork>>),
            }
          : null,
      }) : null,
      windowRegistry: new SeriesWindowRegistry({
        maxBars: MAX_SERIES_BARS,
        sharedSnapshot: workspaceBus?.isNative()
          ? {
              read: (key) => desktopWindowManager.readSeriesSnapshot(key),
              publish: (key, rows) => desktopWindowManager.publishSeriesSnapshot(key, rows),
            }
          : null,
      }),
    };
  });
  const [resourceEffectGuard] = useState(() => new MarketDataWorkspaceEffectGuard());

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
      snapshot: (options = {}) => {
        const indicator = resources.indicatorStreamCoordinator?.diagnostics() || null;
        const klineHttp = resources.requestCoordinator?.diagnostics() || null;
        const klineStream = resources.streamCoordinator.diagnostics() as Record<string, unknown>;
        const scheduler = resources.workScheduler?.diagnostics() || null;
        const common = {
          enabled: resources.brokerEnabled,
          klineBatchEnabled: batchStreamEnabled,
          authoritativeCommits: (scheduler?.cells || []).reduce(
            (sum, cell) => sum + Number(cell.committed?.["authoritative-final"] || 0),
            0,
          ),
          seriesStores: resources.windowRegistry.entries().length,
          sharedSeries: resources.windowRegistry.sharedSnapshotDiagnostics(),
        };
        if (!options.compact) {
          return { ...common, indicator, klineHttp, klineStream, scheduler };
        }
        return {
          ...common,
          indicator: indicator ? {
            logicalClients: indicator.logicalClients,
            maxSubscriptions: indicator.maxSubscriptions,
            physicalShards: indicator.physicalShards,
            subscriptions: indicator.subscriptions,
          } : null,
          klineHttp: klineHttp ? {
            completedPhysical: klineHttp.completedPhysical,
            joinedLogical: klineHttp.joinedLogical,
            logicalInflight: klineHttp.logicalInflight,
            physicalInflight: klineHttp.physicalInflight,
            totalLogical: klineHttp.totalLogical,
            totalPhysical: klineHttp.totalPhysical,
          } : null,
          klineStream: {
            mode: klineStream["mode"],
            physicalStreams: klineStream["physicalStreams"],
            open: klineStream["open"],
            logicalSubscribers: klineStream["logicalSubscribers"],
            logicalSubscriptions: klineStream["logicalSubscriptions"],
            activeLogicalSubscriptions: klineStream["activeLogicalSubscriptions"],
            counts: klineStream["counts"],
          },
          scheduler: scheduler ? {
            activeAsync: scheduler.activeAsync,
            activeHydration: scheduler.activeHydration,
            disposed: scheduler.disposed,
            pendingAsync: scheduler.pendingAsync,
            pendingFrames: scheduler.pendingFrames,
            windowVisible: scheduler.windowVisible,
          } : null,
        };
      },
    };
    globalRef.__CANDLESCOPE_WINDOW_BROKER__ = handle;
    return () => {
      if (globalRef.__CANDLESCOPE_WINDOW_BROKER__ === handle) {
        delete globalRef.__CANDLESCOPE_WINDOW_BROKER__;
      }
    };
  }, [batchStreamEnabled, resources]);

  useEffect(() => {
    return resourceEffectGuard.mount(resources);
  }, [resourceEffectGuard, resources]);

  return (
    <MarketDataWorkspaceContext.Provider value={resources}>
      {children}
    </MarketDataWorkspaceContext.Provider>
  );
}
