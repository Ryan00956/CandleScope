import type { AppShellViewModelContext } from "../appShellContracts.js";
import type { LazyFeatureSurfaceModels } from "../LazyFeatureSurfaces.js";
import type { IndicatorPanelMarketStudyStatus } from "../../features/indicators/IndicatorPanel.js";
import { isMarketMetricId } from "../../features/advanced-market-data/marketMetricSelectionTypes.js";
import {
  isTradeFlowIndicatorId,
  TRADE_FLOW_INDICATOR_DEFINITIONS,
} from "../../features/trade-flow/tradeFlowTypes.js";

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
  tradeFlowActions,
  tradeFlowView,
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
      marketStudies: [
        ...advancedMarketView.marketStudies.map((study) => ({
          id: study.id,
          name: study.name,
          description: study.description,
          category: study.category,
          added: study.added,
          visible: study.visible,
          supported: study.supported,
          unsupportedReason: study.supportReason,
          status: study.id === "market:liquidations" && study.status === "hidden"
            ? "ready" as const
            : marketStudyStatus(study.status),
          statusText: study.status === "hidden"
            ? study.id === "market:liquidations"
              ? "已隐藏，仍在后台采集观测爆仓"
              : "已隐藏，实时订阅已暂停"
            : study.status === "loading"
              ? "正在加载市场数据"
              : study.status === "unavailable"
                ? study.supportReason
                : null,
          error: study.error,
        })),
        ...TRADE_FLOW_INDICATOR_DEFINITIONS.map((definition) => {
          const selection = tradeFlowView.preferences.indicators[definition.key];
          return {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            category: definition.category,
            added: selection.added,
            visible: selection.visible,
            supported: tradeFlowView.supported,
            unsupportedReason: tradeFlowView.supportMessage,
            status: !tradeFlowView.supported
              ? "dormant" as const
              : selection.added && selection.visible
                ? "ready" as const
                : selection.added
                  ? "dormant" as const
                  : "idle" as const,
            statusText: !tradeFlowView.supported
              ? tradeFlowView.supportMessage
              : selection.added && !selection.visible
                ? "已隐藏；右侧成交/分布视图不受影响"
                : selection.added
                  ? "使用 K 线订单流字段；右侧成交/分布视图独立控制"
                  : null,
            error: null,
          };
        }),
      ],
      onAddMarketStudy: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.addMarketStudy(id);
        else if (isTradeFlowIndicatorId(id)) tradeFlowActions.addIndicator(id);
      },
      onRemoveMarketStudy: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.removeMarketStudy(id);
        else if (isTradeFlowIndicatorId(id)) tradeFlowActions.removeIndicator(id);
      },
      onToggleMarketStudyVisibility: (id) => {
        if (isMarketMetricId(id)) advancedMarketActions.toggleMarketStudyVisibility(id);
        else if (isTradeFlowIndicatorId(id)) tradeFlowActions.toggleIndicatorVisibility(id);
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
