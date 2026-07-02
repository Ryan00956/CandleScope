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
};

function identity(row) {
  return row;
}

function record(recordPerfEvent, name, detail) {
  recordPerfEvent?.(name, detail);
}

function resolveIndexOfTime(store, rows, time) {
  const fromStore = store?.indexOfTime?.(time);
  if (Number.isFinite(fromStore) && fromStore >= 0) return fromStore;
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

export function renderSeriesDelta({
  series,
  delta,
  store,
  snapshot,
  previousRows = null,
  viewportController,
  toPoint = identity,
  paneId = "main",
  recordPerfEvent,
} = {}) {
  if (!series || !delta || delta.type === DELTA_TYPES.NOOP) return "noop";

  const trimmedLeft = delta.trimmedLeft || 0;
  const trimmedRight = delta.trimmedRight || 0;
  const hasTrim = trimmedLeft > 0 || trimmedRight > 0;

  if (delta.type === DELTA_TYPES.TICK && delta.bar && !hasTrim) {
    series.update(toPoint(delta.bar));
    record(recordPerfEvent, "chart.candleSeries.update", {
      paneId,
      reason: "delta-tick",
      points: 1,
      totalPoints: delta.bars,
    });
    return "update";
  }

  const rows = snapshot || store?.snapshot?.({ force: true }) || [];

  if (delta.type === DELTA_TYPES.APPEND && delta.addedRight > 0 && !hasTrim) {
    const addedRows = rows.slice(Math.max(0, rows.length - delta.addedRight));
    for (const row of addedRows) {
      series.update(toPoint(row));
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
  const nextData = rows.map(toPoint);
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
      ? viewportController.applyAnchorShift?.(anchor, (time) => resolveIndexOfTime(store, rows, time))
      : false;
    if (!anchorApplied) {
      const netShift = (delta.addedLeft || 0) - trimmedLeft;
      if (netShift !== 0) viewportController.compensateInsert(netShift);
    }
  }

  return "setData";
}

function pointEquals(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function canRenderTrailingUpdate(previousData, nextData) {
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
} = {}) {
  if (!series) return "noop";

  if (!nextData?.length) {
    if (previousData?.length) {
      return renderSeriesDelta({
        series,
        delta: { type: DELTA_TYPES.CLEAR },
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
