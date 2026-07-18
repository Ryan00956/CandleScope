import { useCallback, useMemo, useRef, useState } from "react";
import { useChartSurfaceRuntime } from "../chart-adapter/useChartSurfaceRuntime";
import { loadUserPrefs, updateUserPref } from "../features/chart-session/chartSessionModel";
import { useChartSession } from "../features/chart-session/useChartSession";
import { useMarketDataRuntime } from "../features/market-data/useMarketDataRuntime";
import { useAdvancedMarketDataRuntime } from "../features/advanced-market-data/useAdvancedMarketDataRuntime";
import { useIndicatorRuntime } from "../features/indicators/useIndicatorRuntime";
import { useCacheLimitsSync } from "../features/settings/cacheLimitSettingsRuntime";
import { useExportRuntime } from "../features/export/useExportRuntime";
import { useChartSettingsRuntime } from "../features/settings/chartAppearanceSettings";
import { useDrawingRuntime } from "../features/drawings/useDrawingRuntime";
import { usePriceScalePrefs } from "../features/settings/priceScalePrefsRuntime";
import { useWatchlistRuntime } from "../features/watchlist/useWatchlistRuntime";
import { useOrderBookRuntime } from "../features/order-book/useOrderBookRuntime";
import { useWatchlistFullCacheRuntime } from "../features/watchlist-full-cache/useWatchlistFullCacheRuntime";
import { useFrontendAutoGcRuntime } from "../features/cache-gc/useFrontendAutoGcRuntime";
import AppProviders from "./AppProviders";
import AppShell from "./AppShell";
import type {
  AlertsShellRuntime,
  IndicatorShellRuntime,
  PriceScaleShellRuntime,
  SettingsShellRuntime,
} from "./appShellContracts.js";
import "../index.css";

export default function App() {
  const chartSurface = useChartSurfaceRuntime();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const realtimePriceRef = useRef<number | null>(null);
  const chartSession = useChartSession({
    chartSurfaceActions: chartSurface.actions,
  });

  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
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
  const openIndicatorPanel = useCallback(() => setShowIndicatorPanel(true), []);
  const closeIndicatorPanel = useCallback(() => setShowIndicatorPanel(false), []);
  const toggleIndicatorPanel = useCallback(() => setShowIndicatorPanel((prev) => !prev), []);
  const openSettingsPanel = useCallback(() => setShowSettings(true), []);
  const closeSettingsPanel = useCallback(() => setShowSettings(false), []);
  const openAlertsPanel = useCallback(() => setShowAlertsPanel(true), []);
  const closeAlertsPanel = useCallback(() => setShowAlertsPanel(false), []);
  const toggleAlertsPanel = useCallback(() => setShowAlertsPanel((prev) => !prev), []);
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
      exchange: chartSession.view.exchange,
      exchangeCatalog: chartSession.view.exchangeCatalog,
      nativeIntervals: chartSession.view.nativeIntervals,
      customIntervalRecords: chartSession.view.customIntervalRecords,
    },
  });
  const orderBook = useOrderBookRuntime({
    identity: {
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      symbol: chartSession.view.symbol,
    },
    railCollapsed: watchlist.view.layout.sidebarCollapsed,
  });
  useWatchlistFullCacheRuntime({
    watchlists: watchlist.view.watchlists,
    subscriptionTiers: watchlist.view.subscriptionTiers,
    exchangeCatalog: chartSession.view.exchangeCatalog,
    nativeIntervals: chartSession.view.nativeIntervals,
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
        exportFlow={exportFlow}
        alerts={alertsRuntime}
      />
    </AppProviders>
  );
}
