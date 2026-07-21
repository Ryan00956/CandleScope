import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ReplayEntry } from "./replayEntry.js";
import TrainingHubDialog from "./components/TrainingHubDialog.js";
import ReplayPageShell from "./ReplayPageShell.js";
import { resolveReplayProduct } from "./replayProduct.js";
import { REPLAY_PRODUCT_V2_ENABLED } from "./replayV2Types.js";
import { useReplayIndicatorRuntime } from "./useReplayIndicatorRuntime.js";
import { useReplayRuntime } from "./useReplayRuntime.js";
import { useTrainingHub } from "./useTrainingHub.js";

export interface ReplayAppProps {
  entry: ReplayEntry;
}

function ReplayV1App({ entry }: ReplayAppProps) {
  const replay = useReplayRuntime(entry);
  const indicators = useReplayIndicatorRuntime(replay);
  const chartSurface = useChartSurfaceRuntime();
  return <ReplayPageShell runtime={replay} indicators={indicators} chartSurfaceRef={chartSurface.ref} />;
}

function ReplayTrainingHubApp() {
  const runtime = useTrainingHub();
  return <TrainingHubDialog runtime={runtime} />;
}

/** Dedicated replay composition root. Both products remain replay-only. */
export default function ReplayApp({ entry }: ReplayAppProps) {
  return resolveReplayProduct(REPLAY_PRODUCT_V2_ENABLED, entry) === "hub"
    ? <ReplayTrainingHubApp />
    : <ReplayV1App entry={entry} />;
}
