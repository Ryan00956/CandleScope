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

export function shouldRestoreChartViewport({
  dataMeta,
  datasetKey,
  hasRestored = false,
  hasRows = false,
  lastRestoreSource = null,
} = {}) {
  const readyForDataset = Boolean(
    hasRows
    && dataMeta?.status === "ready"
    && dataMeta?.seriesKey === datasetKey
  );
  if (!readyForDataset) return false;
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
