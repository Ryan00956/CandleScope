import React, { useCallback, useEffect, useRef, useState } from "react";
import IntervalSelector from "./components/IntervalSelector";
import ChartWorkspace from "./components/app-shell/ChartWorkspace";
import LazySurfaces from "./components/app-shell/LazySurfaces";
import StatusBar from "./components/app-shell/StatusBar";
import TopBar from "./components/app-shell/TopBar";
import { loadUserPrefs, updateUserPref } from "./features/chart-session/chartSessionModel";
import { useChartSession } from "./features/chart-session/useChartSession";
import { useMarketDataRuntime } from "./features/market-data/useMarketDataRuntime";
import { useIndicatorRuntime } from "./features/indicators/useIndicatorRuntime";
import { useCacheLimitsSync } from "./runtime/preferences/useCacheLimitsSync";
import { useChartExportRuntime } from "./runtime/workflows/useChartExportRuntime";
import { useChartSettingsRuntime } from "./runtime/preferences/useChartSettingsRuntime";
import { useDrawingRuntime } from "./features/drawings/useDrawingRuntime";
import { usePriceScalePrefs } from "./runtime/preferences/usePriceScalePrefs";
import { useWatchlistRuntime } from "./runtime/workflows/useWatchlistRuntime";
import { useWatchlistStorageRuntime } from "./runtime/preferences/useWatchlistStorageRuntime";
import "./index.css";

// ---------- ErrorBoundary ----------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 16,
          color: "#94a3b8", padding: 32,
        }}>
          <div style={{ fontSize: 48 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>
            Chart rendering error
          </div>
          <div style={{ fontSize: 13, maxWidth: 400, textAlign: "center" }}>
            {this.state.error?.message || "Unknown error"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 24px", background: "#3b82f6", color: "#fff",
              border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const chartWidgetRef = useRef(null);
  const pageExportRef = useRef(null);
  const realtimePriceRef = useRef(null);
  const chartSessionRuntimeBridgeRef = useRef({});
  const chartSession = useChartSession({
    chartWidgetRef,
    realtimePriceRef,
    runtimeBridgeRef: chartSessionRuntimeBridgeRef,
  });
  const {
    symbol,
    exchange,
    marketType,
    interval,
    datasetKey,
    exchangeCatalog,
    nativeIntervals,
    intervalGroups,
    customIntervalRecords,
    savedCustomIntervals,
    intervalNotice,
    savedVisibleRange,
  } = chartSession.view;
  const {
    selectSymbol: handleSymbolChange,
    selectInterval: handleIntervalChange,
    createCustomInterval: handleCreateCustomInterval,
    removeCustomInterval: handleRemoveCustomInterval,
    restoreCustomInterval: handleRestoreCustomInterval,
    clearCustomIntervals: handleClearCustomIntervals,
    togglePinCustomInterval,
  } = chartSession.actions;
  const {
    exchangeCatalogStatus,
    exchangeLimitations,
  } = chartSession.status;
  const indicatorRangeRequestRef = useRef(null);
  const requestIndicatorRangeForMarketData = useCallback((start, end) => (
    indicatorRangeRequestRef.current?.(start, end) ?? false
  ), []);

  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
    runtimeBridgeRef: chartSessionRuntimeBridgeRef,
    requestIndicatorRange: requestIndicatorRangeForMarketData,
  });
  const {
    renderBars: renderChartData,
    meta: chartDataMeta,
    loading,
    error,
    lastPrice,
    connectionStatus,
    dataSource,
    wsStatus,
    display: marketDisplay,
  } = marketData.view;
  const {
    retry: retryMarketData,
    loadMoreLeft: handleNeedMoreLeft,
    onCrosshairMove: handleMarketCrosshairMove,
    onVisibleRangeChange: handleMarketVisibleRangeChange,
  } = marketData.actions;
  const {
    loadingMoreLeft,
    hasMoreLeft,
    canLoadMoreLeft,
    barCount,
  } = marketData.status;

  const {
    drawingTool,
    setDrawingTool,
    penColor,
    setPenColor,
    penSize,
    setPenSize,
    textFontSize,
    setTextFontSize,
    textBold,
    setTextBold,
    textItalic,
    setTextItalic,
    fibLevels,
    handleFibLevelsChange,
    fibInverted,
    handleFibInvertedChange,
    positionSize,
    handlePositionSizeChange,
    drawingsHidden,
    setDrawingsHidden,
    drawingSnapEnabled,
    handleDrawingSnapEnabledChange,
    selectedDrawing,
    handleSelectedDrawingChange,
    handleSelectedDrawingStyleChange,
    handleClearDrawing,
    handleToggleDrawingsHidden,
    clearIndicatorDrawingStorage,
  } = useDrawingRuntime({ chartWidgetRef, session: chartSession });

  const {
    invertScale,
    handleInvertScaleChange,
    priceScaleMode,
    handlePriceScaleModeChange,
  } = usePriceScalePrefs({ loadUserPrefs, updateUserPref });

  // --- Settings state (must be before indicators which need settings.upColor/downColor) ---
  const [showSettings, setShowSettings] = useState(false);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();

  // --- Indicator state ---
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  const indicators = useIndicatorRuntime({
    session: chartSession,
    marketData,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
  });
  const {
    activeIndicators,
    mainOverlayLines,
    subPanes,
    markers: indicatorMarkers,
    fills: indicatorFills,
    hlines: indicatorHlines,
    bgcolors: indicatorBgcolors,
    barcolors: indicatorBarcolors,
    paramSchemas: indicatorParamSchemas,
  } = indicators.view;
  const { computing: indicatorComputing } = indicators.status;
  const {
    addIndicator,
    removeIndicator: rawRemoveIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    recompute: recomputeIndicatorsWithUI,
    requestIndicatorRange,
  } = indicators.actions;

  useEffect(() => {
    indicatorRangeRequestRef.current = requestIndicatorRange;
    return () => {
      if (indicatorRangeRequestRef.current === requestIndicatorRange) {
        indicatorRangeRequestRef.current = null;
      }
    };
  }, [requestIndicatorRange]);

  const chartStorageKeyBase = `${exchange}:${marketType}:${symbol}`;

  const {
    showExportPanel,
    exportOptions,
    exportInProgress,
    exportError,
    exportNotice,
    exportPreview,
    exportMetadata,
    handleExportOptionsChange,
    handleToggleExportPanel,
    handleCloseExportPanel,
    handleExportChart,
  } = useChartExportRuntime({
    exchange,
    marketType,
    symbol,
    interval,
    resolvedTheme,
    chartWidgetRef,
    pageExportRef,
    drawingsHidden,
    setDrawingsHidden,
    loadUserPrefs,
    updateUserPref,
  });

  const removeIndicator = useCallback((indicatorId) => {
    rawRemoveIndicator(indicatorId);
    clearIndicatorDrawingStorage(indicatorId);
  }, [clearIndicatorDrawingStorage, rawRemoveIndicator]);

  const { watchlists, setWatchlists, handleAddToWatchlist } = useWatchlistStorageRuntime();

  const {
    subscriptionTiers,
    symbolPrices,
    handleTierChange,
  } = useWatchlistRuntime({ watchlists });


  // Sync cache limits to backend when they change
  const { cacheLimits, ephemeralCacheBars } = settings;
  useCacheLimitsSync({ cacheLimits, ephemeralCacheBars });

  const {
    displayData,
    priceChange,
    isUp,
    amplitude,
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  } = marketDisplay;

  return (
    <div className="app-layout" ref={pageExportRef}>
      <TopBar
        symbol={symbol}
        marketType={marketType}
        exchange={exchange}
        exchangeCatalog={exchangeCatalog}
        onSelectSymbol={handleSymbolChange}
        watchlists={watchlists}
        onAddToWatchlist={handleAddToWatchlist}
        onOpenSettings={() => setShowSettings(true)}
        indicatorPanelOpen={showIndicatorPanel}
        onToggleIndicatorPanel={() => setShowIndicatorPanel((p) => !p)}
        alertPanelOpen={showAlertsPanel}
        onToggleAlertPanel={() => setShowAlertsPanel((p) => !p)}
        activeIndicatorCount={activeIndicators.length}
        displayData={displayData}
        isUp={isUp}
        priceChange={priceChange}
        amplitude={amplitude}
      />

      <IntervalSelector
        interval={interval}
        nativeIntervals={nativeIntervals}
        intervalGroups={intervalGroups}
        customIntervalRecords={customIntervalRecords}
        savedCustomIntervals={savedCustomIntervals}
        onSelectInterval={handleIntervalChange}
        onCreateCustomInterval={handleCreateCustomInterval}
        onRemoveCustomInterval={handleRemoveCustomInterval}
        onRestoreCustomInterval={handleRestoreCustomInterval}
        onTogglePinCustomInterval={togglePinCustomInterval}
        onClearCustomIntervals={handleClearCustomIntervals}
        intervalNotice={intervalNotice}
      />

      <ChartWorkspace
        errorBoundary={ErrorBoundary}
        drawingToolbar={{
          activeTool: drawingTool,
          onToolChange: setDrawingTool,
          penColor,
          onPenColorChange: setPenColor,
          penSize,
          onPenSizeChange: setPenSize,
          onClearAll: handleClearDrawing,
          drawingsHidden,
          onToggleDrawingsHidden: handleToggleDrawingsHidden,
          drawingSnapEnabled,
          onDrawingSnapEnabledChange: handleDrawingSnapEnabledChange,
          textFontSize,
          onTextFontSizeChange: setTextFontSize,
          textBold,
          onTextBoldChange: setTextBold,
          textItalic,
          onTextItalicChange: setTextItalic,
          fibLevels,
          onFibLevelsChange: handleFibLevelsChange,
          fibInverted,
          onFibInvertedChange: handleFibInvertedChange,
          positionSize,
          onPositionSizeChange: handlePositionSizeChange,
          selectedDrawing,
          onSelectedDrawingStyleChange: handleSelectedDrawingStyleChange,
          exportPanelOpen: showExportPanel,
          exportInProgress,
          onToggleExportPanel: handleToggleExportPanel,
        }}
        exportPanel={{
          isOpen: showExportPanel,
          options: exportOptions,
          onOptionsChange: handleExportOptionsChange,
          onExport: handleExportChart,
          onClose: handleCloseExportPanel,
          inProgress: exportInProgress,
          error: exportError,
          notice: exportNotice,
          metadata: exportMetadata,
          loading: loading || loadingMoreLeft,
          indicatorComputing,
          preview: exportPreview,
        }}
        chart={{
          error,
          onRetryLoad: retryMarketData,
          chartProps: {
            ref: chartWidgetRef,
            data: renderChartData,
            symbol,
            drawingKeyBase: chartStorageKeyBase,
            interval,
            loading,
            onCrosshairMove: handleMarketCrosshairMove,
            onNeedMoreLeft: handleNeedMoreLeft,
            canLoadMoreLeft,
            datasetKey,
            upColor: settings.upColor,
            downColor: settings.downColor,
            theme: resolvedTheme,
            customBg: settings.customBg,
            timezone: settings.timezone,
            savedVisibleRange,
            dataMeta: chartDataMeta,
            onVisibleRangeChange: handleMarketVisibleRangeChange,
            drawingTool,
            onDrawingToolChange: setDrawingTool,
            penColor,
            penSize,
            textFontSize,
            textBold,
            textItalic,
            fibLevels,
            fibInverted,
            positionSize,
            drawingSnapEnabled,
            onSelectedDrawingChange: handleSelectedDrawingChange,
            mainOverlayLines,
            subPanes,
            indicatorMarkers,
            indicatorFills,
            indicatorHlines,
            indicatorBgcolors,
            indicatorBarcolors,
            invertScale,
            onInvertScaleChange: handleInvertScaleChange,
            priceScaleMode,
            onPriceScaleModeChange: handlePriceScaleModeChange,
          },
        }}
        watchlist={{
          currentSymbol: symbol,
          currentMarketType: marketType,
          currentExchange: exchange,
          onSelectSymbol: handleSymbolChange,
          watchlists,
          onWatchlistsChange: setWatchlists,
          prices: symbolPrices,
          subscriptionTiers,
          onTierChange: handleTierChange,
          upColor: settings.upColor,
          downColor: settings.downColor,
        }}
      />

      <LazySurfaces
        indicatorPanel={{
          isOpen: showIndicatorPanel,
          onClose: () => setShowIndicatorPanel(false),
          activeIndicators,
          paramSchemas: indicatorParamSchemas,
          computing: indicatorComputing,
          onAddIndicator: addIndicator,
          onRemoveIndicator: removeIndicator,
          onToggleVisibility: toggleVisibility,
          onUpdateParams: updateIndicatorParams,
          onUpdateScript: updateIndicatorScript,
          onRecompute: recomputeIndicatorsWithUI,
        }}
        alertsPanel={{
          isOpen: showAlertsPanel,
          onClose: () => setShowAlertsPanel(false),
          currentSymbol: symbol,
          currentMarketType: marketType,
          currentExchange: exchange,
          currentInterval: interval,
          displayPrice: displayData?.close ?? lastPrice?.close,
          wsStatus,
          watchlists,
        }}
        settingsModal={{
          isOpen: showSettings,
          onClose: () => setShowSettings(false),
          settings,
          onUpdate: setSettings,
          currentSymbol: symbol,
          currentMarketType: marketType,
          currentExchange: exchange,
          watchlists,
        }}
      />

      <StatusBar
        connectionStatus={connectionStatus}
        dataSource={dataSource}
        exchangeLabel={exchangeLabel}
        marketLabel={marketLabel}
        wsStatusLabel={wsStatusLabel}
        barCount={barCount}
        loadingMoreLeft={loadingMoreLeft}
        hasMoreLeft={hasMoreLeft}
        exchangeCatalogStatus={exchangeCatalogStatus}
        exchangeLimitations={exchangeLimitations}
      />
    </div>
  );
}
