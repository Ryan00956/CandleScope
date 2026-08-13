import { useEffect, useMemo, useState } from "react";
import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import {
  useChartSettingsRuntime,
  type ChartSettingsRuntime,
} from "../settings/chartAppearanceSettings.js";
import type { ReplayEntry } from "./replayEntry.js";
import type { TrainingRunCard } from "./replayV2Types.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import { getReplayControllerClientInstanceId } from "./replayControllerIdentity.js";
import ReplayInitialMarketPicker from "./components/ReplayInitialMarketPicker.js";
import TrainingHubDialog from "./components/TrainingHubDialog.js";
import ReplayTrainingPageShell from "./ReplayTrainingPageShell.js";
import { useReplaySharedIndicatorRuntime } from "./useReplaySharedIndicatorRuntime.js";
import { useReplayRuntime } from "./useReplayRuntime.js";
import { useReplayViewerRuntime } from "./useReplayViewerRuntime.js";
import { useTrainingHub } from "./useTrainingHub.js";

export { default as ReplayInitialMarketPicker } from "./components/ReplayInitialMarketPicker.js";

export interface ReplayAppProps {
  entry: ReplayEntry;
}

function ReplayTrainingHubApp() {
  const runtime = useTrainingHub();
  return <TrainingHubDialog runtime={runtime} />;
}

function ReplayStatusSurface({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry?: () => void;
}) {
  return (
    <main className="training-hub-page">
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div>
            <span className="training-hub-kicker">RUN-CENTRIC REPLAY</span>
            <h1>{title}</h1>
            <p>{message}</p>
          </div>
          <div className="training-hub-heading-actions">
            {retry !== undefined && <button type="button" onClick={retry}>重试</button>}
            <a href="/replay.html">返回训练大厅</a>
          </div>
        </header>
      </section>
    </main>
  );
}

function ReplayTrainingWorkspaceSurface({
  chartSettingsRuntime,
  indicatorScope,
  replay,
  viewer,
}: {
  chartSettingsRuntime: ChartSettingsRuntime;
  indicatorScope: string;
  replay: ReturnType<typeof useReplayRuntime>;
  viewer: ReturnType<typeof useReplayViewerRuntime>;
}) {
  const indicators = useReplaySharedIndicatorRuntime(
    replay,
    viewer,
    indicatorScope,
  );
  const chartSurface = useChartSurfaceRuntime();
  return (
    <ReplayTrainingPageShell
      key={indicatorScope}
      runtime={replay}
      indicators={indicators}
      chartSurfaceRef={chartSurface.ref}
      chartSurfaceActions={chartSurface.actions}
      viewer={viewer}
      chartSettingsRuntime={chartSettingsRuntime}
    />
  );
}

function ReplayInitializedRun({
  chartSettingsRuntime,
  onSelectedSessionChange,
  runId,
  sessionId,
}: {
  chartSettingsRuntime: ChartSettingsRuntime;
  onSelectedSessionChange: (sessionId: string) => void;
  runId: string;
  sessionId: string;
}) {
  const runtimeEntry = useMemo(
    () => ({ kind: "adapter" as const, sessionId }),
    [sessionId],
  );
  const clientInstanceId = useMemo(
    () => getReplayControllerClientInstanceId(runId),
    [runId],
  );
  const replay = useReplayRuntime(runtimeEntry, { clientInstanceId });
  const viewer = useReplayViewerRuntime(replay, { onSelectedSessionChange });
  return (
    <ReplayTrainingWorkspaceSurface
      key={`${runId}:${sessionId}`}
      chartSettingsRuntime={chartSettingsRuntime}
      indicatorScope={runId}
      replay={replay}
      viewer={viewer}
    />
  );
}

function ReplayTrainingRunApp({
  chartSettingsRuntime,
  runId,
}: {
  chartSettingsRuntime: ChartSettingsRuntime;
  runId: string;
}) {
  const [run, setRun] = useState<TrainingRunCard | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void defaultReplayV2Api.getRun(runId, controller.signal).then(({ run: loaded }) => {
      setRun(loaded);
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "回放 Run 读取失败");
    });
    return () => controller.abort();
  }, [attempt, runId]);

  if (error !== null) {
    return <ReplayStatusSurface title="无法打开回放" message={error} retry={() => {
      setRun(null);
      setError(null);
      setAttempt((value) => value + 1);
    }} />;
  }
  if (run === null) {
    return <ReplayStatusSurface title="正在打开回放" message={`正在解析 Run ${runId} 的当前商品与内部数据轨道…`} />;
  }
  if (run.state === "AWAITING_MARKET" || run.resume_action === "SELECT_MARKET") {
    return <ReplayInitialMarketPicker run={run} onInitialized={setRun} />;
  }
  if (run.adapter_session_id === null) {
    return <ReplayStatusSurface title="回放状态不完整" message="Run 已有时钟，但当前 Viewer 没有可用的 MarketTrack。" />;
  }
  return (
    <ReplayInitializedRun
      key={`${run.run_id}:${selectedSessionId ?? run.adapter_session_id}`}
      chartSettingsRuntime={chartSettingsRuntime}
      runId={run.run_id}
      sessionId={selectedSessionId ?? run.adapter_session_id}
      onSelectedSessionChange={setSelectedSessionId}
    />
  );
}

/** Run-centric replay composition root. */
export default function ReplayApp({ entry }: ReplayAppProps) {
  const chartSettingsRuntime = useChartSettingsRuntime();
  if (entry.kind === "configure") return <ReplayTrainingHubApp />;
  if (entry.kind === "run") {
    return (
      <ReplayTrainingRunApp
        key={entry.runId}
        chartSettingsRuntime={chartSettingsRuntime}
        runId={entry.runId}
      />
    );
  }
  return <ReplayStatusSurface title="回放地址无效" message={entry.message} />;
}
