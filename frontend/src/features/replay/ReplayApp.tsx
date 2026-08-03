import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ReplayEntry } from "./replayEntry.js";
import TrainingHubDialog from "./components/TrainingHubDialog.js";
import ReplayTrainingPageShell from "./ReplayTrainingPageShell.js";
import { useReplaySharedIndicatorRuntime } from "./useReplaySharedIndicatorRuntime.js";
import { useReplayRuntime } from "./useReplayRuntime.js";
import { useReplayViewerRuntime } from "./useReplayViewerRuntime.js";
import { useTrainingHub } from "./useTrainingHub.js";

export interface ReplayAppProps {
  entry: ReplayEntry;
}

function ReplayTrainingHubApp() {
  const runtime = useTrainingHub();
  return <TrainingHubDialog runtime={runtime} />;
}

function ReplayTrainingWorkspaceSurface({
  indicatorScope,
  replay,
  viewer,
}: {
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
      runtime={replay}
      indicators={indicators}
      chartSurfaceRef={chartSurface.ref}
      chartSurfaceActions={chartSurface.actions}
      viewer={viewer}
    />
  );
}

function ReplayTrainingWorkspaceApp({ entry }: ReplayAppProps) {
  const replay = useReplayRuntime(entry);
  const viewer = useReplayViewerRuntime(replay);
  const indicatorScope = viewer.viewerState?.run_id
    ?? `session:${entry.kind === "session" ? entry.sessionId : "unavailable"}`;
  return (
    <ReplayTrainingWorkspaceSurface
      key={indicatorScope}
      indicatorScope={indicatorScope}
      replay={replay}
      viewer={viewer}
    />
  );
}

/** Dedicated v2 replay composition root. */
export default function ReplayApp({ entry }: ReplayAppProps) {
  if (entry.kind === "configure") {
    return <ReplayTrainingHubApp />;
  }
  if (entry.kind === "session") {
    return <ReplayTrainingWorkspaceApp entry={entry} />;
  }
  return <ReplayTrainingWorkspaceApp entry={entry} />;
}
