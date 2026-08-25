import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./index.css";
import "./features/backtest/backtest.css";
import "./features/backtest/research/backtestResearch.css";
import {
  isBacktestLegacyWorkbenchEnabled,
  isBacktestResearchEnabled,
} from "./features/backtest/backtestFlags.js";
import { mountStrategyResearchPage } from "./features/strategy-research/strategyResearchBootstrap.js";

mountStrategyResearchPage({
  page: "backtest",
  researchEnabled: isBacktestResearchEnabled(),
  legacyEnabled: isBacktestLegacyWorkbenchEnabled(),
}); // compatibility URL; canonical is /strategy.html
