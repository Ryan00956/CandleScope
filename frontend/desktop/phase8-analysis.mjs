function finite(values) {
  return values.map(Number).filter(Number.isFinite);
}

export function percentile(values, ratio) {
  const ordered = finite(values).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1);
  return ordered[Math.min(index, ordered.length - 1)];
}

function growthPercent(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}

function quantile(values, ratio) {
  const ordered = finite(values).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const index = Math.floor((ordered.length - 1) * Math.max(0, Math.min(1, ratio)));
  return ordered[index];
}

function seriesAnalysis(values) {
  const points = finite(values);
  if (points.length < 2) {
    return { first: points[0] ?? null, last: points.at(-1) ?? null, growthPercent: null, plateauGrowthPercent: null, positiveRatio: null, monotonic: null };
  }
  const plateauStart = points[Math.max(0, Math.floor(points.length * 0.8) - 1)];
  const positive = points.slice(1).filter((value, index) => value > points[index]).length;
  const plateauGrowth = growthPercent(plateauStart, points.at(-1));
  return {
    first: points[0],
    last: points.at(-1),
    growthPercent: growthPercent(points[0], points.at(-1)),
    plateauGrowthPercent: plateauGrowth,
    positiveRatio: positive / (points.length - 1),
    monotonic: positive / (points.length - 1) >= 0.8 && Number(plateauGrowth) > 2,
  };
}

function retainedPlateauAnalysis(values) {
  const points = finite(values);
  if (points.length < 2) {
    return { firstLowWatermark: null, lastLowWatermark: null, growthPercent: null };
  }
  const tailSize = Math.min(points.length, Math.max(3, Math.floor(points.length * 0.2)));
  const tail = points.slice(-tailSize);
  const split = Math.max(1, Math.floor(tail.length / 2));
  const firstHalf = tail.slice(0, split);
  const lastHalf = tail.slice(split);
  const firstLowWatermark = quantile(firstHalf, 0.1);
  const lastLowWatermark = quantile(lastHalf.length > 0 ? lastHalf : firstHalf, 0.1);
  return {
    firstLowWatermark,
    lastLowWatermark,
    growthPercent: growthPercent(firstLowWatermark, lastLowWatermark),
  };
}

export function analyzeMemoryWarmupPlateau(values, {
  minSamples = 5,
  maxSpreadPercent = 5,
  maxTrendPercent = 5,
} = {}) {
  const points = finite(values);
  if (points.length < minSamples) {
    return {
      pass: false,
      sampleCount: points.length,
      lowWatermark: null,
      highWatermark: null,
      spreadPercent: null,
      trendPercent: null,
      endToEndPercent: null,
    };
  }
  const lowWatermark = quantile(points, 0.1);
  const highWatermark = quantile(points, 0.9);
  const split = Math.max(1, Math.floor(points.length / 2));
  const firstLowWatermark = quantile(points.slice(0, split), 0.1);
  const lastLowWatermark = quantile(points.slice(split), 0.1);
  const spreadPercent = growthPercent(lowWatermark, highWatermark);
  const trendPercent = growthPercent(firstLowWatermark, lastLowWatermark);
  const endToEndPercent = growthPercent(points[0], points.at(-1));
  return {
    pass: Number(spreadPercent) <= maxSpreadPercent
      && Number(trendPercent) <= maxTrendPercent
      && Number(endToEndPercent) <= maxTrendPercent,
    sampleCount: points.length,
    lowWatermark,
    highWatermark,
    spreadPercent,
    trendPercent,
    endToEndPercent,
  };
}

function sampleAtDuration(samples, durationMs) {
  const target = Number(samples[0]?.atMs || 0) + Math.max(0, Number(durationMs || 0));
  return samples.find((sample) => Number(sample?.atMs || 0) >= target) || samples.at(-1);
}

export function histogramPercentileDelta(baseline, current, ratio) {
  const before = baseline?.counts;
  const after = current?.counts;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null;
  if (Number(baseline?.bucket_width_ms) !== Number(current?.bucket_width_ms)
    || Number(baseline?.max_ms) !== Number(current?.max_ms)) return null;
  const deltas = after.map((value, index) => Math.max(0, Number(value || 0) - Number(before[index] || 0)));
  const total = deltas.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(total * ratio));
  let cumulative = 0;
  for (let index = 0; index < deltas.length; index += 1) {
    cumulative += deltas[index];
    if (cumulative >= rank) {
      const maxMs = Number(current.max_ms);
      return index > maxMs ? maxMs + Number(current.bucket_width_ms || 1) : index;
    }
  }
  return null;
}

function sumWindow(sample, selector) {
  return (sample?.windows || []).reduce((sum, window) => sum + Number(selector(window) || 0), 0);
}

function sumBackendSent(sample, eventType) {
  return Number(sample?.backend?.klineBatch?.sent_by_type?.[eventType] || 0);
}

function delta(first, last) {
  return Math.max(0, Number(last || 0) - Number(first || 0));
}

function connectionIdentityPass(sample) {
  const batch = sample?.backend?.klineBatch;
  const manager = sample?.backend?.dataManager;
  return batch?.websocket_connections === 4
    && batch?.logical_clients === 64
    && batch?.logical_series === 64
    && batch?.logical_subscriptions === 64
    && manager?.activeSeries === 64
    && manager?.leasedSeries === 64
    && manager?.streamLeases === 64
    && manager?.uniqueLeaseConsumers === 64;
}

export function analyzePhase8Soak(samples, {
  requiredDurationMs = 14_400_000,
  transportBaseline = {},
} = {}) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new TypeError("Phase 8 soak analysis requires at least two samples");
  }
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = Math.max(0, Number(last?.atMs || 0) - Number(first?.atMs || 0));
  const heap = seriesAnalysis(samples.map((sample) => sumWindow(
    sample,
    (window) => window.renderer?.heapUsedBytes,
  )));
  const rendererPrivate = seriesAnalysis(samples.map((sample) => sumWindow(
    sample,
    (window) => window.process?.privateBytes,
  )));
  const backendPrivate = seriesAnalysis(samples.map((sample) => (
    sample?.backend?.runtime?.processMemory?.privateBytes
  )));
  const heapPlateau = retainedPlateauAnalysis(samples.map((sample) => sumWindow(
    sample,
    (window) => window.renderer?.heapUsedBytes,
  )));
  const rendererPrivatePlateau = retainedPlateauAnalysis(samples.map((sample) => sumWindow(
    sample,
    (window) => window.process?.privateBytes,
  )));
  const backendPrivatePlateau = retainedPlateauAnalysis(samples.map((sample) => (
    sample?.backend?.runtime?.processMemory?.privateBytes
  )));
  const heap30MinuteSample = sampleAtDuration(samples, Math.min(requiredDurationMs, 30 * 60_000));
  const backendOneHourSample = sampleAtDuration(samples, Math.min(requiredDurationMs, 60 * 60_000));
  const heap30MinuteGrowthPercent = growthPercent(
    sumWindow(first, (window) => window.renderer?.heapUsedBytes),
    sumWindow(heap30MinuteSample, (window) => window.renderer?.heapUsedBytes),
  );
  const backendOneHourGrowthPercent = growthPercent(
    first?.backend?.runtime?.processMemory?.privateBytes,
    backendOneHourSample?.backend?.runtime?.processMemory?.privateBytes,
  );
  const finalWindowMetrics = last.windows || [];
  const inputLatencies = finalWindowMetrics.flatMap((window) => (
    finite(window.renderer?.metrics?.inputLatencies || [])
  ));
  const longTasks = finalWindowMetrics.map((window) => (
    (window.renderer?.metrics?.longTasks || []).filter((task) => Number(task?.duration) > 50).length
  ));
  const focusedLongTasks = finalWindowMetrics.reduce((sum, window) => (
    sum + (window.renderer?.metrics?.longTasks || [])
      .filter((task) => Number(task?.duration) > 50 && task?.focused === true).length
  ), 0);
  const durationMinutes = Math.max(durationMs / 60_000, 1 / 60);
  const globalLongTasksPerMinute = longTasks.reduce((sum, value) => sum + value, 0) / durationMinutes;
  const focusLongTasksPerMinute = focusedLongTasks / durationMinutes;
  const baselineEventLoopHistogram = transportBaseline.eventLoopHistogram
    || first?.backend?.runtime?.eventLoopLag?.histogram;
  const finalEventLoopHistogram = last?.backend?.runtime?.eventLoopLag?.histogram;
  const histogramEventLoopLagP99Ms = histogramPercentileDelta(
    baselineEventLoopHistogram,
    finalEventLoopHistogram,
    0.99,
  );
  const eventLoopLagP99Ms = histogramEventLoopLagP99Ms
    ?? Number(last?.backend?.runtime?.eventLoopLag?.p99_ms || 0);
  const parseErrors = sumWindow(last, (window) => window.renderer?.broker?.klineStream?.counts?.parseErrors);
  const indicatorRuntimeCount = sumWindow(last, (window) => window.renderer?.indicators?.runtimeCount);
  const indicatorDefinitionCount = sumWindow(last, (window) => window.renderer?.indicators?.definitionCount);
  const indicatorIssueCount = sumWindow(last, (window) => window.renderer?.indicators?.issueCount);
  const sentClosed = delta(transportBaseline.sentClosed, sumBackendSent(last, "bar.closed"));
  const sentAmended = delta(transportBaseline.sentAmended, sumBackendSent(last, "bar.amended"));
  const receivedClosed = delta(
    transportBaseline.receivedClosed,
    sumWindow(last, (window) => window.renderer?.broker?.klineStream?.counts?.closed),
  );
  const receivedAmended = delta(
    transportBaseline.receivedAmended,
    sumWindow(last, (window) => window.renderer?.broker?.klineStream?.counts?.amended),
  );
  const committedAuthoritative = delta(
    transportBaseline.authoritativeCommits,
    sumWindow(last, (window) => window.renderer?.authoritativeCommits),
  );
  const connectionFailures = (sample) => {
    const batch = sample?.backend?.klineBatch;
    if (Number.isFinite(Number(batch?.item_failures))
      && Number.isFinite(Number(batch?.interval_failures))) {
      return Number(batch.item_failures) + Number(batch.interval_failures);
    }
    return (batch?.connections || []).reduce((sum, connection) => (
      sum + Number(connection?.item_failures || 0) + Number(connection?.interval_failures || 0)
    ), 0);
  };
  const itemFailures = delta(connectionFailures(first), connectionFailures(last));
  const queueBounded = (sample) => {
    const batch = sample?.backend?.klineBatch;
    const configuredOutbox = Number(
      batch?.limits?.outboxSize
      ?? sample?.backend?.limits?.klineBatchOutboxSize
      ?? 1_024,
    );
    const eventBus = sample?.backend?.dataManager?.eventBus;
    return Number(batch?.outbox_depth || 0) <= configuredOutbox
      && Number(batch?.outbox_dropped_replaceable || 0) === 0
      && Number(batch?.outbox_authoritative_timeouts || 0) === 0
      && Number(eventBus?.callbackQueueDepth || 0) <= Number(eventBus?.callbackQueueCapacity || 0)
      && Number(eventBus?.iteratorQueueDepth || 0) <= Number(eventBus?.iteratorQueueCapacity || 0)
      && (sample?.windows || []).every((window) => {
        const chartRoots = Math.max(1, Number(window.renderer?.chartRoots || 0));
        return Number(window.renderer?.scheduler?.pendingAsync || 0) <= chartRoots
          && Number(window.renderer?.scheduler?.pendingFrames || 0) <= chartRoots;
      });
  };
  const gates = {
    fullDuration: durationMs >= requiredDurationMs,
    exactIdentityThroughout: samples.every(connectionIdentityPass),
    heapBoundedAndPlateaued: Number(heap30MinuteGrowthPercent) <= 20
      && Number(heapPlateau.growthPercent) <= 5
      && heap.monotonic === false,
    rendererPrivateBoundedAndPlateaued: Number(rendererPrivatePlateau.growthPercent) <= 5
      && rendererPrivate.monotonic === false,
    backendPrivateBoundedAndPlateaued: Number(backendOneHourGrowthPercent) <= 20
      && Number(backendPrivatePlateau.growthPercent) <= 5
      && backendPrivate.monotonic === false,
    inputP95: inputLatencies.length > 0 && Number(percentile(inputLatencies, 0.95)) <= 150,
    longTasks: globalLongTasksPerMinute <= 15 && focusLongTasksPerMinute <= 5,
    eventLoopLag: eventLoopLagP99Ms <= 100,
    queuesBounded: samples.every(queueBounded),
    indicatorsHealthy: indicatorRuntimeCount === 64
      && indicatorDefinitionCount === 128
      && indicatorIssueCount === 0,
    noSilentTransportFailure: itemFailures === 0 && parseErrors === 0,
    authoritativeBarsExact: sentClosed + sentAmended > 0
      && sentClosed === receivedClosed
      && sentAmended === receivedAmended
      && committedAuthoritative === receivedClosed + receivedAmended,
  };
  return {
    result: Object.values(gates).every(Boolean) ? "pass" : "fail",
    gates,
    measurements: {
      durationMs,
      sampleCount: samples.length,
      heap: {
        ...heap,
        gate30MinuteGrowthPercent: heap30MinuteGrowthPercent,
        retainedPlateau: heapPlateau,
      },
      rendererPrivate: {
        ...rendererPrivate,
        retainedPlateau: rendererPrivatePlateau,
      },
      backendPrivate: {
        ...backendPrivate,
        gateOneHourGrowthPercent: backendOneHourGrowthPercent,
        retainedPlateau: backendPrivatePlateau,
      },
      inputP95Ms: percentile(inputLatencies, 0.95),
      inputCount: inputLatencies.length,
      globalLongTasksPerMinute,
      focusLongTasksPerMinute,
      eventLoopLagP99Ms,
      indicatorRuntimeCount,
      indicatorDefinitionCount,
      indicatorIssueCount,
      itemFailures,
      parseErrors,
      authoritative: {
        sentClosed,
        sentAmended,
        receivedClosed,
        receivedAmended,
        committedAuthoritative,
      },
    },
  };
}
