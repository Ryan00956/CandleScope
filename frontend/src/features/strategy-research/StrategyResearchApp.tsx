import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";

import type { MainSeriesCrosshairValue } from "../../chart-adapter/chartAdapterTypes.js";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import { ResearchDataDrawer } from "../research-data/ResearchDataDrawer.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "../research-data/researchDataFlags.js";
import type { ResearchSourceKind } from "../research-data/researchDataTypes.js";
import { useResearchDataLibrary } from "../research-data/useResearchDataLibrary.js";
import {
  EMPTY_LOCAL_ANALYSIS_SNAPSHOT,
  LocalAnalysisEventStore,
} from "../local-data/localAnalysisStore.js";
import type {
  LocalAnalysisEvent,
  LocalAnalysisFocusRequest,
} from "../local-data/localAnalysisTypes.js";
import type { LocalDatasetManifest } from "../local-data/localDataTypes.js";
import { useLocalIntervalSelection } from "../local-data/useLocalIntervalSelection.js";
import SettingsModal from "../settings/SettingsModal.js";
import { useChartSettingsRuntime } from "../settings/chartAppearanceSettings.js";
import {
  EmptyImportedChart,
  ImportedAnalysisPanel,
  ImportedDatasetIntervalStrip,
  StrategyResearchImportedWorkspace,
} from "./StrategyResearchChart.js";
import { importedDatasetSourceFromManifest } from "./importedDatasetSource.js";
import { StrategyResearchRuntime } from "./StrategyResearchRuntime.js";
import { StrategyResearchResultPanel } from "./StrategyResearchResultPanel.js";
import { StrategyResearchScriptPanel } from "./StrategyResearchScriptPanel.js";
import { StrategyResearchShell } from "./StrategyResearchShell.js";
import { useStrategyResearchRun } from "./useStrategyResearchRun.js";
import {
  parseStrategyResearchLaunch,
  strategyResearchLaunchActions,
  strategyResearchVisualState,
  type StrategyResearchLaunchIntent,
} from "./strategyResearchLaunch.js";
import type { StrategyResearchState } from "./strategyResearchState.js";

class StrategyResearchDrawerBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Strategy research data drawer failed", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function currentChartSource() {
  return {
    schemaVersion: "candlescope.research-source/1" as const,
    kind: "CURRENT_CHART" as const,
    workspaceId: "current",
    cellId: "current",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };
}

function dispatchImportedSource(
  dispatch: (action: Parameters<StrategyResearchRuntime["dispatch"]>[0]) => void,
  current: StrategyResearchState["source"]["source"],
  manifest: LocalDatasetManifest,
): void {
  const next = importedDatasetSourceFromManifest(manifest);
  if (
    current?.kind === "IMPORTED_DATASET"
    && current.datasetId === next.datasetId
    && current.dataEpoch === next.dataEpoch
  ) {
    return;
  }
  if (current?.kind === "IMPORTED_DATASET" && current.datasetId === next.datasetId) {
    dispatch({ type: "source/revisionChanged", source: next });
    return;
  }
  dispatch({ type: "source/select", source: next });
}

export default function StrategyResearchApp({
  intent,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
}: {
  intent: StrategyResearchLaunchIntent;
  libraryEnabled?: boolean;
}) {
  useLocale();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();
  const library = useResearchDataLibrary();
  const runtimeRef = useRef<StrategyResearchRuntime | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = new StrategyResearchRuntime({
      libraryEnabled,
      restoreWorkspace: intent.kind === "restore",
    });
    for (const action of strategyResearchLaunchActions(intent)) {
      runtimeRef.current.dispatch(action);
    }
  }
  const runtime = runtimeRef.current;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const state: StrategyResearchState = runtime.state;
  const visualState = strategyResearchVisualState(intent, state);
  const dispatch = useCallback((action: Parameters<StrategyResearchRuntime["dispatch"]>[0]) => {
    runtime.dispatch(action);
    bump();
  }, [runtime]);

  const launchImported = intent.kind === "imported" || intent.kind === "import";
  const source = state.source.source;

  useEffect(() => {
    if (library.loadingLibrary) return;
    if (source?.kind !== "IMPORTED_DATASET") return;
    if (library.selectedId === source.datasetId) return;
    if (library.datasets.some((dataset) => dataset.dataset_id === source.datasetId)) {
      library.setSelectedId(source.datasetId);
    }
  }, [library.datasets, library.loadingLibrary, library.selectedId, library.setSelectedId, source]);

  useEffect(() => {
    const selected = library.selected;
    if (selected === null) return;
    if (source?.kind !== "IMPORTED_DATASET" && !launchImported) return;
    dispatchImportedSource(dispatch, source, selected);
  }, [dispatch, launchImported, library.selected, source]);

  const onSelectKind = useCallback((kind: ResearchSourceKind) => {
    if (kind === "CURRENT_CHART") {
      dispatch({ type: "source/select", source: currentChartSource() });
      return;
    }
    dispatch({ type: "source/libraryOpen", open: true });
    if (kind === "IMPORTED_DATASET" && library.selected !== null) {
      dispatchImportedSource(dispatch, runtime.state.source.source, library.selected);
    }
  }, [dispatch, library.selected, runtime]);

  const onSelectDataset = useCallback((datasetId: string) => {
    const dataset = library.datasets.find((entry) => entry.dataset_id === datasetId);
    if (dataset === undefined) return;
    dispatchImportedSource(dispatch, runtime.state.source.source, dataset);
  }, [dispatch, library.datasets, runtime]);

  const importedManifest = source?.kind === "IMPORTED_DATASET"
    && library.selected !== null
    && library.selected.dataset_id === source.datasetId
    ? library.selected
    : null;

  const { intervalScope, selectedInterval, handleIntervalSelect } = useLocalIntervalSelection(
    importedManifest,
    (message) => library.setError(message),
  );

  const analysisStore = useMemo(() => importedManifest === null ? null : new LocalAnalysisEventStore({
    datasetId: importedManifest.dataset_id,
    dataEpoch: importedManifest.data_epoch,
  }), [importedManifest]);
  const subscribeAnalysis = useCallback((listener: () => void) => (
    analysisStore?.subscribe(listener) ?? (() => undefined)
  ), [analysisStore]);
  const getAnalysisSnapshot = useCallback(() => (
    analysisStore?.getSnapshot() ?? EMPTY_LOCAL_ANALYSIS_SNAPSHOT
  ), [analysisStore]);
  const analysisSnapshot = useSyncExternalStore(
    subscribeAnalysis,
    getAnalysisSnapshot,
    () => EMPTY_LOCAL_ANALYSIS_SNAPSHOT,
  );

  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [activeIndicatorCount, setActiveIndicatorCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastCrosshair, setLastCrosshair] = useState<MainSeriesCrosshairValue | null>(null);
  const [focusRequest, setFocusRequest] = useState<LocalAnalysisFocusRequest | null>(null);

  useEffect(() => {
    setLastCrosshair(null);
    setFocusRequest(null);
    setIndicatorPanelOpen(false);
    setActiveIndicatorCount(0);
  }, [importedManifest?.data_epoch, importedManifest?.dataset_id]);

  useEffect(() => {
    setLastCrosshair(null);
    setFocusRequest(null);
  }, [selectedInterval]);

  const focusAnalysisEvent = useCallback((event: LocalAnalysisEvent) => {
    setFocusRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      time: event.time,
    }));
  }, []);

  const capabilities = useMemo(
    () => (source ? runtime.capabilitiesFor(source.kind) : runtime.capabilitiesFor("IMPORTED_DATASET")),
    [runtime, source],
  );

  const scriptDraft = state.script.draftId;
  const analysisEvents = importedManifest === null ? [] : analysisSnapshot.events;
  const researchRun = useStrategyResearchRun({
    source,
    imported: importedManifest,
    interval: selectedInterval,
    onRunId: (runId) => dispatch({ type: "result/setRun", runId }),
  });

  const drawer = (
    <StrategyResearchDrawerBoundary
      fallback={<p className="strategy-research-error" role="alert">{t("strategy.drawerFailed")}</p>}
    >
      <ResearchDataDrawer
        open={state.source.libraryOpen}
        runtimeMode={runtime.runtimeMode}
        capabilities={capabilities}
        libraryEnabled={runtime.libraryEnabled}
        library={library}
        settings={settings}
        events={analysisEvents}
        onSelectKind={onSelectKind}
        onSelectDataset={onSelectDataset}
        onClose={() => dispatch({ type: "source/libraryOpen", open: false })}
      />
    </StrategyResearchDrawerBoundary>
  );

  const script = (
    <div data-strategy-draft={scriptDraft ?? ""}>
      <StrategyResearchScriptPanel
        cellScope="strategy-research"
        session={researchRun.session}
        sourceKind={source?.kind ?? null}
        barOnly={researchRun.barOnly}
        runStatus={researchRun.runStatus}
        needsData={researchRun.needsData}
        onDraftId={(draftId) => dispatch({ type: "script/setDraft", draftId })}
        onRun={researchRun.onRun}
        onConfirmNeedsData={researchRun.onConfirmNeedsData}
      />
    </div>
  );
  const result = (
    <StrategyResearchResultPanel
      result={researchRun.result}
      stale={researchRun.stale || state.result.stale}
      staleReasons={researchRun.staleReasons}
      barOnly={researchRun.barOnly}
      error={researchRun.error}
      runStatus={researchRun.runStatus}
    />
  );
  const controls = (
    <>
      <button
        type="button"
        className="settings-btn"
        onClick={() => setSettingsOpen(true)}
        title={t("shell.settings")}
        aria-label={t("shell.settings")}
      >
        ⚙️
      </button>
      <button
        type="button"
        className={`indicator-toggle-btn ${indicatorPanelOpen ? "active" : ""}`}
        disabled={importedManifest === null}
        onClick={() => setIndicatorPanelOpen((open) => !open)}
        title={t("shell.indicators")}
      >
        📊
        {activeIndicatorCount > 0 && (
          <span className="indicator-badge">{activeIndicatorCount}</span>
        )}
      </button>
    </>
  );
  const extraSurfaces = (
    <>
      {library.error !== null && (
        <div className="local-global-error" role="alert">
          <span>{library.error}</span>
          <button type="button" onClick={() => library.setError(null)}>{t("backtest.close")}</button>
        </div>
      )}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={setSettings}
        currentSymbol={importedManifest?.symbol ?? ""}
        currentMarketType={importedManifest?.dataset_id ?? "local"}
        currentExchange="local"
        allowedCategories={["appearance", "about"]}
        backendFeaturesEnabled={false}
        dataWorkbenchEnabled={false}
      />
    </>
  );

  const shellShared = {
    visualState,
    source,
    libraryEnabled: runtime.libraryEnabled,
    libraryOpen: state.source.libraryOpen,
    onOpenLibrary: () => dispatch({ type: "source/libraryOpen", open: true }),
    pageExportRef,
    controls,
    drawer,
    script,
    result,
    extraSurfaces,
  };

  if (importedManifest !== null && analysisStore !== null && selectedInterval !== null) {
    const analysis = (
      <ImportedAnalysisPanel
        manifest={importedManifest}
        snapshot={analysisSnapshot}
        eventStore={analysisStore}
        crosshair={lastCrosshair}
        onFocus={focusAnalysisEvent}
        onError={library.setError}
      />
    );
    return (
      <StrategyResearchImportedWorkspace
        key={importedManifest.data_epoch}
        manifest={importedManifest}
        interval={selectedInterval}
        indicatorPresets={library.indicatorPresets}
        eventStore={analysisStore}
        focusRequest={focusRequest}
        indicatorPanelOpen={indicatorPanelOpen}
        onCloseIndicatorPanel={() => setIndicatorPanelOpen(false)}
        onCrosshairMove={(value) => {
          if (value !== null) setLastCrosshair(value);
        }}
        onActiveIndicatorCountChange={setActiveIndicatorCount}
        pageExportRef={pageExportRef}
        settings={settings}
        onSettingsChange={setSettings}
        resolvedTheme={resolvedTheme}
      >
        {({ toolbar, exportOverlay, chart, indicatorPanel }) => (
          <StrategyResearchShell
            {...shellShared}
            intervalSelector={(
              <ImportedDatasetIntervalStrip
                manifest={importedManifest}
                interval={selectedInterval}
                intervalScope={intervalScope}
                onSelect={handleIntervalSelect}
              />
            )}
            toolbar={toolbar}
            exportOverlay={exportOverlay}
            chart={chart}
            analysis={analysis}
            extraSurfaces={(
              <>
                {extraSurfaces}
                {indicatorPanel}
              </>
            )}
          />
        )}
      </StrategyResearchImportedWorkspace>
    );
  }

  return (
    <StrategyResearchShell
      {...shellShared}
      intervalSelector={null}
      toolbar={null}
      exportOverlay={null}
      chart={source?.kind === "CURRENT_CHART" ? <p>{t("strategy.chartSlot")}</p> : <EmptyImportedChart />}
      analysis={null}
    />
  );
}

export { parseStrategyResearchLaunch };
