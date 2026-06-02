export function buildStatusBarViewModel({
  marketDisplay,
  marketStatus,
  marketView,
  sessionStatus,
}) {
  const {
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  } = marketDisplay;

  return {
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
  };
}
