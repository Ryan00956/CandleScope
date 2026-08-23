import { t } from "../../i18n/index.js";
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
  indicatorRealtimeMode,
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
      realtimeMode: indicatorRealtimeMode,
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
              ? t("study.hiddenLiq")
              : t("study.hiddenPaused")
            : study.status === "loading"
              ? t("study.loading")
              : study.status === "unavailable"
                ? study.supportReason
                : null,
          error: study.error,
        })),
        ...TRADE_FLOW_INDICATOR_DEFINITIONS.map((definition) => {
          const selection = tradeFlowView.preferences.indicators[definition.key];
          return {
            id: definition.id,
            name: t(definition.nameKey),
            description: t(definition.descriptionKey),
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
                ? t("study.hiddenTape")
                : selection.added
                  ? t("study.usingKline")
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
