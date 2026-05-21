import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IntervalSelector from "./components/IntervalSelector";
import ChartWorkspace from "./components/app-shell/ChartWorkspace";
import LazySurfaces from "./components/app-shell/LazySurfaces";
import StatusBar from "./components/app-shell/StatusBar";
import TopBar from "./components/app-shell/TopBar";
import { loadUserPrefs, updateUserPref } from "./features/chart-session/chartSessionModel";
import { useChartSession } from "./features/chart-session/useChartSession";
import { useIndicators } from "./hooks/useIndicators";
import { useBackfillCompletionRuntime } from "./runtime/streams/useBackfillCompletionRuntime";
import { useCacheLimitsSync } from "./runtime/preferences/useCacheLimitsSync";
import { useChartExportRuntime } from "./runtime/workflows/useChartExportRuntime";
import { useChartBackgroundPrefetch } from "./runtime/chart/useChartBackgroundPrefetch";
import { useChartGapRecovery } from "./runtime/chart/useChartGapRecovery";
import { useChartInitialLoad } from "./runtime/chart/useChartInitialLoad";
import { useChartLoadMoreLeft } from "./runtime/chart/useChartLoadMoreLeft";
import { useChartSettingsRuntime } from "./runtime/preferences/useChartSettingsRuntime";
import { useChartDataRuntime } from "./runtime/chart/useChartDataRuntime";
import { useDrawingRuntime } from "./runtime/workflows/useDrawingRuntime";
import { useKlineStreamRuntime } from "./runtime/streams/useKlineStreamRuntime";
import { usePriceScalePrefs } from "./runtime/preferences/usePriceScalePrefs";
import { useWatchlistRuntime } from "./runtime/workflows/useWatchlistRuntime";
import { useWatchlistStorageRuntime } from "./runtime/preferences/useWatchlistStorageRuntime";
import { parseIntervalSeconds } from "./utils/intervals";
import {
  buildRenderableChartData,
} from "./runtime/chart/chartDataRuntime";
import {
  buildChartDisplayState,
} from "./runtime/chart/chartDisplayRuntime";
import { clearSavedDrawings } from "./services/drawingStorage";
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
    exchangeConfig,
    nativeIntervals,
    intervalGroups,
    trackedIntervals,
    customIntervalRecords,
    savedCustomIntervals,
    intervalNotice,
    savedVisibleRange,
  } = chartSession.view;
  const {
    selectSymbol: handleSymbolChange,
    selectInterval: handleIntervalChange,
    setDatasetVersion: setDatasetKey,
    getIntervalDays: getExchangeIntervalDays,
    handleVisibleRangeChange,
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
  const {
    intervalRef,
    trackedIntervalsRef,
  } = chartSession.refs;

  const {
    chartData,
    chartDataMeta,
    pendingInitialHistoryRef,
    cacheKey,
    getFromCache,
    getCache,
    setCache,
    hasCache,
    clearCache,
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
  } = useChartDataRuntime({ exchange, marketType, symbol, interval });
  const renderChartData = useMemo(
    () => buildRenderableChartData(chartData, parseIntervalSeconds(interval)),
    [chartData, interval],
  );
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  const activeChartReady = chartData.length > 0 && chartDataMeta.status === "ready";
  const [error, setError] = useState(null);

  const [crosshairData, setCrosshairData] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState(null);

  const [wsStatus, setWsStatus] = useState("idle");

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
  } = useDrawingRuntime({ chartWidgetRef });

  const {
    invertScale,
    handleInvertScaleChange,
    priceScaleMode,
    handlePriceScaleModeChange,
  } = usePriceScalePrefs({ loadUserPrefs, updateUserPref });

  // --- Settings state (must be before useIndicators which needs settings.upColor/downColor) ---
  const [showSettings, setShowSettings] = useState(false);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();

  // --- Indicator state ---
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  // Store the actual ref objects from ChartWidget (not copies of .current)
  // so useIndicators always reads the live chart/series instances.
  const indicatorChartRefRef = useRef(null);   // ref-to-ref: points to ChartWidget's chartRef
  const indicatorSeriesRefRef = useRef(null);  // ref-to-ref: points to ChartWidget's seriesRef
  const [indicatorSeriesReady, setIndicatorSeriesReady] = useState(0);

  const handleChartReady = useCallback(({ chartRef: cRef, seriesRef: sRef }) => {
    indicatorChartRefRef.current = cRef;    // store the REF object, not .current
    indicatorSeriesRefRef.current = sRef;   // store the REF object, not .current
    setIndicatorSeriesReady((prev) => prev + 1);
  }, []);

  const {
    activeIndicators,
    computing: indicatorComputing,
    addIndicator,
    removeIndicator: rawRemoveIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    recompute: recomputeIndicatorsWithUI,
    requestIndicatorRange,
    mainOverlayLines,
    subPanes,
    // Extended output types (Pyne drawing API)
    markers: indicatorMarkers,
    fills: indicatorFills,
    hlines: indicatorHlines,
    bgcolors: indicatorBgcolors,
    barcolors: indicatorBarcolors,
    paramSchemas: indicatorParamSchemas,
  } = useIndicators({
    chartRef: indicatorChartRefRef,
    seriesRef: indicatorSeriesRefRef,
    chartData,
    chartDataMeta,
    datasetKey,
    seriesReady: indicatorSeriesReady,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
    symbol,
    interval,
    marketType,
    exchange,
  });
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
    clearSavedDrawings(`${chartStorageKeyBase}-separate-${indicatorId}`);
    clearSavedDrawings(`${chartStorageKeyBase}-volume-${indicatorId}`);
  }, [chartStorageKeyBase, rawRemoveIndicator]);

  // Canonical real-time price — always derived from the fastest (1m) stream
  // so all intervals display the same "current price" in the header.
  const updateLastPrice = useCallback((candidate, intv) => {
    setLastPrice((prev) => {
      if (!candidate || candidate.time == null) return prev;
      // Guard: only accept OHLCV from the currently active interval.
      // Without this, backfill events or stale fetches for non-current
      // intervals would overwrite the header with wrong data.
      if (intv !== intervalRef.current) return prev;
      // Build a display object that keeps OHLCV from the active interval's
      // last candle but overrides "close" with the most recent real-time price
      // when available, so the header always shows one consistent price.
      const rtPrice = realtimePriceRef.current;
      if (rtPrice != null) {
        return { ...candidate, close: rtPrice };
      }
      return candidate;
    });
  }, [intervalRef, realtimePriceRef]);

  /** Update the canonical real-time price (called from WS tick handler). */
  const updateRealtimePrice = useCallback((closePrice) => {
    realtimePriceRef.current = closePrice;
    // Also push it into the displayed lastPrice immediately so the header
    // updates in real-time even when the active interval's candle hasn't changed.
    setLastPrice((prev) => {
      if (!prev) return prev;
      if (prev.close === closePrice) return prev;
      return { ...prev, close: closePrice };
    });
  }, [realtimePriceRef]);

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
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    pendingLoadMoreLeftRef,
    handleNeedMoreLeft,
  } = useChartLoadMoreLeft({
    symbol,
    exchange,
    marketType,
    interval,
    chartData,
    loading,
    dataSource,
    cacheKey,
    commitMergedChartData,
    requestIndicatorRange,
  });

  const loadData = useChartInitialLoad({
    exchange,
    marketType,
    getIntervalDays: getExchangeIntervalDays,
    getFromCache,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
    pendingInitialHistoryRef,
    updateLastPrice,
    setConnectionStatus,
    setDatasetKey,
    setLoading,
    setError,
    setLoadingMoreLeft,
    setHasMoreLeft,
    setCrosshairData,
    setDataSource,
  });

  useEffect(() => {
    loadData(symbol, interval, marketType, exchange);
  }, [symbol, interval, marketType, exchange, loadData]);

  const handleBackfillCompleted = useBackfillCompletionRuntime({
    symbol,
    exchange,
    marketType,
    intervalRef,
    loadingRef,
    pendingInitialHistoryRef,
    pendingLoadMoreLeftRef,
    cacheKey,
    getIntervalDays: getExchangeIntervalDays,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
    setDatasetKey,
  });

  useKlineStreamRuntime({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    trackedIntervalsRef,
    intervalRef,
    getIntervalDays: getExchangeIntervalDays,
    commitMergedChartData,
    commitPatchedChartData,
    patchCacheTick,
    updateLastPrice,
    updateRealtimePrice,
    handleBackfillCompleted,
    setWsStatus,
  });

  useChartBackgroundPrefetch({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    hasCache,
    setCache,
    enabled: activeChartReady,
  });

  const { resetGapRecovery } = useChartGapRecovery({
    loading,
    dataReady: activeChartReady,
    dataSource,
    symbol,
    exchange,
    marketType,
    intervalRef,
    trackedIntervalsRef,
    getIntervalDays: getExchangeIntervalDays,
    getCache,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    updateLastPrice,
  });

  useEffect(() => {
    chartSessionRuntimeBridgeRef.current = {
      chartDataMeta,
      clearCache,
      clearChartData,
      resetGapRecovery,
      setLastPrice,
      setCrosshairData,
      setLoading,
      setError,
      setHasMoreLeft,
    };
  }, [
    chartDataMeta,
    clearCache,
    clearChartData,
    resetGapRecovery,
    setCrosshairData,
    setError,
    setHasMoreLeft,
    setLastPrice,
    setLoading,
  ]);

  const {
    displayData,
    priceChange,
    isUp,
    amplitude,
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  } = buildChartDisplayState({
    crosshairData,
    lastPrice,
    wsStatus,
    exchange,
    exchangeConfig,
    marketType,
  });

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
          onRetryLoad: () => loadData(symbol, interval),
          chartProps: {
            ref: chartWidgetRef,
            data: renderChartData,
            symbol,
            drawingKeyBase: chartStorageKeyBase,
            interval,
            loading,
            onCrosshairMove: setCrosshairData,
            onNeedMoreLeft: handleNeedMoreLeft,
            canLoadMoreLeft: hasMoreLeft && !loadingMoreLeft && !loading,
            datasetKey,
            upColor: settings.upColor,
            downColor: settings.downColor,
            theme: resolvedTheme,
            customBg: settings.customBg,
            timezone: settings.timezone,
            savedVisibleRange,
            dataMeta: chartDataMeta,
            onVisibleRangeChange: handleVisibleRangeChange,
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
            onChartReady: handleChartReady,
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
        barCount={chartData.length}
        loadingMoreLeft={loadingMoreLeft}
        hasMoreLeft={hasMoreLeft}
        exchangeCatalogStatus={exchangeCatalogStatus}
        exchangeLimitations={exchangeLimitations}
      />
    </div>
  );
}
