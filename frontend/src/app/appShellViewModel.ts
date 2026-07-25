import { buildChartWorkspaceViewModel } from "./view-models/chartWorkspaceViewModel";
import { buildIntervalSelectorViewModel } from "./view-models/intervalSelectorViewModel";
import { buildLazySurfaceViewModel } from "./view-models/lazySurfaceViewModel";
import { buildStatusBarViewModel } from "./view-models/statusBarViewModel";
import { buildTopBarViewModel } from "./view-models/topBarViewModel";
import type {
  AppShellRuntimeInputs,
  AppShellViewModel,
  AppShellViewModelContext,
} from "./appShellContracts.js";

function buildAppShellViewModelContext({
  session,
  marketData,
  advancedMarketData,
  drawings,
  indicators,
  settings,
  priceScale,
  watchlist,
  orderBook,
  tradeFlow,
  exportFlow,
  alerts,
  replayEntry,
  onOpenReplayLauncher,
}: AppShellRuntimeInputs): AppShellViewModelContext {
  const sessionView = session.view;
  const marketView = marketData.view;
  const settingsView = settings.view;
  const exportStatus = exportFlow.status;
  const indicatorStatus = indicators.status;
  const marketDisplay = marketView.display || {};

  return {
    sessionView,
    sessionActions: session.actions,
    sessionStatus: session.status,
    marketView,
    marketActions: marketData.actions,
    marketStatus: marketData.status,
    advancedMarketView: advancedMarketData.view,
    advancedMarketActions: advancedMarketData.actions,
    drawingView: drawings.view,
    drawingActions: drawings.actions,
    indicatorView: indicators.view,
    indicatorActions: indicators.actions,
    indicatorComputing: indicatorStatus.computing,
    indicatorRealtimeMode: indicatorStatus.realtimeMode,
    watchlistView: watchlist.view,
    watchlistActions: watchlist.actions,
    orderBookView: orderBook.view,
    orderBookActions: orderBook.actions,
    orderBookStatus: orderBook.status,
    tradeFlowView: tradeFlow.view,
    tradeFlowActions: tradeFlow.actions,
    tradeFlowStatus: tradeFlow.status,
    settingsView,
    settingsActions: settings.actions,
    chartSettings: settingsView.settings,
    resolvedTheme: settingsView.resolvedTheme,
    exportView: exportFlow.view,
    exportActions: exportFlow.actions,
    exportInProgress: exportStatus.inProgress,
    priceScaleView: priceScale.view,
    priceScaleActions: priceScale.actions,
    alertsView: alerts.view,
    alertsActions: alerts.actions,
    marketDisplay,
    displayData: marketDisplay.displayData,
    replayEntry,
    onOpenReplayLauncher,
  };
}

export function buildAppShellViewModel(inputs: AppShellRuntimeInputs): AppShellViewModel {
  const context = buildAppShellViewModelContext(inputs);

  return {
    topBar: buildTopBarViewModel(context),
    intervalSelector: buildIntervalSelectorViewModel(context),
    chartWorkspace: buildChartWorkspaceViewModel(context),
    lazySurfaces: buildLazySurfaceViewModel(context),
    statusBar: buildStatusBarViewModel(context),
  };
}
