import type { ReactNode, Ref } from "react";

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
  currentChartEnabled,
  onOpenLibrary,
  onSelectCurrentChart,
  pageExportRef,
  controls,
  runtimeMode,
  intervalSelector,
  toolbar,
  exportOverlay,
  drawer,
  chart,
  analysis,
  script,
  result,
  extraSurfaces,
}: {
  visualState: StrategyResearchVisualState;
  source: ResearchSourceRefV1 | null;
  libraryEnabled: boolean;
  libraryOpen: boolean;
  currentChartEnabled: boolean;
  onOpenLibrary(): void;
  onSelectCurrentChart(): void;
  pageExportRef: Ref<HTMLDivElement>;
  controls: ReactNode;
  runtimeMode: "LIVE" | "LOCAL_OFFLINE";
  intervalSelector: ReactNode;
  toolbar: ReactNode;
  exportOverlay: ReactNode;
  drawer: ReactNode;
  chart: ReactNode;
  analysis: ReactNode;
  script: ReactNode;
  result: ReactNode;
  extraSurfaces: ReactNode;
}) {
  return (
    <div
      className="strategy-research-shell"
      data-testid="strategy-research-shell"
      data-visual-state={visualState}
      data-runtime-mode={runtimeMode}
    >
      <MarketPageFrame
        rootRef={pageExportRef}
        topBar={(
          <MarketTopBarFrame
            source="research"
            brandText={t("strategy.brand")}
            identity={(
              <ResearchDataSourceBar
                source={source}
                libraryEnabled={libraryEnabled}
                currentChartEnabled={currentChartEnabled}
                onOpenLibrary={onOpenLibrary}
                onSelectCurrentChart={onSelectCurrentChart}
              />
            )}
            controls={controls}
          />
        )}
        intervalSelector={intervalSelector}
        workspace={(
          <MarketWorkspaceFrame
            toolbar={toolbar}
            exportOverlay={exportOverlay}
            chart={(
              <section
                className={`strategy-research-chart-slot${source?.kind === "IMPORTED_DATASET" ? " strategy-research-chart-slot--live" : ""}`}
                data-testid="strategy-research-chart-slot"
              >
                {chart}
              </section>
            )}
            bottomPanel={(
              <section className="strategy-research-result-slot" data-testid="strategy-research-result-slot">
                {result}
              </section>
            )}
            rightRail={(
              <>
                {analysis}
                <div className="strategy-research-script" data-testid="strategy-research-script-slot">
                  {script}
                </div>
              </>
            )}
          />
        )}
        featureSurfaces={(
          <>
            {libraryOpen ? drawer : null}
            {extraSurfaces}
          </>
        )}
        statusBar={(
          <footer className="status-bar" data-testid="strategy-research-status">
            {t("strategy.status", { state: visualState })}
          </footer>
        )}
      />
    </div>
  );
}
