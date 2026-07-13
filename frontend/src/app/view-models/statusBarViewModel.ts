import type { AppShellViewModelContext } from "../appShellContracts.js";
import type { StatusBarModel } from "../StatusBar.js";

export function buildStatusBarViewModel({
  marketDisplay,
  marketStatus,
  marketView,
  sessionStatus,
}: AppShellViewModelContext): StatusBarModel {
  const {
    wsStatusLabel,
    exchangeLabel,
    marketLabel,
  } = marketDisplay;

  return {
    connectionStatus: marketView.connectionStatus,
    dataSource: marketView.dataSource || "",
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
