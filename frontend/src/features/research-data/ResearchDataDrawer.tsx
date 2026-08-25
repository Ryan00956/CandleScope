import { t } from "../../i18n/index.js";
import { ordinarySourceLabel, isCapabilityAvailable } from "./researchDataSourceModel.js";
import type { ResearchCapabilitySummaryV1, ResearchRuntimeMode, ResearchSourceKind } from "./researchDataTypes.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "./researchDataFlags.js";
import { ResearchDatasetRail } from "./ResearchDatasetRail.js";
import { ResearchDatasetManagement } from "./ResearchDatasetManagement.js";
import { useResearchDataLibrary } from "./useResearchDataLibrary.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { LocalAnalysisEvent } from "../local-data/localAnalysisTypes.js";

export function ResearchDataDrawer(props: {
  open: boolean;
  runtimeMode: ResearchRuntimeMode;
  capabilities: ResearchCapabilitySummaryV1 | null;
  libraryEnabled?: boolean;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  onSelectKind(kind: ResearchSourceKind): void;
  onClose(): void;
}) {
  if (!props.open) return null;
  return <ResearchDataDrawerBody {...props} />;
}

function ResearchDataDrawerBody({
  runtimeMode,
  capabilities,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
  settings,
  events,
  onSelectKind,
  onClose,
}: {
  open: boolean;
  runtimeMode: ResearchRuntimeMode;
  capabilities: ResearchCapabilitySummaryV1 | null;
  libraryEnabled?: boolean;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  onSelectKind(kind: ResearchSourceKind): void;
  onClose(): void;
}) {
  const library = useResearchDataLibrary();
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
          const runnable = kind !== "CURRENT_CHART" || runtimeMode !== "LOCAL_OFFLINE";
          const reason = !runnable
            ? t("research.source.offlineLiveUnavailable")
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
      {libraryEnabled ? (
        <ResearchDatasetRail
          datasets={library.datasets}
          selectedId={library.selectedId}
          importing={library.importing}
          importJob={library.importJob}
          uploadProgress={library.uploadProgress}
          onSelect={library.setSelectedId}
          onImport={library.handleImport}
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
          analysis={null}
        />
      ) : null}
    </aside>
  );
}
