import { useEffect, useMemo, useRef, useState } from "react";
import { useChartSurfaceRuntime } from "../../../chart-adapter/useChartSurfaceRuntime.js";
import IntervalSelector from "../../../components/IntervalSelector.js";
import MarketPageFrame from "../../../app/MarketPageFrame.js";
import MarketStatusBar from "../../../app/MarketStatusBar.js";
import MarketTopBarFrame from "../../../app/MarketTopBarFrame.js";
import MarketWorkspaceFrame from "../../../app/MarketWorkspaceFrame.js";
import { getLocale, t } from "../../../i18n/index.js";
import { useChartSession } from "../../chart-session/useChartSession.js";
import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import { useMarketDataRuntime } from "../../market-data/useMarketDataRuntime.js";
import MarketChartSurface from "../../market-chart-platform/MarketChartSurface.js";
import {
  createFrozenSnapshotSource,
  createRunResultSource,
  type MarketChartSourceRuntime,
} from "../../market-chart-platform/marketChartSourceRuntime.js";
import { useLiveReferenceMarketChartSource } from "../../market-chart-platform/useLiveReferenceMarketChartSource.js";
import { useChartSettingsRuntime } from "../../settings/chartAppearanceSettings.js";
import { createChartStrategyResultMarkerSource } from "../chart-tester/chartStrategyResultMarkerSource.js";
import {
  backtestResearchHasPanel,
  researchRunIdentityReady,
  shouldEnableBacktestResearchLiveSource,
} from "./backtestResearchModel.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchDataPanel from "./ResearchDataPanel.js";
import ResearchExecutionPanel from "./ResearchExecutionPanel.js";
import ResearchResultsPanel from "./ResearchResultsPanel.js";
import ResearchReplayPanel from "./ResearchReplayPanel.js";
import ResearchRunPanel from "./ResearchRunPanel.js";
import ResearchStrategyPanel from "./ResearchStrategyPanel.js";
import ResearchStudyPanel from "./ResearchStudyPanel.js";

function sourceLabel(mode: MarketChartSourceRuntime["mode"]): string {
  if (mode === "FROZEN_SNAPSHOT") return t("research.source.frozen");
  if (mode === "RUN_RESULT") return t("research.source.run");
  return t("research.source.live");
}

function dateLabel(value: number | null | undefined): string {
  return value == null ? "—" : new Date(value).toLocaleString(getLocale());
}

export default function ResearchMarketChart({ runtime }: { runtime: BacktestResearchRuntime }) {
  const task = runtime.view.selectedTask!;
  const liveSourceEnabled = shouldEnableBacktestResearchLiveSource(
    runtime.view.runtimeMode,
    runtime.view.sourceMode,
  );
  const [viewSession, setViewSession] = useState<ChartSession>(runtime.view.session);
  const chartSurface = useChartSurfaceRuntime();
  const chartSettings = useChartSettingsRuntime();
  const realtimePriceRef = useRef<number | null>(null);
  const chartSession = useChartSession({
    chartSurfaceActions: chartSurface.actions,
    exchangeCatalogEnabled: liveSourceEnabled,
    initialSession: viewSession,
    controlledSession: viewSession,
    onSessionChange: setViewSession,
    visibleRangeScope: "backtest-research-main",
  });
  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
    enabled: liveSourceEnabled,
    backgroundPrefetchEnabled: false,
    intervalPrefetchEnabled: false,
    schedulerCellId: "backtest-research-main",
    workspaceId: "backtest-research",
    windowId: "research-window",
  });
  const liveSession = useMemo<ChartSession>(() => ({
    exchange: chartSession.view.exchange,
    marketType: chartSession.view.marketType,
    symbol: chartSession.view.symbol,
    interval: chartSession.view.interval,
  }), [
    chartSession.view.exchange,
    chartSession.view.interval,
    chartSession.view.marketType,
    chartSession.view.symbol,
  ]);
  const liveSource = useLiveReferenceMarketChartSource({
    sourceId: "live:backtest-research:main",
    session: liveSession,
    datasetKey: chartSession.view.datasetKey,
    marketData,
    paused: runtime.view.sourceMode !== "LIVE_REFERENCE",
  });
  const runIdentityReady = researchRunIdentityReady({
    run: runtime.view.activeRun,
    report: runtime.view.report,
    chart: runtime.view.chart,
  });
  const datasetIdentity = useMemo(() => runtime.view.launchContext?.dataset_identity ?? (
    runtime.view.activeRun?.dataset_id
      && runtime.view.activeRun.data_epoch
      && runtime.view.activeRun.snapshot_hash
      ? {
          dataset_id: runtime.view.activeRun.dataset_id,
          data_epoch: runtime.view.activeRun.data_epoch,
          snapshot_hash: runtime.view.activeRun.snapshot_hash,
        }
      : null
  ), [runtime.view.activeRun, runtime.view.launchContext]);
  const staticSource = useMemo<MarketChartSourceRuntime | null>(() => {
    const run = runtime.view.activeRun;
    const report = runtime.view.report;
    const chart = runtime.view.chart;
    if (!run || !report || !chart) return null;
    if (runtime.view.sourceMode === "RUN_RESULT" && runIdentityReady) {
      return createRunResultSource({
        sourceId: `research-run:${run.run_id}`,
        session: runtime.view.session,
        runId: run.run_id,
        configHash: run.config_hash,
        reportHash: report.hashes.report!,
        chartHash: chart.chart_hash,
        bars: chart.bars.map((bar) => ({ ...bar })),
      });
    }
    if (runtime.view.sourceMode === "FROZEN_SNAPSHOT" && datasetIdentity) {
      return createFrozenSnapshotSource({
        sourceId: `research-snapshot:${datasetIdentity.snapshot_hash}`,
        session: runtime.view.session,
        datasetId: datasetIdentity.dataset_id,
        dataEpoch: datasetIdentity.data_epoch,
        snapshotHash: datasetIdentity.snapshot_hash,
        bars: chart.bars.map((bar) => ({ ...bar })),
      });
    }
    return null;
  }, [
    datasetIdentity,
    runIdentityReady,
    runtime.view.activeRun,
    runtime.view.chart,
    runtime.view.report,
    runtime.view.session,
    runtime.view.sourceMode,
  ]);
  useEffect(() => () => staticSource?.dispose(), [staticSource]);
  const activeSource = staticSource ?? liveSource;
  const liveUnavailable = runtime.view.runtimeMode === "LOCAL_OFFLINE"
    && runtime.view.sourceMode === "LIVE_REFERENCE";
  const markerSource = useMemo(() => {
    if (activeSource.mode !== "RUN_RESULT" || !runtime.view.chart) return null;
    const store = activeSource.marketData.view.seriesStore;
    if (!store) return null;
    const source = createChartStrategyResultMarkerSource({
      seriesStore: store,
      labels: {
        actions: {
          OPEN_LONG: t("backtest.openLong"), CLOSE_LONG: t("backtest.closeLong"),
          OPEN_SHORT: t("backtest.openShort"), CLOSE_SHORT: t("backtest.closeShort"),
          ADD_LONG: t("backtest.addLong"), ADD_SHORT: t("backtest.addShort"),
          REDUCE_LONG: t("backtest.reduceLong"), REDUCE_SHORT: t("backtest.reduceShort"),
          REVERSE_TO_LONG: t("backtest.reverseLong"), REVERSE_TO_SHORT: t("backtest.reverseShort"),
        },
        rejection: t("backtest.reject"),
      },
    });
    source.setResult(runtime.view.chart);
    return source;
  }, [activeSource, runtime.view.chart]);
  useEffect(() => () => markerSource?.dispose(), [markerSource]);

  const leftPanels = (
    <aside className="research-left-rail" aria-label={t("research.aria.setup")}>
      {backtestResearchHasPanel(task, "STRATEGY") && <ResearchStrategyPanel runtime={runtime} />}
      {backtestResearchHasPanel(task, "DATA") && <ResearchDataPanel runtime={runtime} />}
    </aside>
  );
  const rightPanels = (
    <aside className="research-right-rail" aria-label={t("research.aria.controls")}>
      {runtime.view.operationError && <p className="research-operation-message error" role="alert">{runtime.view.operationError}</p>}
      {runtime.view.notice && <p className="research-operation-message" role="status">{runtime.view.notice}</p>}
      {backtestResearchHasPanel(task, "EXECUTION") && <ResearchExecutionPanel runtime={runtime} />}
      {backtestResearchHasPanel(task, "RUN") && <ResearchRunPanel runtime={runtime} />}
      {backtestResearchHasPanel(task, "STUDY") && <ResearchStudyPanel runtime={runtime} />}
      {backtestResearchHasPanel(task, "REPLAY") && <ResearchReplayPanel runtime={runtime} />}
    </aside>
  );
  const range = runtime.view.launchContext?.range;
  const rangeText = range
    ? t("research.context.range", {
        mode: range.mode,
        start: dateLabel(range.start_time_ms),
        end: dateLabel(range.end_time_ms),
      })
    : t("research.context.noRange");
  const runModeDisabled = !runIdentityReady;
  const frozenDisabled = !runtime.view.chart || !datasetIdentity;

  return (
    <MarketPageFrame
      topBar={(
        <MarketTopBarFrame
          source="research"
          className="research-top-bar"
          navigation={(
            <button type="button" className="research-task-home-button" onClick={() => runtime.actions.selectTask(null)}>
              {t("research.task.home")}
            </button>
          )}
          identity={(
            <div className="research-market-identity">
              <strong>{chartSession.view.symbol}</strong>
              <span>{chartSession.view.exchange} · {chartSession.view.marketType} · {chartSession.view.interval}</span>
            </div>
          )}
          controls={(
            <div className="research-source-switch" role="group" aria-label={t("research.aria.chartSource")}>
              <button type="button" disabled={runtime.view.runtimeMode === "LOCAL_OFFLINE"} title={runtime.view.runtimeMode === "LOCAL_OFFLINE" ? t("research.source.liveOffline") : ""} data-active={runtime.view.sourceMode === "LIVE_REFERENCE"} onClick={() => runtime.actions.selectSourceMode("LIVE_REFERENCE")}>{t("research.source.live")}</button>
              <button type="button" disabled={frozenDisabled} title={frozenDisabled ? t("research.source.frozenUnavailable") : ""} data-active={runtime.view.sourceMode === "FROZEN_SNAPSHOT"} onClick={() => runtime.actions.selectSourceMode("FROZEN_SNAPSHOT")}>{t("research.source.frozen")}</button>
              <button type="button" disabled={runModeDisabled} title={runModeDisabled ? t("research.source.runUnavailable") : ""} data-active={runtime.view.sourceMode === "RUN_RESULT"} onClick={() => runtime.actions.selectSourceMode("RUN_RESULT")}>{t("research.source.run")}</button>
            </div>
          )}
          trailing={(
            <div className="research-top-actions">
              <span className="research-advanced-state" data-enabled={runtime.view.advancedEnabled}>
                {runtime.view.advancedEnabled ? t("research.advanced.on") : t("research.advanced.off")}
              </span>
              <button type="button" onClick={runtime.actions.refresh}>{t("research.refresh")}</button>
              <a href={runtime.view.returnHref}>{t("research.return")}</a>
            </div>
          )}
        />
      )}
      intervalSelector={(
        <IntervalSelector
          interval={chartSession.view.interval}
          capabilityReady={chartSession.status.exchangeCatalogStatus !== "loading" && chartSession.status.historyIntervalAvailable}
          capabilityLoading={chartSession.status.exchangeCatalogStatus === "loading"}
          nativeIntervals={chartSession.view.nativeIntervals}
          intervalGroups={chartSession.view.intervalGroups}
          customIntervalRecords={chartSession.view.customIntervalRecords}
          savedCustomIntervals={chartSession.view.savedCustomIntervals}
          onSelectInterval={chartSession.actions.selectInterval}
          onCreateCustomInterval={chartSession.actions.createCustomInterval}
          onRemoveCustomInterval={chartSession.actions.removeCustomInterval}
          onRestoreCustomInterval={chartSession.actions.restoreCustomInterval}
          onTogglePinCustomInterval={chartSession.actions.togglePinCustomInterval}
          onClearCustomIntervals={chartSession.actions.clearCustomIntervals}
          intervalNotice={chartSession.view.intervalNotice}
          readOnlyReason={activeSource.mode === "LIVE_REFERENCE" ? null : sourceLabel(activeSource.mode)}
        />
      )}
      workspace={(
        <MarketWorkspaceFrame
          toolbar={leftPanels}
          exportOverlay={null}
          chart={(
            <section
              className="research-chart-stage"
              data-market-chart-source-mode={activeSource.mode}
              data-market-chart-source-state={activeSource.lifecycle}
              data-research-task={task}
            >
              <div className="research-chart-context">
                <span data-source-mode={activeSource.mode}>{sourceLabel(activeSource.mode)}</span>
                <small>{rangeText}</small>
              </div>
              <MarketChartSurface
                source={activeSource}
                markerSources={[markerSource]}
                chartProps={{
                  ref: chartSurface.ref,
                  symbol: activeSource.session.symbol,
                  interval: activeSource.session.interval,
                  datasetKey: activeSource.datasetKey,
                  upColor: chartSettings.settings.upColor,
                  downColor: chartSettings.settings.downColor,
                  chartType: chartSettings.settings.chartType,
                  theme: chartSettings.resolvedTheme,
                  customBg: chartSettings.settings.customBg,
                  followLatest: activeSource.mode === "LIVE_REFERENCE",
                  canLoadMoreLeft: activeSource.marketData.status.canLoadMoreLeft,
                  onViewportRangeChange: (next) => markerSource?.setVisibleRange(next),
                }}
                paused={!liveSourceEnabled && activeSource.mode === "LIVE_REFERENCE"}
                error={liveUnavailable ? t("research.source.liveOffline") : activeSource.marketData.view.error}
                errorFallback={(
                  <div className={liveUnavailable ? "research-chart-offline" : "research-chart-error"}>
                    <strong>{liveUnavailable ? t("research.source.liveOfflineTitle") : t("research.source.unavailable")}</strong>
                    <span>{liveUnavailable ? t("research.source.liveOffline") : String(activeSource.marketData.view.error ?? "Chart unavailable")}</span>
                  </div>
                )}
              />
              {runtime.view.chart?.truncated && <span className="research-chart-warning">{t("backtest.chartTruncated")}</span>}
            </section>
          )}
          bottomPanel={backtestResearchHasPanel(task, "RESULTS")
            ? <ResearchResultsPanel runtime={runtime} />
            : null}
          rightRail={rightPanels}
        />
      )}
      featureSurfaces={null}
      statusBar={(
        <MarketStatusBar
          source="research"
          className="research-status-bar"
          connectionStatus={activeSource.marketData.view.connectionStatus}
          left={<><span>{t("research.status.isolated")}</span><span>{sourceLabel(activeSource.mode)}</span></>}
          right={<><span>{t("research.status.bars", { count: activeSource.marketData.status.barCount })}</span><span>{runtime.view.activeRun?.run_id ?? t("research.status.authority")}</span></>}
          dataAttributes={{
            "data-source-mode": activeSource.mode,
            "data-run-id": runtime.view.activeRun?.run_id ?? "none",
            "data-advanced-enabled": runtime.view.advancedEnabled ? "true" : "false",
          }}
        />
      )}
    />
  );
}
