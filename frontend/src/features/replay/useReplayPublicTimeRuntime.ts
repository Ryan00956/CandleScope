import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createReplayPublicTimeFormatter } from "./replayPublicTimeModel.js";
import {
  ReplayPublicTimeProjectionController,
} from "./replayPublicTimeProjection.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import type { ReplayV2TimeDisclosurePolicy } from "./replayV2Types.js";

export interface ReplayPublicTimeRuntimeOptions {
  readonly runId: string | null;
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly originMs: number | null;
  readonly timelineOriginMs: number | null;
  readonly timelineMs: readonly number[];
}

export interface ReplayPublicTimeRuntime {
  readonly formatTime: (valueMs: number) => string;
  readonly projectedCount: number;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useReplayPublicTimeRuntime({
  runId,
  policy,
  originMs,
  timelineOriginMs,
  timelineMs,
}: ReplayPublicTimeRuntimeOptions): ReplayPublicTimeRuntime {
  const [controller] = useState(
    () => new ReplayPublicTimeProjectionController(defaultReplayV2Api),
  );
  const projection = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.update({
      runId,
      policy,
      originMs,
      timelineOriginMs,
      timelineMs,
    });
  });

  useEffect(() => () => controller.cancel(), [controller]);

  const formatTime = useMemo(() => createReplayPublicTimeFormatter({
    policy,
    originMs,
    timelineOriginMs,
    labels: projection.labels,
  }), [originMs, policy, projection.labels, timelineOriginMs]);

  return {
    formatTime,
    projectedCount: projection.labels.size,
    loading: projection.loading,
    error: projection.error,
  };
}
