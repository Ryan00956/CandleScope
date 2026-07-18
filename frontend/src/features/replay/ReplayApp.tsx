import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ReplayEntry } from "./replayEntry.js";
import ReplayPageShell from "./ReplayPageShell.js";
import { useReplayRuntime } from "./useReplayRuntime.js";

export interface ReplayAppProps {
  entry: ReplayEntry;
}

/** Dedicated replay composition root. Keep this hook list fixed and replay-only. */
export default function ReplayApp({ entry }: ReplayAppProps) {
  const replay = useReplayRuntime(entry);
  const chartSurface = useChartSurfaceRuntime();
  return <ReplayPageShell runtime={replay} chartSurfaceRef={chartSurface.ref} />;
}
