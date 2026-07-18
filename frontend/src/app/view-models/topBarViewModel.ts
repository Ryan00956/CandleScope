import type { AppShellViewModelContext } from "../appShellContracts.js";
import type { TopBarProps } from "../TopBar.js";

export function buildTopBarViewModel({
  advancedMarketView,
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
  replayEntry,
}: AppShellViewModelContext): TopBarProps {
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
      activeIndicatorCount: indicatorView.activeIndicators.length
        + advancedMarketView.marketStudies.filter((study) => study.added).length,
    },
    marketSummary: { displayData, isUp, priceChange, amplitude },
    advancedMarketData: advancedMarketView,
    replayEntry,
  };
}
