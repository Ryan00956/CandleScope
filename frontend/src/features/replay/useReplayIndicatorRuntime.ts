import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { IndicatorLine } from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";

export interface ReplayIndicatorRuntime {
  readonly mainOverlayLines: readonly IndicatorLine[];
  readonly status: {
    readonly mode: "local_revealed_only";
    readonly sourceBarCount: number;
    readonly latestSourceTimeMs: number | null;
    readonly disabledCapabilities: readonly ["hosted", "range", "security"];
  };
}

export function buildReplaySmaLine(
  rows: readonly KlineBar[],
  cursorMs: number | null,
  period = 20,
): IndicatorLine {
  const revealed = cursorMs === null
    ? []
    : rows.filter((row) => Number(row.time) * 1_000 <= cursorMs && typeof row.close === "number");
  const data: { time: number; value: number }[] = [];
  let sum = 0;
  const window: number[] = [];
  for (const row of revealed) {
    const close = row.close as number;
    window.push(close);
    sum += close;
    if (window.length > period) sum -= window.shift() ?? 0;
    if (window.length === period) data.push({ time: Number(row.time), value: sum / period });
  }
  return {
    id: `replay-local-sma-${period}`,
    indicatorId: `replay-local-sma-${period}`,
    outputName: `SMA ${period}`,
    name: `SMA ${period} · revealed only`,
    color: "#f59e0b",
    lineWidth: 2,
    type: "line",
    overlay: true,
    pane: "main",
    data,
  };
}

export function useReplayIndicatorRuntime(
  runtime: ReplayRuntime,
  projectedSeriesStore?: SeriesWindowStore,
): ReplayIndicatorRuntime {
  const storeSnapshot = runtime.store;
  const seriesStore = projectedSeriesStore ?? runtime.replayStore.seriesStore;
  const subscribeSeries = useCallback((listener: () => void) => {
    const unsubscribe = seriesStore.subscribe(listener);
    return () => { unsubscribe(); };
  }, [seriesStore]);
  const getSeriesRevision = useCallback(() => Number(seriesStore.version), [seriesStore]);
  const seriesRevision = useSyncExternalStore(
    subscribeSeries,
    getSeriesRevision,
    getSeriesRevision,
  );
  return useMemo(() => {
    // Reading the external-store revision is the invalidation boundary for
    // the ref-backed SeriesWindowStore snapshot below.
    void seriesRevision;
    const cursorMs = storeSnapshot.virtualTimeMs;
    const rows = seriesStore.snapshot();
    const line = buildReplaySmaLine(rows, cursorMs);
    const sourceTimes = rows
      .map((row) => Number(row.time) * 1_000)
      .filter((timeMs) => cursorMs !== null && timeMs <= cursorMs);
    return {
      mainOverlayLines: [line],
      status: {
        mode: "local_revealed_only",
        sourceBarCount: sourceTimes.length,
        latestSourceTimeMs: sourceTimes.at(-1) ?? null,
        disabledCapabilities: ["hosted", "range", "security"],
      },
    };
  }, [seriesRevision, seriesStore, storeSnapshot]);
}
