import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useChartSurfaceRuntime } from "../chart-adapter/useChartSurfaceRuntime";
import { loadUserPrefs, updateUserPref } from "../features/chart-session/chartSessionModel";
import { useChartSession } from "../features/chart-session/useChartSession";
import { useMarketDataRuntime } from "../features/market-data/useMarketDataRuntime";
import { ForegroundPreloadGate } from "../features/market-data/foregroundPreloadGate";
import { useAdvancedMarketDataRuntime } from "../features/advanced-market-data/useAdvancedMarketDataRuntime";
import { useIndicatorRuntime } from "../features/indicators/useIndicatorRuntime";
import { useCacheLimitsSync } from "../features/settings/cacheLimitSettingsRuntime";
import { useExportRuntime } from "../features/export/useExportRuntime";
import { useChartSettingsRuntime } from "../features/settings/chartAppearanceSettings";
import { useDrawingRuntime } from "../features/drawings/useDrawingRuntime";
import { usePriceScalePrefs } from "../features/settings/priceScalePrefsRuntime";
import { useWatchlistRuntime } from "../features/watchlist/useWatchlistRuntime";
import { useOrderBookRuntime } from "../features/order-book/useOrderBookRuntime";
import { useTradeFlowRuntime } from "../features/trade-flow/useTradeFlowRuntime";
import { useWatchlistFullCacheRuntime } from "../features/watchlist-full-cache/useWatchlistFullCacheRuntime";
import { useFrontendAutoGcRuntime } from "../features/cache-gc/useFrontendAutoGcRuntime";
import { useReplayEntryCapability } from "../features/replay/useReplayEntryCapability";
import { buildLiveReplayLaunchContext } from "../features/replay-launcher/replayLaunchContext";
import { usePluginPlatformRuntime } from "../features/plugins/usePluginPlatformRuntime";
import AppProviders from "./AppProviders";
import AppShell from "./AppShell";
import { loadReplayLauncherDialog } from "./lazySurfaceLoaders";
import type {
  AlertsShellRuntime,
  IndicatorShellRuntime,
  PriceScaleShellRuntime,
  SettingsShellRuntime,
} from "./appShellContracts.js";
import "../index.css";
import "../features/plugins/pluginTrustUx.css";

const ReplayLauncherDialog = lazy(loadReplayLauncherDialog);

export default function App() {
  const replayEntry = useReplayEntryCapability();
  const chartSurface = useChartSurfaceRuntime();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const realtimePriceRef = useRef<number | null>(null);
  const [foregroundPreloadGate] = useState(() => new ForegroundPreloadGate());
  const chartSession = useChartSession({
    chartSurfaceActions: chartSurface.actions,
  });
  const plugins = usePluginPlatformRuntime({
    exchange: chartSession.view.exchange,
    marketType: chartSession.view.marketType,
    symbol: chartSession.view.symbol,
    interval: chartSession.view.interval,
  });

  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
    foregroundPreloadGate,
  });
  const advancedMarketData = useAdvancedMarketDataRuntime({
    session: chartSession,
    dataMeta: marketData.view.meta,
    seriesStore: marketData.view.seriesStore,
  });
  const drawings = useDrawingRuntime({ chartSurfaceActions: chartSurface.actions, session: chartSession });

  const {
    invertScale,
    handleInvertScaleChange,
    priceScaleMode,
    handlePriceScaleModeChange,
  } = usePriceScalePrefs({ loadUserPrefs, updateUserPref });

  const [showSettings, setShowSettings] = useState(false);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();

  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  const [showReplayLauncher, setShowReplayLauncher] = useState(false);
  const openIndicatorPanel = useCallback(() => setShowIndicatorPanel(true), []);
  const closeIndicatorPanel = useCallback(() => setShowIndicatorPanel(false), []);
  const toggleIndicatorPanel = useCallback(() => setShowIndicatorPanel((prev) => !prev), []);
  const openSettingsPanel = useCallback(() => setShowSettings(true), []);
  const closeSettingsPanel = useCallback(() => setShowSettings(false), []);
  const openAlertsPanel = useCallback(() => setShowAlertsPanel(true), []);
  const closeAlertsPanel = useCallback(() => setShowAlertsPanel(false), []);
  const toggleAlertsPanel = useCallback(() => setShowAlertsPanel((prev) => !prev), []);
  const openReplayLauncher = useCallback(() => setShowReplayLauncher(true), []);
  const closeReplayLauncher = useCallback(() => setShowReplayLauncher(false), []);
  const indicators = useIndicatorRuntime({
    session: chartSession,
    marketData,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
    getCurrentVisibleRange: chartSurface.actions.getVisibleRange,
    onIndicatorRemoved: drawings.actions.handleIndicatorRemoved,
  });
  const exportFlow = useExportRuntime({
    session: chartSession,
    resolvedTheme,
    chartSurfaceActions: chartSurface.actions,
    pageExportRef,
    drawings,
    loadUserPrefs,
    updateUserPref,
  });

  const watchlist = useWatchlistRuntime({
    subscriptionContext: {
      exchangeCatalog: chartSession.view.exchangeCatalog,
      exchangeCatalogStatus: chartSession.status.exchangeCatalogStatus,
      customIntervalRecords: chartSession.view.customIntervalRecords,
    },
  });
  const replayLaunchContext = useMemo(() => (
    showReplayLauncher
      ? buildLiveReplayLaunchContext({
          exchange: chartSession.view.exchange,
          marketType: chartSession.view.marketType,
          symbol: chartSession.view.symbol,
          displayInterval: chartSession.view.interval,
          watchlists: watchlist.view.watchlists,
        })
      : null
  ), [
    chartSession.view.exchange,
    chartSession.view.interval,
    chartSession.view.marketType,
    chartSession.view.symbol,
    showReplayLauncher,
    watchlist.view.watchlists,
  ]);
  const orderBook = useOrderBookRuntime({
    identity: {
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      symbol: chartSession.view.symbol,
    },
    railCollapsed: watchlist.view.layout.sidebarCollapsed,
  });
  const tradeFlow = useTradeFlowRuntime({
    identity: {
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      symbol: chartSession.view.symbol,
    },
    interval: chartSession.view.interval,
    seriesStore: marketData.view.seriesStore,
    buyColor: settings.upColor,
    sellColor: settings.downColor,
  });
  useWatchlistFullCacheRuntime({
    enabled: chartSession.status.marketDataReady,
    foregroundPreloadGate,
    watchlists: watchlist.view.watchlists,
    subscriptionTiers: watchlist.view.subscriptionTiers,
    exchangeCatalog: chartSession.view.exchangeCatalog,
    exchangeCatalogStatus: chartSession.status.exchangeCatalogStatus,
    customIntervalRecords: chartSession.view.customIntervalRecords,
    currentSession: {
      symbol: chartSession.view.symbol,
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      interval: chartSession.view.interval,
    },
  });

  const {
    cacheLimits,
    ephemeralCacheBars,
    frontendCacheBudgetBytes,
    sqliteStorageBudgetBytes,
    storageRowLimitsEnabled,
  } = settings;
  useCacheLimitsSync({
    cacheLimits,
    ephemeralCacheBars,
    sqliteStorageBudgetBytes,
    storageRowLimitsEnabled,
  });
  const frontendAutoGcPolicy = useMemo(() => ({
    maxEstimatedBytes: frontendCacheBudgetBytes,
  }), [frontendCacheBudgetBytes]);
  useFrontendAutoGcRuntime({
    chartDataCacheDiagnostics: marketData.status.cacheDiagnostics,
    policy: frontendAutoGcPolicy,
    trimChartDataCacheEntries: marketData.status.trimCacheEntries,
  });

  const indicatorRuntime = useMemo<IndicatorShellRuntime>(() => ({
    view: {
      ...indicators.view,
      isPanelOpen: showIndicatorPanel,
    },
    actions: {
      ...indicators.actions,
      openPanel: openIndicatorPanel,
      closePanel: closeIndicatorPanel,
      togglePanel: toggleIndicatorPanel,
    },
    status: indicators.status,
  }), [
    indicators.view,
    indicators.actions,
    indicators.status,
    showIndicatorPanel,
    openIndicatorPanel,
    closeIndicatorPanel,
    toggleIndicatorPanel,
  ]);

  const settingsRuntime = useMemo<SettingsShellRuntime>(() => ({
    view: {
      settings,
      resolvedTheme,
      isOpen: showSettings,
    },
    actions: {
      update: setSettings,
      openPanel: openSettingsPanel,
      closePanel: closeSettingsPanel,
    },
    status: {},
  }), [
    settings,
    resolvedTheme,
    showSettings,
    setSettings,
    openSettingsPanel,
    closeSettingsPanel,
  ]);

  const priceScaleRuntime = useMemo<PriceScaleShellRuntime>(() => ({
    view: {
      invertScale,
      priceScaleMode,
    },
    actions: {
      setInvertScale: handleInvertScaleChange,
      setPriceScaleMode: handlePriceScaleModeChange,
    },
    status: {},
  }), [
    invertScale,
    priceScaleMode,
    handleInvertScaleChange,
    handlePriceScaleModeChange,
  ]);

  const alertsRuntime = useMemo<AlertsShellRuntime>(() => ({
    view: {
      isOpen: showAlertsPanel,
    },
    actions: {
      openPanel: openAlertsPanel,
      closePanel: closeAlertsPanel,
      togglePanel: toggleAlertsPanel,
    },
    status: {},
  }), [
    showAlertsPanel,
    openAlertsPanel,
    closeAlertsPanel,
    toggleAlertsPanel,
  ]);

  return (
    <AppProviders>
      <>
        <AppShell
          pageExportRef={pageExportRef}
          chartSurfaceRef={chartSurface.ref}
          session={chartSession}
          marketData={marketData}
          advancedMarketData={advancedMarketData}
          drawings={drawings}
          indicators={indicatorRuntime}
          settings={settingsRuntime}
          priceScale={priceScaleRuntime}
          watchlist={watchlist}
          orderBook={orderBook}
          tradeFlow={tradeFlow}
          exportFlow={exportFlow}
          alerts={alertsRuntime}
          replayEntry={replayEntry}
          onOpenReplayLauncher={openReplayLauncher}
          plugins={plugins}
        />
        {showReplayLauncher && replayLaunchContext !== null && (
          <Suspense fallback={null}>
            <ReplayLauncherDialog
              launchContext={replayLaunchContext}
              onRequestClose={closeReplayLauncher}
            />
          </Suspense>
        )}
      </>
    </AppProviders>
  );
}
