import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import AppProviders, { ChartErrorBoundary } from "../../app/AppProviders.js";
import { MarketDataWorkspaceProvider } from "../market-data/MarketDataWorkspaceProvider.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "../research-data/researchDataFlags.js";
import { bindDocumentLocale, hydrateLocale } from "../../i18n/index.js";
import { readPersistedLocale } from "../settings/chartAppearanceSettings.js";
import "./strategyResearch.css";
import {
  parseStrategyResearchLaunch,
  resolveStrategyResearchBootstrap,
  type StrategyResearchLaunchIntent,
  type StrategyResearchPage,
} from "./strategyResearchLaunch.js";

const StrategyResearchApp = lazy(() => import("./StrategyResearchApp.js"));
const LocalApp = lazy(() => import("../local-data/LocalApp.js"));
const BacktestApp = lazy(() => import("../backtest/BacktestApp.js"));
const BacktestResearchApp = lazy(() => import("../backtest/research/BacktestResearchApp.js"));
const BacktestResearchDisabled = lazy(() => import("../backtest/research/BacktestResearchDisabled.js"));

export function strategyResearchDocumentKeys(page: StrategyResearchPage): {
  titleKey: "strategy.documentTitle" | "local.documentTitle" | "backtest.documentTitle";
  descriptionKey: "strategy.documentDescription" | "local.documentDescription" | "backtest.documentDescription";
} {
  if (page === "local") {
    return { titleKey: "local.documentTitle", descriptionKey: "local.documentDescription" };
  }
  if (page === "backtest") {
    return { titleKey: "backtest.documentTitle", descriptionKey: "backtest.documentDescription" };
  }
  return { titleKey: "strategy.documentTitle", descriptionKey: "strategy.documentDescription" };
}

export function renderStrategyResearchBootstrap(input: {
  page: StrategyResearchPage;
  location?: { pathname: string; search: string };
  libraryEnabled?: boolean;
  researchEnabled?: boolean;
  legacyEnabled?: boolean;
}): ReactNode {
  const libraryEnabled = input.libraryEnabled ?? RESEARCH_DATA_LIBRARY_ENABLED;
  const location = input.location ?? { pathname: `/${input.page}.html`, search: "" };
  const intent: StrategyResearchLaunchIntent = parseStrategyResearchLaunch(location);
  const mode = resolveStrategyResearchBootstrap({ libraryEnabled, page: input.page });
  if (mode === "unified") {
    return <StrategyResearchApp intent={intent} libraryEnabled={libraryEnabled} />;
  }
  if (mode === "local-legacy") {
    return <LocalApp />;
  }
  if (input.researchEnabled === false && input.legacyEnabled === false) {
    return <BacktestResearchDisabled />;
  }
  if (input.researchEnabled === false) {
    return <BacktestApp />;
  }
  return (
    <MarketDataWorkspaceProvider>
      <BacktestResearchApp />
    </MarketDataWorkspaceProvider>
  );
}

export function mountStrategyResearchPage(input: {
  page: StrategyResearchPage;
  researchEnabled?: boolean;
  legacyEnabled?: boolean;
}): void {
  hydrateLocale(readPersistedLocale());
  bindDocumentLocale(strategyResearchDocumentKeys(input.page));
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Strategy research document root is missing");
  }
  const location = { pathname: window.location.pathname, search: window.location.search };
  createRoot(root).render(
    <StrictMode>
      <ChartErrorBoundary>
        <Suspense fallback={<main className="research-status-page" data-state="loading" />}>
          <AppProviders>
            {renderStrategyResearchBootstrap({
              page: input.page,
              location,
              ...(input.researchEnabled === undefined ? {} : { researchEnabled: input.researchEnabled }),
              ...(input.legacyEnabled === undefined ? {} : { legacyEnabled: input.legacyEnabled }),
            })}
          </AppProviders>
        </Suspense>
      </ChartErrorBoundary>
    </StrictMode>,
  );
}
