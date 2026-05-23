import { useRef, useState } from "react";
import { useChartSurfaceRuntime } from "../chart-adapter/useChartSurfaceRuntime";
import { loadUserPrefs, updateUserPref } from "../features/chart-session/chartSessionModel";
import { useChartSession } from "../features/chart-session/useChartSession";
import { useMarketDataRuntime } from "../features/market-data/useMarketDataRuntime";
import { useIndicatorRuntime } from "../features/indicators/useIndicatorRuntime";
import { useCacheLimitsSync } from "../features/settings/cacheLimitSettingsRuntime";
import { useExportRuntime } from "../features/export/useExportRuntime";
import { useChartSettingsRuntime } from "../features/settings/chartAppearanceSettings";
import { useDrawingRuntime } from "../features/drawings/useDrawingRuntime";
import { usePriceScalePrefs } from "../features/settings/priceScalePrefsRuntime";
import { useWatchlistRuntime } from "../features/watchlist/useWatchlistRuntime";
import AppProviders from "./AppProviders";
import AppShell from "./AppShell";
import "../index.css";

export default function App() {
  const chartSurface = useChartSurfaceRuntime();
  const pageExportRef = useRef(null);
  const realtimePriceRef = useRef(null);
  const chartSession = useChartSession({
    chartSurfaceActions: chartSurface.actions,
  });

  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
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
  const indicators = useIndicatorRuntime({
    session: chartSession,
    marketData,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
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

  const watchlist = useWatchlistRuntime();

  const { cacheLimits, ephemeralCacheBars } = settings;
  useCacheLimitsSync({ cacheLimits, ephemeralCacheBars });

  return (
    <AppProviders>
      <AppShell
        pageExportRef={pageExportRef}
        chartSurfaceRef={chartSurface.ref}
        session={chartSession}
        marketData={marketData}
        drawings={drawings}
        indicators={{
          view: {
            ...indicators.view,
            isPanelOpen: showIndicatorPanel,
          },
          actions: {
            ...indicators.actions,
            openPanel: () => setShowIndicatorPanel(true),
            closePanel: () => setShowIndicatorPanel(false),
            togglePanel: () => setShowIndicatorPanel((prev) => !prev),
          },
          status: indicators.status,
        }}
        settings={{
          view: {
            settings,
            resolvedTheme,
            isOpen: showSettings,
          },
          actions: {
            update: setSettings,
            openPanel: () => setShowSettings(true),
            closePanel: () => setShowSettings(false),
          },
          status: {},
        }}
        priceScale={{
          view: {
            invertScale,
            priceScaleMode,
          },
          actions: {
            setInvertScale: handleInvertScaleChange,
            setPriceScaleMode: handlePriceScaleModeChange,
          },
          status: {},
        }}
        watchlist={watchlist}
        exportFlow={exportFlow}
        alerts={{
          view: {
            isOpen: showAlertsPanel,
          },
          actions: {
            openPanel: () => setShowAlertsPanel(true),
            closePanel: () => setShowAlertsPanel(false),
            togglePanel: () => setShowAlertsPanel((prev) => !prev),
          },
          status: {},
        }}
      />
    </AppProviders>
  );
}
