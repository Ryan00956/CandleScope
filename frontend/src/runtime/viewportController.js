export function planVisibleRangeRestore(savedVisibleRange, data, currentDataMeta = null) {
  const dataLength = data?.length || 0;
  const firstDataTime = data?.[0]?.time;
  const lastDataTime = dataLength > 0 ? data[dataLength - 1]?.time : undefined;
  const savedTimeRange = savedVisibleRange?.time;
  const savedLogicalRange = savedVisibleRange?.logical;

  const savedTimeIntersectsData = Boolean(
    savedTimeRange
      && Number.isFinite(savedTimeRange.from)
      && Number.isFinite(savedTimeRange.to)
      && Number.isFinite(firstDataTime)
      && Number.isFinite(lastDataTime)
      && savedTimeRange.to >= firstDataTime
      && savedTimeRange.from <= lastDataTime,
  );

  const savedLogicalIntersectsData = Boolean(
    savedLogicalRange
      && Number.isFinite(savedLogicalRange.from)
      && Number.isFinite(savedLogicalRange.to)
      && savedLogicalRange.to >= 0
      && savedLogicalRange.from <= dataLength - 1,
  );

  const savedVersion = savedVisibleRange?.dataVersion;
  const currentVersion = currentDataMeta?.version;
  const hasVersionPair = Number.isFinite(savedVersion) && Number.isFinite(currentVersion);
  const savedVersionMatchesCurrent = !hasVersionPair || savedVersion === currentVersion;
  const canUseLogicalFallback = (!savedTimeRange || savedTimeIntersectsData) && savedVersionMatchesCurrent;
  const barSpacing = Number.isFinite(savedVisibleRange?.barSpacing)
    ? savedVisibleRange.barSpacing
    : null;
  const scrollPosition = Number.isFinite(savedVisibleRange?.scrollPosition)
    ? savedVisibleRange.scrollPosition
    : null;

  if (savedTimeIntersectsData) {
    return {
      mode: "time",
      timeRange: savedTimeRange,
      barSpacing,
      scrollPosition,
    };
  }

  if (canUseLogicalFallback && savedLogicalIntersectsData) {
    return {
      mode: "logical",
      logicalRange: savedLogicalRange,
      barSpacing,
      scrollPosition,
    };
  }

  return {
    mode: "fit",
    timeRange: null,
    logicalRange: null,
    barSpacing: null,
    scrollPosition: null,
  };
}
