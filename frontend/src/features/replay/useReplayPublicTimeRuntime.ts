import { useEffect, useMemo, useState } from "react";

import { createReplayPublicTimeFormatter } from "./replayPublicTimeModel.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import type { ReplayV2TimeDisclosurePolicy } from "./replayV2Types.js";

const BATCH_SIZE = 2_000;
const MAX_TIMELINE_VALUES = 20_000;

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

function boundedTimeline(values: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (Number.isSafeInteger(value) && value >= 0) unique.add(value);
    if (unique.size >= MAX_TIMELINE_VALUES) break;
  }
  return [...unique].sort((left, right) => left - right);
}

export function useReplayPublicTimeRuntime({
  runId,
  policy,
  originMs,
  timelineOriginMs,
  timelineMs,
}: ReplayPublicTimeRuntimeOptions): ReplayPublicTimeRuntime {
  const bounded = useMemo(() => boundedTimeline(timelineMs), [timelineMs]);
  const timelineKey = bounded.join(",");
  const [labels, setLabels] = useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabels(new Map());
    setError(null);
    const needsServerProjection = policy !== "NONE"
      || (originMs !== null && timelineOriginMs !== null && originMs !== timelineOriginMs);
    if (runId === null || !needsServerProjection || bounded.length === 0) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    const batches: number[][] = [];
    for (let index = 0; index < bounded.length; index += BATCH_SIZE) {
      batches.push(bounded.slice(index, index + BATCH_SIZE));
    }
    void Promise.all(
      batches.map((batch) => defaultReplayV2Api.publicTimesRun(
        runId,
        batch,
        abort.signal,
      )),
    ).then((responses) => {
      if (abort.signal.aborted) return;
      const next = new Map<number, string>();
      for (const response of responses) {
        if (response.policy !== policy) {
          throw new TypeError("public-time policy changed during projection");
        }
        for (const item of response.items) {
          next.set(item.input_timeline_ms, item.public_time.label);
        }
      }
      setLabels(next);
      setError(null);
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      // Missing projections never fall back to calendar reconstruction.
      setLabels(new Map());
      setError(cause instanceof Error ? cause.message : "公开时间投影失败");
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  // timelineKey is the stable, bounded request identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originMs, policy, runId, timelineKey, timelineOriginMs]);

  const formatTime = useMemo(() => createReplayPublicTimeFormatter({
    policy,
    originMs,
    timelineOriginMs,
    labels,
  }), [labels, originMs, policy, timelineOriginMs]);

  return {
    formatTime,
    projectedCount: labels.size,
    loading,
    error,
  };
}
