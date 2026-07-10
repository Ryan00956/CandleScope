function afterBoundary(event, sinceAtMs) {
  return sinceAtMs == null || Number(event?.atMs) >= Number(sinceAtMs);
}

export function summarizeShortSwitchIndicatorReadiness(
  performanceReport,
  {
    expectedIndicatorIds = [],
    expectedSeriesCounts = {},
    datasetKey,
    interval,
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

  const indicatorSeriesDataEvents = events.filter((event) => (
    event?.name === "chart.indicatorSeries.setData"
    && Number(event.detail?.points) > 0
    && event.detail?.interval === interval
    && event.detail?.datasetKey === datasetKey
    && event.detail?.indicatorId
    && afterBoundary(event, sinceAtMs)
  ));
  const normalizedExpectedIds = expectedIndicatorIds.map(String);
  const seriesKeysByIndicator = new Map();
  for (const event of indicatorSeriesDataEvents) {
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
  const subscriptionsReady = normalizedExpectedIds.every((id) => subscribedIds.has(id));
  const resumePatchesReady = pendingPatchIds.length === 0;
  const indicatorDataReady = normalizedExpectedIds.every((id) => (
    indicatorSeriesCounts[id] >= Number(expectedSeriesCounts[id] || 1)
  ));

  return {
    ready: indicatorDataReady,
    protocolReady: Boolean(latestOpen) && subscriptionsReady && resumePatchesReady,
    subscriptionsReady,
    resumePatchesReady,
    indicatorDataReady,
    expectedIndicatorIds: normalizedExpectedIds,
    subscribedIndicatorIds: Array.from(subscribedIds).sort(),
    pendingPatchIndicatorIds: pendingPatchIds.sort(),
    expectedSeriesCounts,
    indicatorSeriesCounts,
    indicatorSeriesDataEventCount: indicatorSeriesDataEvents.length,
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
