import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import AppProviders, { ChartErrorBoundary } from "./app/AppProviders.js";
import { MarketDataWorkspaceProvider } from "./features/market-data/MarketDataWorkspaceProvider.js";
import {
  isBacktestLegacyWorkbenchEnabled,
  isBacktestResearchEnabled,
} from "./features/backtest/backtestFlags.js";
import { readPersistedLocale } from "./features/settings/chartAppearanceSettings.js";
import { bindDocumentLocale, hydrateLocale } from "./i18n/index.js";
import "./index.css";
import "./features/backtest/backtest.css";
import "./features/backtest/research/backtestResearch.css";
import BacktestResearchDisabled from "./features/backtest/research/BacktestResearchDisabled.js";

const BacktestApp = lazy(() => import("./features/backtest/BacktestApp.js"));
const BacktestResearchApp = lazy(() => import("./features/backtest/research/BacktestResearchApp.js"));

hydrateLocale(readPersistedLocale());
bindDocumentLocale({
  titleKey: "backtest.documentTitle",
  descriptionKey: "backtest.documentDescription",
});

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Backtest document root is missing");

const researchEnabled = isBacktestResearchEnabled();
const legacyEnabled = isBacktestLegacyWorkbenchEnabled();

createRoot(root).render(
  <StrictMode>
    <ChartErrorBoundary>
      <Suspense fallback={<main className="research-status-page" data-state="loading" />}>
        {researchEnabled ? (
          <AppProviders>
            <MarketDataWorkspaceProvider>
              <BacktestResearchApp />
            </MarketDataWorkspaceProvider>
          </AppProviders>
        ) : legacyEnabled ? <BacktestApp /> : <BacktestResearchDisabled />}
      </Suspense>
    </ChartErrorBoundary>
  </StrictMode>,
);
