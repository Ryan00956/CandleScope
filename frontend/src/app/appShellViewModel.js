export function buildAppShellViewModel({
  session,
  marketData,
  drawings,
  indicators,
  settings,
  priceScale,
  watchlist,
  exportFlow,
  alerts,
}) {
  const sessionView = session.view;
  const sessionActions = session.actions;
  const sessionStatus = session.status;
  const marketView = marketData.view;
  const marketActions = marketData.actions;
  const marketStatus = marketData.status;
  const drawingView = drawings.view;
  const drawingActions = drawings.actions;
  const indicatorView = indicators.view;
  const indicatorActions = indicators.actions;
  const indicatorStatus = indicators.status;
  const watchlistView = watchlist.view;
  const watchlistActions = watchlist.actions;
  const settingsView = settings.view;
  const settingsActions = settings.actions;
  const exportView = exportFlow.view;
  const exportActions = exportFlow.actions;
  const exportStatus = exportFlow.status;
  const priceScaleView = priceScale.view;
  const priceScaleActions = priceScale.actions;
  const alertsView = alerts.view;
  const alertsActions = alerts.actions;

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
  } = sessionView;
  const chartSettings = settingsView.settings;
  const resolvedTheme = settingsView.resolvedTheme;
  const marketDisplay = marketView.display || {};
  const {
    displayData,
    priceChange,
    isUp,
    amplitude,
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  } = marketDisplay;
  const chartStorageKeyBase = `${exchange}:${marketType}:${symbol}`;
  const exportInProgress = exportStatus.inProgress;
  const indicatorComputing = indicatorStatus.computing;

  return {
    topBar: {
      symbolSearch: {
        currentSymbol: symbol,
        currentMarketType: marketType,
        currentExchange: exchange,
        exchangeCatalog,
        onSelectSymbol: sessionActions.selectSymbol,
        watchlists: watchlistView.watchlists,
        onAddToWatchlist: watchlistActions.addToWatchlist,
      },
      controls: {
        onOpenSettings: settingsActions.openPanel,
        indicatorPanelOpen: indicatorView.isPanelOpen,
        onToggleIndicatorPanel: indicatorActions.togglePanel,
        alertPanelOpen: alertsView.isOpen,
        onToggleAlertPanel: alertsActions.togglePanel,
        activeIndicatorCount: indicatorView.activeIndicators.length,
      },
      marketSummary: { displayData, isUp, priceChange, amplitude },
    },
    intervalSelector: {
      interval,
      nativeIntervals,
      intervalGroups,
      customIntervalRecords,
      savedCustomIntervals,
      onSelectInterval: sessionActions.selectInterval,
      onCreateCustomInterval: sessionActions.createCustomInterval,
      onRemoveCustomInterval: sessionActions.removeCustomInterval,
      onRestoreCustomInterval: sessionActions.restoreCustomInterval,
      onTogglePinCustomInterval: sessionActions.togglePinCustomInterval,
      onClearCustomIntervals: sessionActions.clearCustomIntervals,
      intervalNotice,
    },
    chartWorkspace: {
      drawingToolbar: {
        activeTool: drawingView.drawingTool,
        onToolChange: drawingActions.setDrawingTool,
        penColor: drawingView.penColor,
        onPenColorChange: drawingActions.setPenColor,
        penSize: drawingView.penSize,
        onPenSizeChange: drawingActions.setPenSize,
        onClearAll: drawingActions.handleClearDrawing,
        drawingsHidden: drawingView.drawingsHidden,
        onToggleDrawingsHidden: drawingActions.handleToggleDrawingsHidden,
        drawingSnapEnabled: drawingView.drawingSnapEnabled,
        onDrawingSnapEnabledChange: drawingActions.handleDrawingSnapEnabledChange,
        textFontSize: drawingView.textFontSize,
        onTextFontSizeChange: drawingActions.setTextFontSize,
        textBold: drawingView.textBold,
        onTextBoldChange: drawingActions.setTextBold,
        textItalic: drawingView.textItalic,
        onTextItalicChange: drawingActions.setTextItalic,
        fibLevels: drawingView.fibLevels,
        onFibLevelsChange: drawingActions.handleFibLevelsChange,
        fibInverted: drawingView.fibInverted,
        onFibInvertedChange: drawingActions.handleFibInvertedChange,
        positionSize: drawingView.positionSize,
        onPositionSizeChange: drawingActions.handlePositionSizeChange,
        selectedDrawing: drawingView.selectedDrawing,
        onSelectedDrawingStyleChange: drawingActions.handleSelectedDrawingStyleChange,
        exportPanelOpen: exportView.isOpen,
        exportInProgress,
        onToggleExportPanel: exportActions.togglePanel,
      },
      exportPanel: {
        isOpen: exportView.isOpen,
        options: exportView.options,
        onOptionsChange: exportActions.updateOptions,
        onExport: exportActions.exportChart,
        onClose: exportActions.closePanel,
        inProgress: exportInProgress,
        error: exportView.error,
        notice: exportView.notice,
        metadata: exportView.metadata,
        loading: marketView.loading || marketStatus.loadingMoreLeft,
        indicatorComputing,
        preview: exportView.preview,
      },
      chart: {
        error: marketView.error,
        onRetryLoad: marketActions.retry,
        chartProps: {
          data: marketView.renderBars,
          symbol,
          drawingKeyBase: chartStorageKeyBase,
          interval,
          loading: marketView.loading,
          onCrosshairMove: marketActions.onCrosshairMove,
          onNeedMoreLeft: marketActions.loadMoreLeft,
          canLoadMoreLeft: marketStatus.canLoadMoreLeft,
          datasetKey,
          upColor: chartSettings.upColor,
          downColor: chartSettings.downColor,
          theme: resolvedTheme,
          customBg: chartSettings.customBg,
          timezone: chartSettings.timezone,
          savedVisibleRange,
          dataMeta: marketView.meta,
          onVisibleRangeChange: marketActions.onVisibleRangeChange,
          drawingTool: drawingView.drawingTool,
          onDrawingToolChange: drawingActions.setDrawingTool,
          penColor: drawingView.penColor,
          penSize: drawingView.penSize,
          textFontSize: drawingView.textFontSize,
          textBold: drawingView.textBold,
          textItalic: drawingView.textItalic,
          fibLevels: drawingView.fibLevels,
          fibInverted: drawingView.fibInverted,
          positionSize: drawingView.positionSize,
          drawingSnapEnabled: drawingView.drawingSnapEnabled,
          onSelectedDrawingChange: drawingActions.handleSelectedDrawingChange,
          mainOverlayLines: indicatorView.mainOverlayLines,
          subPanes: indicatorView.subPanes,
          indicatorMarkers: indicatorView.markers,
          indicatorFills: indicatorView.fills,
          indicatorHlines: indicatorView.hlines,
          indicatorBgcolors: indicatorView.bgcolors,
          indicatorBarcolors: indicatorView.barcolors,
          invertScale: priceScaleView.invertScale,
          onInvertScaleChange: priceScaleActions.setInvertScale,
          priceScaleMode: priceScaleView.priceScaleMode,
          onPriceScaleModeChange: priceScaleActions.setPriceScaleMode,
        },
      },
      watchlist: {
        currentSymbol: symbol,
        currentMarketType: marketType,
        currentExchange: exchange,
        onSelectSymbol: sessionActions.selectSymbol,
        watchlists: watchlistView.watchlists,
        layout: watchlistView.layout,
        actions: watchlistActions,
        prices: watchlistView.prices,
        subscriptionTiers: watchlistView.subscriptionTiers,
        onTierChange: watchlistActions.handleTierChange,
        upColor: chartSettings.upColor,
        downColor: chartSettings.downColor,
      },
    },
    lazySurfaces: {
      indicatorPanel: {
        isOpen: indicatorView.isPanelOpen,
        onClose: indicatorActions.closePanel,
        activeIndicators: indicatorView.activeIndicators,
        paramSchemas: indicatorView.paramSchemas,
        computing: indicatorComputing,
        onAddIndicator: indicatorActions.addIndicator,
        onRemoveIndicator: indicatorActions.removeIndicator,
        onToggleVisibility: indicatorActions.toggleVisibility,
        onUpdateParams: indicatorActions.updateIndicatorParams,
        onUpdateScript: indicatorActions.updateIndicatorScript,
        onRecompute: indicatorActions.recompute,
      },
      alertsPanel: {
        isOpen: alertsView.isOpen,
        onClose: alertsActions.closePanel,
        currentSymbol: symbol,
        currentMarketType: marketType,
        currentExchange: exchange,
        currentInterval: interval,
        displayPrice: displayData?.close ?? marketView.lastPrice?.close,
        wsStatus: marketView.wsStatus,
        watchlists: watchlistView.watchlists,
      },
      settingsModal: {
        isOpen: settingsView.isOpen,
        onClose: settingsActions.closePanel,
        settings: chartSettings,
        onUpdate: settingsActions.update,
        currentSymbol: symbol,
        currentMarketType: marketType,
        currentExchange: exchange,
        watchlists: watchlistView.watchlists,
      },
    },
    statusBar: {
      connectionStatus: marketView.connectionStatus,
      dataSource: marketView.dataSource,
      exchangeLabel,
      marketLabel,
      wsStatusLabel,
      barCount: marketStatus.barCount,
      loadingMoreLeft: marketStatus.loadingMoreLeft,
      hasMoreLeft: marketStatus.hasMoreLeft,
      exchangeCatalogStatus: sessionStatus.exchangeCatalogStatus,
      exchangeLimitations: sessionStatus.exchangeLimitations,
    },
  };
}