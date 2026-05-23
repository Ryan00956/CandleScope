export function buildTopBarViewModel({
  alertsActions,
  alertsView,
  indicatorActions,
  indicatorView,
  marketDisplay,
  sessionActions,
  sessionView,
  settingsActions,
  watchlistActions,
  watchlistView,
}) {
  const {
    symbol,
    exchange,
    marketType,
    exchangeCatalog,
  } = sessionView;
  const {
    displayData,
    priceChange,
    isUp,
    amplitude,
  } = marketDisplay;

  return {
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
  };
}
