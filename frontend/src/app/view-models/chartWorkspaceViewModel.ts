import type { ChartWorkspaceProps } from "../ChartWorkspace.js";
import type { AppShellViewModelContext } from "../appShellContracts.js";
import { isMarketMetricId } from "../../features/advanced-market-data/marketMetricSelectionTypes.js";
import { isTradeFlowIndicatorId } from "../../features/trade-flow/tradeFlowTypes.js";

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

export function buildChartWorkspaceViewModel({
  advancedMarketActions,
  advancedMarketView,
  chartSettings,
  drawingActions,
  drawingView,
  exportActions,
  exportInProgress,
  exportView,
  indicatorComputing,
  indicatorActions,
  indicatorView,
  marketActions,
  marketStatus,
  marketView,
  priceScaleActions,
  priceScaleView,
  resolvedTheme,
  sessionActions,
  sessionView,
  settingsActions,
  watchlistActions,
  watchlistView,
  orderBookActions,
  orderBookStatus,
  orderBookView,
  tradeFlowActions,
  tradeFlowStatus,
  tradeFlowView,
}: AppShellViewModelContext): ChartWorkspaceProps {
  const {
    symbol,
    exchange,
    marketType,
    interval,
    datasetKey,
    savedVisibleRange,
  } = sessionView;
  const chartStorageKeyBase = `${exchange}:${marketType}:${symbol}`;

  return {
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
      drawingContinuousEnabled: drawingView.drawingContinuousEnabled,
      onDrawingContinuousEnabledChange: drawingActions.handleDrawingContinuousEnabledChange,
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
      chartType: chartSettings.chartType,
      onChartTypeChange: (chartType) => settingsActions.update({ ...chartSettings, chartType }),
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
      error: errorMessage(marketView.error),
      onRetryLoad: marketActions.retry,
      advancedMarketData: advancedMarketView,
      chartProps: {
        seriesStore: marketView.seriesStore,
        symbol,
        drawingKeyBase: chartStorageKeyBase,
        interval,
        loading: marketView.loading,
        onCrosshairMove: marketActions.onCrosshairMove,
        onNeedMoreLeft: marketActions.loadMoreLeft,
        ...(marketActions.restoreLatestWindow === undefined ? {} : {
          onNeedMoreRight: marketActions.restoreLatestWindow,
        }),
        canLoadMoreLeft: marketStatus.canLoadMoreLeft,
        canRestoreLatestWindow: marketStatus.canRestoreLatestWindow,
        datasetKey,
        upColor: chartSettings.upColor,
        downColor: chartSettings.downColor,
        chartType: chartSettings.chartType,
        renkoBoxSizeMode: chartSettings.renkoBoxSizeMode,
        renkoAtrLength: chartSettings.renkoAtrLength,
        renkoBoxSize: chartSettings.renkoBoxSize,
        pointFigureBoxSizeMode: chartSettings.pointFigureBoxSizeMode,
        pointFigureAtrLength: chartSettings.pointFigureAtrLength,
        pointFigureBoxSize: chartSettings.pointFigureBoxSize,
        pointFigureReversalAmount: chartSettings.pointFigureReversalAmount,
        kagiReversalMode: chartSettings.kagiReversalMode,
        kagiAtrLength: chartSettings.kagiAtrLength,
        kagiReversalAmount: chartSettings.kagiReversalAmount,
        lineBreakNumberOfLines: chartSettings.lineBreakNumberOfLines,
        theme: resolvedTheme,
        customBg: chartSettings.customBg,
        ...(chartSettings.timezone === undefined ? {} : { timezone: chartSettings.timezone }),
        savedVisibleRange,
        dataMeta: marketView.meta,
        onViewportRangeChange: (range) => {
          indicatorActions?.ensureVisibleIndicatorRange?.(range);
          advancedMarketActions?.ensureVisibleRange?.(range);
        },
        onVisibleRangeChange: (range) => marketActions.onVisibleRangeChange?.(range),
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
        drawingContinuousEnabled: drawingView.drawingContinuousEnabled,
        onSelectedDrawingChange: drawingActions.handleSelectedDrawingChange,
        mainOverlayLines: indicatorView.mainOverlayLines,
        subPanes: indicatorView.subPanes,
        indicatorMarkers: indicatorView.markers,
        indicatorFills: indicatorView.fills,
        indicatorHlines: indicatorView.hlines,
        indicatorBgcolors: indicatorView.bgcolors,
        indicatorBarcolors: indicatorView.barcolors,
        onRemoveSubPane: (pane) => {
          const owner = pane.owner;
          if (!owner) return;
          if (owner.kind === "indicator") {
            indicatorActions.removeIndicator(owner.id);
            return;
          }
          if (owner.kind === "market-study" && isMarketMetricId(owner.id)) {
            advancedMarketActions.removeMarketStudy(owner.id);
            return;
          }
          if (owner.kind === "trade-flow" && isTradeFlowIndicatorId(owner.id)) {
            tradeFlowActions.removeIndicator(owner.id);
          }
        },
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
      priceStore: watchlistView.priceStore,
      subscriptionTiers: watchlistView.subscriptionTiers,
      subscriptionResourceSummaries: watchlistView.subscriptionResourceSummaries,
      onTierChange: watchlistActions.handleTierChange,
      upColor: chartSettings.upColor,
      downColor: chartSettings.downColor,
    },
    orderBook: {
      view: orderBookView,
      actions: orderBookActions,
      status: orderBookStatus,
    },
    tradeFlow: {
      view: tradeFlowView,
      actions: tradeFlowActions,
      status: tradeFlowStatus,
    },
  };
}
