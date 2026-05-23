import { buildChartWorkspaceViewModel } from "./view-models/chartWorkspaceViewModel";
import { buildIntervalSelectorViewModel } from "./view-models/intervalSelectorViewModel";
import { buildLazySurfaceViewModel } from "./view-models/lazySurfaceViewModel";
import { buildStatusBarViewModel } from "./view-models/statusBarViewModel";
import { buildTopBarViewModel } from "./view-models/topBarViewModel";

function buildAppShellViewModelContext({
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
    drawingView: drawings.view,
    drawingActions: drawings.actions,
    indicatorView: indicators.view,
    indicatorActions: indicators.actions,
    indicatorComputing: indicatorStatus.computing,
    watchlistView: watchlist.view,
    watchlistActions: watchlist.actions,
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
  };
}

export function buildAppShellViewModel(inputs) {
  const context = buildAppShellViewModelContext(inputs);

  return {
    topBar: buildTopBarViewModel(context),
    intervalSelector: buildIntervalSelectorViewModel(context),
    chartWorkspace: buildChartWorkspaceViewModel(context),
    lazySurfaces: buildLazySurfaceViewModel(context),
    statusBar: buildStatusBarViewModel(context),
  };
}
