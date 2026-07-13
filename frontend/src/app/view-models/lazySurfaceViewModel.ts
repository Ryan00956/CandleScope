import type { AppShellViewModelContext } from "../appShellContracts.js";
import type { LazyFeatureSurfaceModels } from "../LazyFeatureSurfaces.js";

export function buildLazySurfaceViewModel({
  alertsActions,
  alertsView,
  chartSettings,
  displayData,
  indicatorActions,
  indicatorComputing,
  indicatorView,
  marketStatus,
  marketView,
  sessionView,
  settingsActions,
  settingsView,
  watchlistView,
}: AppShellViewModelContext): LazyFeatureSurfaceModels {
  const {
    symbol,
    exchange,
    marketType,
    interval,
  } = sessionView;

  return {
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
      chartDataCacheDiagnostics: marketStatus.cacheDiagnostics,
      trimChartDataCacheEntries: marketStatus.trimCacheEntries,
    },
  };
}
