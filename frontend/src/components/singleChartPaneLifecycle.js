const EMPTY_DATA_TIME_SET = new Set();

export function shouldRequestMoreLeft({
  canLoad = false,
  hasData = false,
  hasHandler = false,
  rangeFrom,
  triggerBars,
  userInteracted = false,
} = {}) {
  return Boolean(
    userInteracted
    && canLoad
    && hasData
    && hasHandler
    && Number.isFinite(rangeFrom)
    && Number.isFinite(triggerBars)
    && rangeFrom <= triggerBars
  );
}

export function resolveDataTimeSet(seriesStore) {
  return seriesStore?.timeSet?.() || EMPTY_DATA_TIME_SET;
}

export function buildVisibleRangeSnapshot({
  barSpacing,
  logicalRange,
  rightOffset,
  timeRange,
} = {}) {
  const snapshot = {};
  if (Number.isFinite(barSpacing)) snapshot.barSpacing = barSpacing;
  if (Number.isFinite(rightOffset)) snapshot.rightOffset = rightOffset;

  if (Number.isFinite(timeRange?.from) && Number.isFinite(timeRange?.to)) {
    snapshot.time = { from: timeRange.from, to: timeRange.to };
    snapshot.rightmostTime = timeRange.to;
  }

  if (Number.isFinite(logicalRange?.from) && Number.isFinite(logicalRange?.to)) {
    snapshot.logical = { from: logicalRange.from, to: logicalRange.to };
  }

  return snapshot.time || snapshot.logical ? snapshot : null;
}

export function shouldPublishUserViewportRange({
  isProgrammatic = false,
  isSyncing = false,
  range = null,
  userInteracted = false,
} = {}) {
  return Boolean(range && userInteracted && !isProgrammatic && !isSyncing);
}

export function shouldRestoreChartViewport({
  dataMeta,
  datasetKey,
  hasRestored = false,
  hasRows = false,
  lastRestoreSource = null,
  userInteracted = false,
} = {}) {
  const readyForDataset = Boolean(
    hasRows
    && dataMeta?.status === "ready"
    && dataMeta?.seriesKey === datasetKey
  );
  if (!readyForDataset) return false;
  if (userInteracted) return false;
  if (!hasRestored) return true;

  const source = String(dataMeta?.source || "");
  const previousSource = String(lastRestoreSource || "");
  return source.startsWith("initial-history")
    && !previousSource.startsWith("initial-history");
}

export function shouldAdvanceIndicatorSeriesReady({
  createdSeriesCount = 0,
  paneStructureChanged = false,
  removedSeriesCount = 0,
  structureChanged = false,
} = {}) {
  return Boolean(
    structureChanged
    || paneStructureChanged
    || removedSeriesCount > 0
    || createdSeriesCount > 0
  );
}
