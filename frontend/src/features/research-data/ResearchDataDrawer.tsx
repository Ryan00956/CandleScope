import type { ReactNode } from "react";

import { t } from "../../i18n/index.js";
import { ordinarySourceLabel, isCapabilityAvailable } from "./researchDataSourceModel.js";
import type { ResearchCapabilitySummaryV1, ResearchRuntimeMode, ResearchSourceKind } from "./researchDataTypes.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "./researchDataFlags.js";
import { ResearchDatasetRail } from "./ResearchDatasetRail.js";
import { ResearchDatasetManagement } from "./ResearchDatasetManagement.js";
import type { ResearchDataLibraryController, ResearchImportSubmitInput } from "./useResearchDataLibrary.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { LocalAnalysisEvent } from "../local-data/localAnalysisTypes.js";

export function ResearchDataDrawer(props: {
  open: boolean;
  runtimeMode: ResearchRuntimeMode;
  capabilities: ResearchCapabilitySummaryV1 | null;
  libraryEnabled?: boolean;
  currentChartEnabled?: boolean;
  library?: ResearchDataLibraryController;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  analysis?: ReactNode;
  onSelectKind(kind: ResearchSourceKind): void;
  onSelectDataset?(datasetId: string): void;
  onImport?(input: ResearchImportSubmitInput): Promise<unknown>;
  onClose(): void;
}) {
  if (!props.open) return null;
  return <ResearchDataDrawerBody {...props} />;
}

function ResearchDataDrawerBody({
  runtimeMode,
  capabilities,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
  currentChartEnabled = false,
  library,
  settings,
  events,
  analysis = null,
  onSelectKind,
  onSelectDataset,
  onImport,
  onClose,
}: {
  open: boolean;
  runtimeMode: ResearchRuntimeMode;
  capabilities: ResearchCapabilitySummaryV1 | null;
  libraryEnabled?: boolean;
  currentChartEnabled?: boolean;
  library?: ResearchDataLibraryController;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  analysis?: ReactNode;
  onSelectKind(kind: ResearchSourceKind): void;
  onSelectDataset?(datasetId: string): void;
  onImport?(input: ResearchImportSubmitInput): Promise<unknown>;
  onClose(): void;
}) {
  const kinds: ResearchSourceKind[] = ["CURRENT_CHART", "IMPORTED_DATASET", "COMPLETED_RUN"];
  return (
    <aside className="research-data-drawer" data-testid="research-data-drawer">
      <header>
        <strong>{t("research.drawer.title")}</strong>
        <button type="button" onClick={onClose}>{t("backtest.close")}</button>
      </header>
      <div className="research-source-cards">
        {kinds.map((kind) => {
          const hideImport = kind === "IMPORTED_DATASET" && !libraryEnabled;
          if (hideImport) return null;
          const runnable = kind !== "CURRENT_CHART" || currentChartEnabled;
          const reason = kind === "CURRENT_CHART" && !runnable
            ? runtimeMode === "LOCAL_OFFLINE"
              ? t("research.source.offlineLiveUnavailable")
              : t("strategy.currentChartUnbound")
            : capabilities && !isCapabilityAvailable(capabilities, "barApprox") && kind === capabilities.sourceKind
              ? t("research.source.liveOffline")
              : null;
          return (
            <button
              key={kind}
              type="button"
              disabled={kind === "CURRENT_CHART" && !runnable}
              onClick={() => onSelectKind(kind)}
              data-testid={`research-source-card-${kind}`}
            >
              <strong>{ordinarySourceLabel(kind)}</strong>
              {reason ? <small>{reason}</small> : null}
            </button>
          );
        })}
      </div>
      {libraryEnabled && library ? (
        <ResearchDatasetRail
          datasets={library.datasets}
          selectedId={library.selectedId}
          importing={library.importing}
          importJob={library.importJob}
          uploadProgress={library.uploadProgress}
          onSelect={(datasetId) => {
            library.setSelectedId(datasetId);
            onSelectDataset?.(datasetId);
          }}
          onImport={onImport ?? library.handleImport}
          onCancelImport={library.cancelImport}
          management={(
            <ResearchDatasetManagement
              manifest={library.selected}
              settings={settings}
              events={events}
              onChanged={library.refresh}
              onSettingsImported={() => undefined}
              onError={library.setError}
            />
          )}
          analysis={analysis}
        />
      ) : null}
    </aside>
  );
}
