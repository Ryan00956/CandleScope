import { MarketDataWorkspaceProvider } from "../market-data/MarketDataWorkspaceProvider.js";
import BacktestResearchApp from "./research/BacktestResearchApp.js";

export default function BacktestApp() {
  return (
    <MarketDataWorkspaceProvider>
      <BacktestResearchApp />
    </MarketDataWorkspaceProvider>
  );
}
