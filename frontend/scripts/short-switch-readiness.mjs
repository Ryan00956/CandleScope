function afterBoundary(event, sinceAtMs) {
  return sinceAtMs == null || Number(event?.atMs) >= Number(sinceAtMs);
}

export function summarizeShortSwitchIndicatorReadiness(
  performanceReport,
  {
    expectedIndicatorIds = [],
    expectedSeriesCounts = {},
    datasetKey,
    expectedMainSetDataCount = null,
    interval,
    maxSetDataPerSeries = Number.POSITIVE_INFINITY,
    sinceAtMs = null,
  } = {},
) {
  const events = Array.isArray(performanceReport?.events) ? performanceReport.events : [];
  const matchingOpens = events.filter((event) => (
    event?.name === "indicator.ws.open"
    && event.detail?.interval === interval
    && afterBoundary(event, sinceAtMs)
  ));
  const latestOpen = matchingOpens[matchingOpens.length - 1] || null;
  const wsGeneration = latestOpen?.detail?.wsGeneration ?? null;
  const ackCutoffMs = latestOpen?.atMs ?? Number.POSITIVE_INFINITY;
  const matchingAcks = events.filter((event) => (
    event?.name === "indicator.ws.subscribed"
    && event.detail?.interval === interval
    && event.detail?.indicatorId
    && Number(event.atMs) >= ackCutoffMs
    && event.detail?.wsGeneration === wsGeneration
  ));
  const latestAckById = new Map();
  for (const event of matchingAcks) {
    latestAckById.set(String(event.detail.indicatorId), event);
  }
  const subscribedIds = new Set(latestAckById.keys());

  const appliedPatches = events.filter((event) => (
    event?.name === "indicator.ws.patch"
    && event.detail?.interval === interval
    && event.detail?.indicatorId
    && Number(event.atMs) >= ackCutoffMs
    && event.detail?.wsGeneration === wsGeneration
  ));
  const pendingPatchIds = [];
  for (const [indicatorId, ack] of latestAckById.entries()) {
    const resumeStatus = ack.detail?.resumeStatus || "legacy";
    if (resumeStatus !== "patch") continue;
    const applied = appliedPatches.some((event) => (
      String(event.detail.indicatorId) === indicatorId
      && Number(event.atMs) >= Number(ack.atMs)
    ));
    if (!applied) pendingPatchIds.push(indicatorId);
  }

  const indicatorSetDataEvents = events.filter((event) => (
    event?.name === "chart.indicatorSeries.setData"
    && event.detail?.interval === interval
    && event.detail?.datasetKey === datasetKey
    && event.detail?.indicatorId
    && afterBoundary(event, sinceAtMs)
  ));
  const indicatorSeriesCoverageEvents = indicatorSetDataEvents.filter((event) => (
    Number(event.detail?.points) > 0
  ));
  const mainSetDataEvents = events.filter((event) => (
    event?.name === "chart.candleSeries.setData"
    && afterBoundary(event, sinceAtMs)
  ));
  const normalizedExpectedIds = expectedIndicatorIds.map(String);
  const seriesKeysByIndicator = new Map();
  for (const event of indicatorSeriesCoverageEvents) {
    const indicatorId = String(event.detail.indicatorId);
    if (!seriesKeysByIndicator.has(indicatorId)) seriesKeysByIndicator.set(indicatorId, new Set());
    seriesKeysByIndicator.get(indicatorId).add([
      event.detail?.paneId || "",
      event.detail?.line || "",
      event.detail?.type || "line",
    ].join("|"));
  }
  const indicatorSeriesCounts = Object.fromEntries(
    normalizedExpectedIds.map((id) => [id, seriesKeysByIndicator.get(id)?.size || 0]),
  );
  const indicatorSetDataCounts = {};
  for (const event of indicatorSetDataEvents) {
    const seriesKey = [
      event.detail?.indicatorId || "",
      event.detail?.paneId || "",
      event.detail?.line || "",
      event.detail?.type || "line",
    ].join("|");
    indicatorSetDataCounts[seriesKey] = (indicatorSetDataCounts[seriesKey] || 0) + 1;
  }
  const indicatorFullSubmissionsReady = Object.values(indicatorSetDataCounts)
    .every((count) => count <= maxSetDataPerSeries);
  const mainSetDataCount = mainSetDataEvents.length;
  const mainSubmissionReady = expectedMainSetDataCount == null
    || mainSetDataCount === expectedMainSetDataCount;
  const submissionReady = indicatorFullSubmissionsReady && mainSubmissionReady;
  const submissionTimes = [...indicatorSetDataEvents, ...mainSetDataEvents]
    .map((event) => Number(event?.atMs))
    .filter(Number.isFinite);
  const lastSubmissionAtMs = submissionTimes.length > 0
    ? Math.max(...submissionTimes)
    : null;
  const subscriptionsReady = normalizedExpectedIds.every((id) => subscribedIds.has(id));
  const resumePatchesReady = pendingPatchIds.length === 0;
  const indicatorDataReady = normalizedExpectedIds.every((id) => (
    indicatorSeriesCounts[id] >= Number(expectedSeriesCounts[id] || 1)
  ));
  const protocolReady = Boolean(latestOpen) && subscriptionsReady && resumePatchesReady;

  return {
    ready: indicatorDataReady && protocolReady,
    protocolReady,
    subscriptionsReady,
    resumePatchesReady,
    indicatorDataReady,
    expectedIndicatorIds: normalizedExpectedIds,
    subscribedIndicatorIds: Array.from(subscribedIds).sort(),
    pendingPatchIndicatorIds: pendingPatchIds.sort(),
    expectedSeriesCounts,
    indicatorSeriesCounts,
    indicatorSeriesDataEventCount: indicatorSeriesCoverageEvents.length,
    indicatorSetDataEventCount: indicatorSetDataEvents.length,
    indicatorSetDataCounts,
    indicatorFullSubmissionsReady,
    mainSetDataCount,
    mainSubmissionReady,
    submissionReady,
    lastSubmissionAtMs,
    latestOpenAtMs: latestOpen?.atMs ?? null,
    wsGeneration,
    observedSubscriptionEvents: events
      .filter((event) => event?.name === "indicator.ws.subscribed" && afterBoundary(event, sinceAtMs))
      .map((event) => ({ atMs: event.atMs, detail: event.detail })),
  };
}

export function resolveShortSwitchStepTransition({
  allowInitialPrime = false,
  clickOk = false,
  wasActive = false,
} = {}) {
  const transitioned = Boolean(clickOk && !wasActive);
  const primedFromInitial = Boolean(clickOk && wasActive && allowInitialPrime);
  return {
    readyEligible: transitioned || primedFromInitial,
    transitioned,
    primedFromInitial,
    sinceAtMs: primedFromInitial ? 0 : null,
  };
}

export function summarizeShortSwitchLongTasks(
  longTasks = [],
  steps = [],
  { phasePrefix = "short-switch-measured:" } = {},
) {
  const measuredSteps = steps.filter((step) => String(step?.phase || "").startsWith(phasePrefix));
  const byPhase = measuredSteps.map((step) => {
    const startMs = Number(step?.sincePerfMs);
    const explicitEndMs = Number(step?.attributionEndPerfMs);
    const fallbackEndMs = startMs + Math.max(0, Number(step?.elapsedMs) || 0);
    const endMs = Number.isFinite(explicitEndMs) && explicitEndMs >= startMs
      ? explicitEndMs
      : fallbackEndMs;
    const attributable = longTasks.filter((task) => {
      const taskStartMs = Number(task?.startTime);
      const durationMs = Number(task?.duration);
      return Number.isFinite(taskStartMs)
        && Number.isFinite(durationMs)
        && durationMs > 50
        && taskStartMs >= startMs
        && taskStartMs <= endMs;
    });
    return {
      phase: step.phase,
      startMs,
      endMs,
      count: attributable.length,
      maxDurationMs: attributable.length
        ? Math.max(...attributable.map((task) => Number(task.duration)))
        : 0,
      tasks: attributable,
    };
  });
  return {
    count: byPhase.reduce((total, phase) => total + phase.count, 0),
    maxDurationMs: byPhase.length
      ? Math.max(...byPhase.map((phase) => phase.maxDurationMs))
      : 0,
    byPhase,
  };
}
