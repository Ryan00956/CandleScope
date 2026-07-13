import type { WindowDelta } from "../features/market-data/klineContracts.js";
import type { KlineBar } from "../features/market-data/marketDataTypes.js";
import type {
  ChartSeriesInputRow,
  DeltaViewportController,
  PerfEventRecorder,
  SeriesDataWriter,
  SeriesWindowReader,
  TimedSeriesRow,
} from "./chartAdapterTypes.js";

const DELTA_TYPES = {
  NOOP: "noop",
  TICK: "tick",
  APPEND: "append",
  PREPEND: "prepend",
  MID_MERGE: "mid-merge",
  REPLACE: "replace",
  CLEAR: "clear",
  TRIM_LEFT: "trim-left",
  TRIM_RIGHT: "trim-right",
} as const;

type SeriesRenderMode = "noop" | "empty" | "update" | "setData";

function record(
  recordPerfEvent: PerfEventRecorder | null | undefined,
  name: string,
  detail: Readonly<Record<string, unknown>>,
): void {
  recordPerfEvent?.(name, detail);
}

function resolveIndexOfTime<TRow extends TimedSeriesRow>(
  store: SeriesWindowReader<TRow> | null | undefined,
  rows: TRow[],
  time: number,
): number {
  const fromStore = store?.indexOfTime?.(time);
  if (typeof fromStore === "number" && Number.isFinite(fromStore) && fromStore >= 0) {
    return fromStore;
  }
  if (!rows?.length || time == null) return -1;
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midTime = rows[mid]?.time;
    if (midTime === time) return mid;
    if (midTime < time) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

export function renderSeriesDelta<TPoint = KlineBar>({
  series,
  delta,
  store,
  snapshot,
  previousRows = null,
  viewportController,
  toPoint,
  paneId = "main",
  recordPerfEvent,
}: {
  series?: SeriesDataWriter<TPoint> | null;
  delta?: WindowDelta | null;
  store?: SeriesWindowReader<KlineBar> | null;
  snapshot?: KlineBar[] | null;
  previousRows?: KlineBar[] | null;
  viewportController?: DeltaViewportController<KlineBar> | null;
  toPoint?: (row: KlineBar) => TPoint;
  paneId?: string;
  recordPerfEvent?: PerfEventRecorder;
} = {}): Exclude<SeriesRenderMode, "empty"> {
  const convert = toPoint || ((row: KlineBar) => row as TPoint);
  if (!series || !delta || delta.type === DELTA_TYPES.NOOP) return "noop";

  const trimmedLeft = delta.trimmedLeft || 0;
  const trimmedRight = delta.trimmedRight || 0;
  const hasTrim = trimmedLeft > 0 || trimmedRight > 0;

  if (delta.type === DELTA_TYPES.TICK && delta.bar && !hasTrim) {
    series.update(convert(delta.bar));
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      reason: "delta-tick",
      points: 1,
      totalPoints: delta.bars,
    });
    return "update";
  }

  const rows: KlineBar[] = snapshot || store?.snapshot?.({ force: true }) || [];

  const addedRight = delta.addedRight || 0;
  if (delta.type === DELTA_TYPES.APPEND && addedRight > 0 && !hasTrim) {
    const addedRows = rows.slice(Math.max(0, rows.length - addedRight));
    for (const row of addedRows) {
      series.update(convert(row));
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      reason: "delta-append",
      points: addedRows.length,
      totalPoints: rows.length,
    });
    return "update";
  }

  if (delta.type === DELTA_TYPES.CLEAR) {
    series.setData([]);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      reason: "delta-clear",
      points: 0,
    });
    return "setData";
  }

  // Structural path. Any delta with trimming must also go through setData so
  // the series never keeps bars the window store already dropped.
  const anchor = viewportController?.captureAnchor?.(previousRows) || null;
  const nextData = rows.map(convert);
  series.setData(nextData);
  record(recordPerfEvent, "chart.candleSeries.setData", {
    paneId,
    reason: `delta-${delta.type}`,
    points: nextData.length,
  });

  const compensable = delta.type === DELTA_TYPES.PREPEND
    || delta.type === DELTA_TYPES.MID_MERGE
    || ((delta.type === DELTA_TYPES.TICK || delta.type === DELTA_TYPES.APPEND) && hasTrim);
  if (compensable && viewportController) {
    // Anchor-based compensation is exact for prepends, mid-window inserts
    // left of the viewport, and left-edge trims (including combinations).
    const anchorApplied = anchor
      ? viewportController.applyAnchorShift?.(
        anchor,
        (time) => typeof time === "number" ? resolveIndexOfTime(store, rows, time) : -1,
      )
      : false;
    if (!anchorApplied && delta.type === DELTA_TYPES.MID_MERGE) {
      // A pure prepend is already rebased by Lightweight Charts. Only a
      // mid-window insertion needs a count-based fallback when its exact
      // time anchor cannot be resolved.
      const netShift = (delta.addedLeft || 0) - trimmedLeft;
      if (netShift !== 0) viewportController.compensateInsert(netShift);
    }
  }

  return "setData";
}

function pointEquals(
  left: ChartSeriesInputRow | null | undefined,
  right: ChartSeriesInputRow | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (Reflect.get(left, key) !== Reflect.get(right, key)) return false;
  }
  return true;
}

export function canRenderTrailingUpdate(
  previousData: ChartSeriesInputRow[] | null | undefined,
  nextData: ChartSeriesInputRow[] | null | undefined,
): boolean {
  if (!previousData?.length || !nextData?.length) return false;
  if (nextData.length < previousData.length || nextData.length > previousData.length + 1) return false;
  if (nextData[0]?.time !== previousData[0]?.time) return false;
  if (nextData[previousData.length - 1]?.time !== previousData[previousData.length - 1]?.time) return false;

  const stableCount = Math.max(0, previousData.length - 1);
  for (let index = 0; index < stableCount; index += 1) {
    if (!pointEquals(previousData[index], nextData[index])) return false;
  }
  return true;
}

export function renderCandleDataTransition({
  series,
  previousData = [],
  nextData = [],
  viewportController,
  paneId = "main",
  recordPerfEvent,
}: {
  series?: SeriesDataWriter<ChartSeriesInputRow> | null;
  previousData?: ChartSeriesInputRow[];
  nextData?: ChartSeriesInputRow[];
  viewportController?: DeltaViewportController<TimedSeriesRow> | null;
  paneId?: string;
  recordPerfEvent?: PerfEventRecorder;
} = {}): SeriesRenderMode {
  if (!series) return "noop";

  if (!nextData?.length) {
    if (previousData?.length) {
      return renderSeriesDelta({
        series,
        delta: { type: DELTA_TYPES.CLEAR, changed: true },
        snapshot: [],
        viewportController,
        paneId,
        recordPerfEvent,
      });
    }
    return "empty";
  }

  if (canRenderTrailingUpdate(previousData, nextData)) {
    const start = Math.max(0, previousData.length - 1);
    for (let index = start; index < nextData.length; index += 1) {
      series.update(nextData[index]);
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      reason: "transition-trailing",
      points: nextData.length - start,
      totalPoints: nextData.length,
    });
    return "update";
  }

  series.setData(nextData);
  record(recordPerfEvent, "chart.candleSeries.setData", {
    paneId,
    reason: previousData?.length ? "transition-structural" : "transition-initial",
    points: nextData.length,
  });
  return "setData";
}
