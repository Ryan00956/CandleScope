import type { ReactNode } from "react";

import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketTopBarFrame from "../../app/MarketTopBarFrame.js";
import MarketWorkspaceFrame from "../../app/MarketWorkspaceFrame.js";
import { t } from "../../i18n/index.js";
import { ResearchDataSourceBar } from "../research-data/ResearchDataSourceBar.js";
import type { ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";
import type { StrategyResearchVisualState } from "./strategyResearchLaunch.js";

export function StrategyResearchShell({
  visualState,
  source,
  libraryEnabled,
  libraryOpen,
  onOpenLibrary,
  drawer,
  chart,
  script,
  result,
}: {
  visualState: StrategyResearchVisualState;
  source: ResearchSourceRefV1 | null;
  libraryEnabled: boolean;
  libraryOpen: boolean;
  onOpenLibrary(): void;
  drawer: ReactNode;
  chart: ReactNode;
  script: ReactNode;
  result: ReactNode;
}) {
  return (
    <div className="strategy-research-shell" data-testid="strategy-research-shell" data-visual-state={visualState}>
      <MarketPageFrame
        topBar={(
          <MarketTopBarFrame
            source="research"
            brandText={t("strategy.brand")}
            identity={(
              <ResearchDataSourceBar
                source={source}
                libraryEnabled={libraryEnabled}
                onOpenLibrary={onOpenLibrary}
              />
            )}
          />
        )}
        intervalSelector={null}
        workspace={(
          <MarketWorkspaceFrame
            toolbar={null}
            exportOverlay={null}
            chart={(
              <section className="strategy-research-chart-slot" data-testid="strategy-research-chart-slot">
                {chart}
              </section>
            )}
            bottomPanel={(
              <section className="strategy-research-result-slot" data-testid="strategy-research-result-slot">
                {result}
              </section>
            )}
            rightRail={(
              <div className="strategy-research-script" data-testid="strategy-research-script-slot">
                {script}
              </div>
            )}
          />
        )}
        featureSurfaces={<>{libraryOpen ? drawer : null}</>}
        statusBar={(
          <footer className="status-bar" data-testid="strategy-research-status">
            {t("strategy.status", { state: visualState })}
          </footer>
        )}
      />
    </div>
  );
}
