import { createMainSeriesPointConverter } from "./mainSeriesModel.js";
import { chartTimesEqual } from "./chartTime.js";
import type {
  ChartSeriesInputRow,
  MainSeriesDataOptions,
  PerfEventRecorder,
  ProjectionPatchCandidate,
  ProjectionRenderMode,
  ProjectionRenderPatch,
  ProjectionRenderResult,
  ProjectionSeriesWriter,
  ProjectionViewportController,
} from "./chartAdapterTypes.js";

const MAX_INCREMENTAL_TAIL_MUTATIONS = 64;
const materializedPatchData = new WeakMap<object, ChartSeriesInputRow[]>();

type ValidTailPatchShape = ProjectionPatchCandidate & {
  fromOutputIndex: number;
  deleteCount: number;
  insert: ChartSeriesInputRow[];
  previousLength: number;
  nextLength: number;
};

function isArrayContainer(value: unknown): boolean {
  // Patch element types are owned by the internal ProjectionPatchCandidate
  // contract. This runtime check only preserves fail-closed behavior for an
  // untyped caller without pretending to validate every element in a hot path.
  return Array.isArray(value);
}

function clampTailStart(value: unknown, length: number): number {
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length, Math.floor(index)));
}

export function buildMainSeriesProjectionPatch({
  displayRows = [],
  previousSeriesData = [],
  projectionPatch,
  renderOptions = {},
}: {
  displayRows?: ChartSeriesInputRow[];
  previousSeriesData?: ChartSeriesInputRow[];
  projectionPatch?: { fromOutputIndex?: unknown } | null;
  renderOptions?: MainSeriesDataOptions;
} = {}): ProjectionRenderPatch {
  const rows = Array.isArray(displayRows) ? displayRows : [];
  const previous = Array.isArray(previousSeriesData) ? previousSeriesData : [];
  const reusablePrefixLength = Math.min(rows.length, previous.length);
  const fromOutputIndex = clampTailStart(
    projectionPatch?.fromOutputIndex,
    reusablePrefixLength,
  );
  const toPoint = createMainSeriesPointConverter(rows, {
    ...renderOptions,
    startIndex: fromOutputIndex,
  });
  const insert = rows.slice(fromOutputIndex).map(toPoint);

  return {
    kind: "replace-tail",
    fromOutputIndex,
    deleteCount: Math.max(0, previous.length - fromOutputIndex),
    insert,
    previousData: previous,
    previousLength: previous.length,
    nextLength: fromOutputIndex + insert.length,
  };
}

export function materializeMainSeriesProjectionPatch(
  patch: ProjectionPatchCandidate | null | undefined,
): ChartSeriesInputRow[] {
  const explicitNextData = patch?.nextData;
  if (explicitNextData && isArrayContainer(explicitNextData)) return explicitNextData;
  if (patch && typeof patch === "object" && materializedPatchData.has(patch)) {
    return materializedPatchData.get(patch) ?? [];
  }
  const previousCandidate = patch?.previousData;
  const previous = previousCandidate && isArrayContainer(previousCandidate)
    ? previousCandidate
    : [];
  const fromOutputIndex = clampTailStart(patch?.fromOutputIndex, previous.length);
  const insertCandidate = patch?.insert;
  const insert = insertCandidate && isArrayContainer(insertCandidate) ? insertCandidate : [];
  const nextData = previous.slice(0, fromOutputIndex).concat(insert);
  if (patch && typeof patch === "object") materializedPatchData.set(patch, nextData);
  return nextData;
}

function isValidTailPatchShape(
  patch: ProjectionPatchCandidate | null | undefined,
): patch is ValidTailPatchShape {
  const fromOutputIndex = Number(patch?.fromOutputIndex);
  const deleteCount = Number(patch?.deleteCount);
  const previousLength = Number(patch?.previousLength);
  const nextLength = Number(patch?.nextLength);
  const insert = patch?.insert;
  if (!insert
    || !isArrayContainer(insert)
    || !Number.isInteger(fromOutputIndex)
    || !Number.isInteger(deleteCount)
    || !Number.isInteger(previousLength)
    || !Number.isInteger(nextLength)
    || fromOutputIndex < 0
    || deleteCount < 0
    || previousLength < 0
    || nextLength < 0
    || fromOutputIndex > previousLength
    || deleteCount !== previousLength - fromOutputIndex
    || nextLength !== fromOutputIndex + insert.length) {
    return false;
  }
  return true;
}

function hasValidPreviousData(
  patch: ProjectionPatchCandidate | null | undefined,
): patch is ProjectionPatchCandidate & {
  previousData: ChartSeriesInputRow[];
  previousLength: number;
} {
  const previousData = patch?.previousData;
  return previousData !== undefined
    && isArrayContainer(previousData)
    && previousData.length === patch?.previousLength;
}

function preservesTailTimeTopology(patch: ValidTailPatchShape & {
  previousData: ChartSeriesInputRow[];
}): boolean {
  if (patch.deleteCount !== patch.insert.length) return false;
  for (let index = 0; index < patch.insert.length; index += 1) {
    if (!chartTimesEqual(
      patch.previousData[patch.fromOutputIndex + index]?.time,
      patch.insert[index]?.time,
    )) return false;
  }
  return true;
}

function cacheCommittedPatchData(
  patch: object,
  data: ChartSeriesInputRow[],
): ChartSeriesInputRow[] {
  if (patch && typeof patch === "object") materializedPatchData.set(patch, data);
  return data;
}

function commitMainSeriesProjectionPatch(
  patch: ProjectionPatchCandidate,
): ChartSeriesInputRow[] {
  if (!hasValidPreviousData(patch) || !isValidTailPatchShape(patch)) {
    return materializeMainSeriesProjectionPatch(patch);
  }
  const previous = patch.previousData;
  const insert = patch.insert;
  const fromOutputIndex = patch.fromOutputIndex;
  if (patch && typeof patch === "object" && materializedPatchData.has(patch)) {
    return materializedPatchData.get(patch) ?? previous;
  }

  if (fromOutputIndex === previous.length && insert.length === 0) {
    return cacheCommittedPatchData(patch, previous);
  }
  if (!Object.isExtensible(previous) || Object.isSealed(previous) || Object.isFrozen(previous)) {
    return materializeMainSeriesProjectionPatch(patch);
  }

  try {
    previous.length = fromOutputIndex;
    for (const point of insert) previous.push(point);
    return cacheCommittedPatchData(patch, previous);
  } catch {
    return materializeMainSeriesProjectionPatch(patch);
  }
}

function renderResult(
  mode: ProjectionRenderMode,
  nextData: ChartSeriesInputRow[],
): ProjectionRenderResult {
  return { mode, nextData };
}

function record(
  recordPerfEvent: PerfEventRecorder | null | undefined,
  name: string,
  detail: Readonly<Record<string, unknown>>,
): void {
  try {
    recordPerfEvent?.(name, detail);
  } catch {
    // Performance instrumentation must never interrupt chart state commits.
  }
}

export function renderMainSeriesProjectionPatch({
  paneId = "main",
  patch,
  preserveViewport = false,
  previousDisplayRows = [],
  recordPerfEvent,
  resolveDisplayAnchorIndex,
  series,
  viewportController,
}: {
  paneId?: string;
  patch?: ProjectionPatchCandidate | null;
  preserveViewport?: boolean;
  previousDisplayRows?: ChartSeriesInputRow[];
  recordPerfEvent?: PerfEventRecorder;
  resolveDisplayAnchorIndex?: (anchor: unknown) => number;
  series?: ProjectionSeriesWriter<ChartSeriesInputRow> | null;
  viewportController?: ProjectionViewportController | null;
} = {}): ProjectionRenderResult {
  if (!patch) return renderResult("noop", []);
  if (!series) {
    const previousData = patch.previousData;
    const nextData = patch.nextData;
    const retainedData = previousData && isArrayContainer(previousData)
      ? previousData
      : (nextData && isArrayContainer(nextData) ? nextData : []);
    return renderResult(
      "noop",
      retainedData,
    );
  }
  if (!isValidTailPatchShape(patch)) {
    const nextData = patch.nextData;
    if (!nextData || !isArrayContainer(nextData)) {
      throw new TypeError("projection patch must describe a complete rendered tail replacement");
    }
    series.setData(nextData);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: nextData.length,
      reason: "projection-invalid-patch-rebuild",
    });
    return renderResult("setData", nextData);
  }
  if (!hasValidPreviousData(patch)) {
    const nextData = patch.nextData;
    if (!nextData || !isArrayContainer(nextData)) {
      throw new TypeError("incremental projection patches require previous rendered data");
    }
    series.setData(nextData);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: nextData.length,
      reason: "projection-explicit-data-rebuild",
    });
    return renderResult("setData", nextData);
  }
  if (patch.deleteCount === 0
    && patch.insert?.length === 0
    && patch.previousLength === patch.nextLength) {
    return renderResult("noop", commitMainSeriesProjectionPatch(patch));
  }

  if (patch.nextLength === 0) {
    series.setData([]);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: 0,
      reason: "projection-clear",
    });
    return renderResult("setData", commitMainSeriesProjectionPatch(patch));
  }

  if (patch.previousLength === 0) {
    const nextData = materializeMainSeriesProjectionPatch(patch);
    series.setData(nextData);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: patch.nextLength,
      reason: "projection-initial",
    });
    return renderResult("setData", nextData);
  }

  const isPureAppend = patch.deleteCount === 0
    && patch.fromOutputIndex === patch.previousLength;
  const isReplaceLastAndAppend = patch.deleteCount === 1
    && patch.fromOutputIndex === patch.previousLength - 1
    && patch.insert.length > 0;

  if (isPureAppend || isReplaceLastAndAppend) {
    try {
      for (const point of patch.insert) series.update(point);
    } catch {
      const nextData = materializeMainSeriesProjectionPatch(patch);
      series.setData(nextData);
      record(recordPerfEvent, "chart.candleSeries.setData", {
        paneId,
        points: patch.nextLength,
        reason: "projection-tail-update-fallback",
      });
      return renderResult("setData", nextData);
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      points: patch.insert.length,
      reason: isPureAppend ? "projection-append" : "projection-tail-replace",
      totalPoints: patch.nextLength,
    });
    return renderResult("update", commitMainSeriesProjectionPatch(patch));
  }

  const tailMutationCount = patch.deleteCount + patch.insert.length;
  const canMutateTail = (!preserveViewport || preservesTailTimeTopology(patch))
    && patch.fromOutputIndex > 0
    && patch.deleteCount > 0
    && tailMutationCount <= MAX_INCREMENTAL_TAIL_MUTATIONS
    && typeof series.pop === "function";
  if (canMutateTail) {
    try {
      series.pop(patch.deleteCount);
      for (const point of patch.insert) series.update(point);
    } catch {
      const nextData = materializeMainSeriesProjectionPatch(patch);
      series.setData(nextData);
      record(recordPerfEvent, "chart.candleSeries.setData", {
        paneId,
        points: patch.nextLength,
        reason: "projection-tail-pop-update-fallback",
      });
      return renderResult("setData", nextData);
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      points: patch.insert.length,
      removedPoints: patch.deleteCount,
      reason: "projection-tail-pop-update",
      totalPoints: patch.nextLength,
    });
    return renderResult("pop-update", commitMainSeriesProjectionPatch(patch));
  }

  const anchor = preserveViewport
    ? viewportController?.captureAnchor?.(previousDisplayRows) || null
    : null;
  const nextData = materializeMainSeriesProjectionPatch(patch);
  series.setData(nextData);
  record(recordPerfEvent, "chart.candleSeries.setData", {
    paneId,
    points: patch.nextLength,
    reason: "projection-tail-rebuild",
  });
  if (anchor && typeof resolveDisplayAnchorIndex === "function") {
    try {
      viewportController?.applyAnchorShift?.(anchor, resolveDisplayAnchorIndex);
    } catch {
      // Data has already committed; viewport compensation is best-effort.
    }
  }
  return renderResult("setData", nextData);
}
