import { createMainSeriesPointConverter } from "./mainSeriesModel.js";

const MAX_INCREMENTAL_TAIL_MUTATIONS = 64;

function clampTailStart(value, length) {
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length, Math.floor(index)));
}

export function buildMainSeriesProjectionPatch({
  displayRows = [],
  previousSeriesData = [],
  projectionPatch,
  renderOptions = {},
} = {}) {
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
  const nextData = [
    ...previous.slice(0, fromOutputIndex),
    ...insert,
  ];

  return {
    kind: "replace-tail",
    fromOutputIndex,
    deleteCount: Math.max(0, previous.length - fromOutputIndex),
    insert,
    nextData,
    previousLength: previous.length,
    nextLength: nextData.length,
  };
}

function record(recordPerfEvent, name, detail) {
  recordPerfEvent?.(name, detail);
}

export function renderMainSeriesProjectionPatch({
  indexOfDisplayTime,
  paneId = "main",
  patch,
  preserveViewport = false,
  previousDisplayRows = [],
  recordPerfEvent,
  series,
  viewportController,
} = {}) {
  if (!series || !patch) return "noop";
  if (patch.deleteCount === 0
    && patch.insert?.length === 0
    && patch.previousLength === patch.nextLength) return "noop";

  if (patch.nextLength === 0) {
    series.setData([]);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: 0,
      reason: "projection-clear",
    });
    return "setData";
  }

  if (patch.previousLength === 0) {
    series.setData(patch.nextData);
    record(recordPerfEvent, "chart.candleSeries.setData", {
      paneId,
      points: patch.nextLength,
      reason: "projection-initial",
    });
    return "setData";
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
      series.setData(patch.nextData);
      record(recordPerfEvent, "chart.candleSeries.setData", {
        paneId,
        points: patch.nextLength,
        reason: "projection-tail-update-fallback",
      });
      return "setData";
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      points: patch.insert.length,
      reason: isPureAppend ? "projection-append" : "projection-tail-replace",
      totalPoints: patch.nextLength,
    });
    return "update";
  }

  const tailMutationCount = patch.deleteCount + patch.insert.length;
  const canMutateTail = !preserveViewport
    && patch.fromOutputIndex > 0
    && patch.deleteCount > 0
    && tailMutationCount <= MAX_INCREMENTAL_TAIL_MUTATIONS
    && typeof series.pop === "function";
  if (canMutateTail) {
    try {
      series.pop(patch.deleteCount);
      for (const point of patch.insert) series.update(point);
    } catch {
      series.setData(patch.nextData);
      record(recordPerfEvent, "chart.candleSeries.setData", {
        paneId,
        points: patch.nextLength,
        reason: "projection-tail-pop-update-fallback",
      });
      return "setData";
    }
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      points: patch.insert.length,
      removedPoints: patch.deleteCount,
      reason: "projection-tail-pop-update",
      totalPoints: patch.nextLength,
    });
    return "pop-update";
  }

  const anchor = preserveViewport
    ? viewportController?.captureAnchor?.(previousDisplayRows) || null
    : null;
  series.setData(patch.nextData);
  record(recordPerfEvent, "chart.candleSeries.setData", {
    paneId,
    points: patch.nextLength,
    reason: "projection-tail-rebuild",
  });
  if (anchor && typeof indexOfDisplayTime === "function") {
    viewportController?.applyAnchorShift?.(anchor, indexOfDisplayTime);
  }
  return "setData";
}
