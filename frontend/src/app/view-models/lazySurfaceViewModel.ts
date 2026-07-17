import type { AppShellViewModelContext } from "../appShellContracts.js";
import type { LazyFeatureSurfaceModels } from "../LazyFeatureSurfaces.js";
import type { IndicatorPanelMarketStudyStatus } from "../../features/indicators/IndicatorPanel.js";
import { isMarketMetricId } from "../../features/advanced-market-data/marketMetricSelectionTypes.js";

function marketStudyStatus(
  status: AppShellViewModelContext["advancedMarketView"]["marketStudies"][number]["status"],
): IndicatorPanelMarketStudyStatus {
  if (status === "loading") return "loading";
  if (status === "active") return "ready";
  if (status === "error") return "error";
  if (status === "hidden" || status === "unavailable") return "dormant";
  return "idle";
}

export function buildLazySurfaceViewModel({
  alertsActions,
  alertsView,
  advancedMarketActions,
  advancedMarketView,
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
  const displayPrice = displayData?.close ?? marketView.lastPrice?.close;

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
      marketStudies: advancedMarketView.marketStudies.map((study) => ({
        id: study.id,
        name: study.name,
        description: study.description,
        added: study.added,
        visible: study.visible,
        supported: study.supported,
        unsupportedReason: study.supportReason,
        status: marketStudyStatus(study.status),
        statusText: study.status === "hidden"
          ? "已隐藏，实时订阅已暂停"
          : study.status === "loading"
            ? "正在加载市场数据"
            : study.status === "unavailable"
              ? study.supportReason
              : null,
        error: study.error,
      })),
      onAddMarketStudy: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.addMarketStudy(id);
      },
      onRemoveMarketStudy: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.removeMarketStudy(id);
      },
      onToggleMarketStudyVisibility: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.toggleMarketStudyVisibility(id);
      },
    },
    alertsPanel: {
      isOpen: alertsView.isOpen,
      onClose: alertsActions.closePanel,
      currentSymbol: symbol,
      currentMarketType: marketType,
      currentExchange: exchange,
      currentInterval: interval,
      ...(displayPrice === undefined ? {} : { displayPrice }),
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
