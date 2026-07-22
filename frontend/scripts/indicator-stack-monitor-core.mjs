const BACKGROUND_REASONS = new Set([
  "background_gap_audit",
  "related_interval_warmup",
]);
const STALLED_GATE_THRESHOLD_MS = 10_000;

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reasonParts(value) {
  return String(value || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isForegroundBackfillReason(value) {
  const parts = reasonParts(value);
  return parts.length === 0 || parts.some((part) => !BACKGROUND_REASONS.has(part));
}

function compactBackfillState(item) {
  const state = plainRecord(item);
  return {
    series: state.series || null,
    requestId: state.request_id || null,
    reason: state.reason || null,
    priority: finiteOrNull(state.priority),
    rangeStartMs: finiteOrNull(state.range_start_ms),
    rangeEndMs: finiteOrNull(state.range_end_ms),
    totalChunks: finiteOrNull(state.total_chunks),
    completedChunks: finiteOrNull(state.completed_chunks),
    pendingChunks: finiteOrNull(state.pending_chunks),
    demandCount: finiteOrNull(state.demand_count),
    persistentInterest: Boolean(state.persistent_interest),
    cancelRequested: Boolean(state.cancel_requested),
  };
}

export function compactStorageHealth(payload) {
  const source = plainRecord(payload);
  const scheduler = plainRecord(source.backfill);
  const engine = plainRecord(source.backfill_engine);
  const fetcher = plainRecord(engine.fetcher);
  const exchangeRateLimits = plainRecord(fetcher.exchange_rate_limits);
  const cooldowns = Object.entries(exchangeRateLimits).flatMap(([key, raw]) => {
    const item = plainRecord(raw);
    const remainingSeconds = finiteOrNull(item.cooldown_remaining_seconds) || 0;
    if (remainingSeconds <= 0) return [];
    return [{
      key,
      remainingSeconds,
      lastStatusCode: finiteOrNull(item.last_status_code),
      lastBodyCode: item.last_body_code ?? null,
      retryAfter: item.last_headers?.["retry-after"] ?? null,
    }];
  });
  const active = (Array.isArray(scheduler.active) ? scheduler.active : [])
    .map(compactBackfillState);
  const pending = (Array.isArray(scheduler.pending) ? scheduler.pending : [])
    .map(compactBackfillState);
  const runningChunks = finiteOrNull(scheduler.running_chunks) || 0;
  const readyChunks = finiteOrNull(scheduler.ready_chunks) || 0;
  const maxConcurrency = finiteOrNull(scheduler.max_concurrency);
  const nextDrainInMs = finiteOrNull(scheduler.next_drain_in_ms);
  const foregroundPending = pending.filter((item) => (
    isForegroundBackfillReason(item.reason)
  ));
  const spareCapacity = maxConcurrency != null && runningChunks < maxConcurrency;
  const foregroundUndrained = foregroundPending.length > 0
    && readyChunks > 0
    && spareCapacity
    && nextDrainInMs == null;
  const openGaps = (Array.isArray(source.gap_ledger_open) ? source.gap_ledger_open : [])
    .map((item) => ({
      id: finiteOrNull(item?.id),
      exchange: item?.exchange || null,
      marketType: item?.market_type || null,
      symbol: item?.symbol || null,
      interval: item?.interval || null,
      startMs: finiteOrNull(item?.start_ms),
      endMs: finiteOrNull(item?.end_ms),
      status: item?.status || null,
      reason: item?.reason || null,
      priority: finiteOrNull(item?.priority),
      attempts: finiteOrNull(item?.attempts) || 0,
      lastError: item?.last_error || null,
    }));

  return {
    status: source.status || null,
    openGapCount: finiteOrNull(source.open_gap_count) || 0,
    openGapByStatus: plainRecord(source.open_gap_by_status),
    openGaps,
    scheduler: {
      submitted: finiteOrNull(scheduler.submitted) || 0,
      deduped: finiteOrNull(scheduler.deduped) || 0,
      merged: finiteOrNull(scheduler.merged) || 0,
      priorityPromotions: finiteOrNull(scheduler.priority_promotions) || 0,
      backgroundDispatches: finiteOrNull(scheduler.background_dispatches) || 0,
      rateLimitedSkips: finiteOrNull(scheduler.rate_limited_skips) || 0,
      readyChunks,
      runningChunks,
      maxConcurrency,
      nextDrainInMs,
      foregroundUndrained,
      active,
      pending,
      foregroundPending,
    },
    cooldowns,
    fetcher: {
      concurrency: finiteOrNull(fetcher.concurrency),
      globalConcurrency: finiteOrNull(fetcher.global_concurrency),
      lastHistoryRequest: plainRecord(fetcher.last_history_request),
    },
  };
}

export function compactIndicatorDiagnostics(payload) {
  const source = plainRecord(payload);
  const registry = plainRecord(source.registry);
  const engine = plainRecord(source.engine);
  const websocket = plainRecord(source.websocket);
  const executors = plainRecord(source.executors);
  const rangeCache = plainRecord(source.rangeCache);
  return {
    ok: source.ok === true,
    schemaVersion: finiteOrNull(source.schemaVersion),
    registryCount: finiteOrNull(registry.count) || 0,
    indicators: Array.isArray(registry.indicators) ? registry.indicators : [],
    engine: {
      started: engine.started === true,
      instanceCount: finiteOrNull(engine.instance_count) || 0,
      streamCount: finiteOrNull(engine.stream_count) || 0,
      listenerCount: finiteOrNull(engine.listener_count) || 0,
      instances: (Array.isArray(engine.instances) ? engine.instances : []).map((item) => ({
        key: item?.key || null,
        indicator: item?.indicator || null,
        exchange: item?.exchange || null,
        symbol: item?.symbol || null,
        interval: item?.interval || null,
        initialized: item?.initialized === true,
        barCount: finiteOrNull(item?.bar_count) || 0,
        refcount: finiteOrNull(item?.refcount) || 0,
        firstCommitted: finiteOrNull(item?.first_committed),
        lastCommitted: finiteOrNull(item?.last_committed),
      })),
    },
    websocket: {
      maxSubscriptions: finiteOrNull(websocket.maxSubscriptions),
      queueSize: finiteOrNull(websocket.queueSize),
      metrics: plainRecord(websocket.metrics),
    },
    executors: Object.fromEntries(Object.entries(executors).map(([key, raw]) => {
      const item = plainRecord(raw);
      return [key, {
        maxWorkers: finiteOrNull(item.max_workers),
        submitted: finiteOrNull(item.submitted) || 0,
        active: finiteOrNull(item.active) || 0,
        pending: finiteOrNull(item.pending) || 0,
        completed: finiteOrNull(item.completed) || 0,
        failed: finiteOrNull(item.failed) || 0,
        avgQueueWaitMs: finiteOrNull(item.avg_queue_wait_ms),
        maxQueueWaitMs: finiteOrNull(item.max_queue_wait_ms),
        avgRunMs: finiteOrNull(item.avg_run_ms),
        maxRunMs: finiteOrNull(item.max_run_ms),
      }];
    })),
    rangeCache: {
      enabled: rangeCache.enabled === true,
      entries: finiteOrNull(rangeCache.entries) || 0,
      inFlight: finiteOrNull(rangeCache.inFlight) || 0,
      hits: finiteOrNull(rangeCache.hits) || 0,
      misses: finiteOrNull(rangeCache.misses) || 0,
      computes: finiteOrNull(rangeCache.computes) || 0,
      singleflightJoins: finiteOrNull(rangeCache.singleflightJoins) || 0,
      barsQueries: finiteOrNull(rangeCache.barsQueries) || 0,
      barsDeltaQueries: finiteOrNull(rangeCache.barsDeltaQueries) || 0,
      barsDeltaRowsReused: finiteOrNull(rangeCache.barsDeltaRowsReused) || 0,
    },
  };
}

export function compactDebugSnapshot(payload) {
  const source = plainRecord(payload);
  const cache = plainRecord(source.cache);
  const query = plainRecord(source.query_engine);
  const eventBus = plainRecord(source.event_bus);
  const coordinator = plainRecord(source.coordinator);
  const runtime = plainRecord(source.runtime);
  return {
    started: source.started === true,
    cache: {
      totalSeries: finiteOrNull(cache.total_series) || 0,
      totalBars: finiteOrNull(cache.total_bars) || 0,
      hits: finiteOrNull(cache.hits) || 0,
      misses: finiteOrNull(cache.misses) || 0,
    },
    query: {
      totalQueries: finiteOrNull(query.total_queries) || 0,
      cacheHits: finiteOrNull(query.cache_hits) || 0,
      storageReads: finiteOrNull(query.storage_reads) || 0,
      storageRows: finiteOrNull(query.storage_rows) || 0,
      storageReadMs: finiteOrNull(query.storage_read_ms),
      storageFailures: finiteOrNull(query.storage_failures) || 0,
      backfillsTriggered: finiteOrNull(query.backfills_triggered) || 0,
    },
    eventBus: {
      eventsEmitted: finiteOrNull(eventBus.events_emitted) || 0,
      eventsDropped: finiteOrNull(eventBus.events_dropped) || 0,
      callbackErrors: finiteOrNull(eventBus.callback_errors) || 0,
    },
    streams: {
      active: finiteOrNull(coordinator.active_streams) || 0,
      items: (Array.isArray(coordinator.streams) ? coordinator.streams : []).map((item) => ({
        exchange: item?.exchange || null,
        marketType: item?.market_type || null,
        symbol: item?.symbol || null,
        interval: item?.interval || null,
        status: item?.status || null,
        subscribers: finiteOrNull(item?.subscriber_count) || 0,
        barsReceived: finiteOrNull(item?.bars_received) || 0,
        lastBarAtMs: finiteOrNull(item?.last_bar_at_ms),
        error: item?.error || null,
      })),
    },
    eventLoopLag: plainRecord(runtime.event_loop_lag),
  };
}

export function assessIndicatorStackSample(sample) {
  const issues = new Set();
  const frontend = plainRecord(sample?.frontend);
  const browser = plainRecord(sample?.browser);
  const runtimes = Array.isArray(frontend.runtimes) ? frontend.runtimes : [];
  if (runtimes.length === 0 && browser.readyState === "complete" && browser.barCount > 0) {
    issues.add("frontend-indicator-diagnostics-unavailable");
  }
  for (const runtime of runtimes) {
    for (const issue of Array.isArray(runtime?.issues) ? runtime.issues : []) {
      issues.add(String(issue));
    }
  }

  const backend = plainRecord(sample?.backend);
  for (const [name, endpoint] of Object.entries(backend)) {
    if (endpoint?.error) issues.add(`backend-${name}-unavailable`);
  }
  const storage = plainRecord(backend.storage);
  const scheduler = plainRecord(storage.scheduler);
  if (scheduler.foregroundUndrained === true) {
    issues.add("scheduler-foreground-undrained");
  }
  if (Array.isArray(storage.cooldowns) && storage.cooldowns.length > 0) {
    issues.add("upstream-rate-limit-cooldown");
  }

  const debug = plainRecord(backend.debug);
  if ((finiteOrNull(debug.eventLoopLag?.p95_ms) || 0) > 100) {
    issues.add("backend-event-loop-lag-high");
  }
  if (Array.isArray(debug.streams?.items) && debug.streams.items.some((item) => item.error)) {
    issues.add("backend-stream-error");
  }

  return Array.from(issues).sort();
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

function sumNumericLeaves(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((total, item) => total + sumNumericLeaves(item), 0);
}

function firstAndLast(samples, selector) {
  const values = samples.map(selector).filter((value) => value != null);
  return { first: values.at(0) ?? null, last: values.at(-1) ?? null };
}

function positiveDelta(samples, selector) {
  const { first, last } = firstAndLast(samples, selector);
  if (first == null || last == null) return 0;
  return Math.max(0, Number(last) - Number(first));
}

function sampleGateSet(sample) {
  return new Set((sample.frontend?.runtimes || []).flatMap((runtime) => (
    Array.isArray(runtime?.gates) ? runtime.gates.map(String) : []
  )));
}

function longestGateDurations(samples) {
  const durations = {};
  const activeSince = new Map();
  const lastSeen = new Map();
  for (const sample of samples) {
    const atMs = Number(sample.atMs);
    if (!Number.isFinite(atMs)) continue;
    const current = sampleGateSet(sample);
    for (const gate of Array.from(activeSince.keys())) {
      if (current.has(gate)) continue;
      const start = activeSince.get(gate);
      const end = lastSeen.get(gate) ?? atMs;
      durations[gate] = Math.max(durations[gate] || 0, end - start);
      activeSince.delete(gate);
      lastSeen.delete(gate);
    }
    for (const gate of current) {
      if (!activeSince.has(gate)) activeSince.set(gate, atMs);
      lastSeen.set(gate, atMs);
    }
  }
  for (const [gate, start] of activeSince) {
    durations[gate] = Math.max(durations[gate] || 0, (lastSeen.get(gate) ?? start) - start);
  }
  return durations;
}

function hasCurrentSeriesOpenGap(sample) {
  const runtimes = Array.isArray(sample.frontend?.runtimes) ? sample.frontend.runtimes : [];
  const gaps = Array.isArray(sample.backend?.storage?.openGaps)
    ? sample.backend.storage.openGaps
    : [];
  return runtimes.some((runtime) => gaps.some((gap) => (
    String(gap.exchange || "").toLowerCase()
      === String(runtime.context?.exchange || "").toLowerCase()
    && String(gap.marketType || "").toLowerCase()
      === String(runtime.context?.marketType || "").toLowerCase()
    && String(gap.symbol || "").toUpperCase()
      === String(runtime.context?.symbol || "").toUpperCase()
    && String(gap.interval || "") === String(runtime.context?.interval || "")
  )));
}

function longestBooleanDuration(samples, predicate) {
  let longest = 0;
  let startedAt = null;
  let lastSeenAt = null;
  for (const sample of samples) {
    const atMs = Number(sample.atMs);
    if (!Number.isFinite(atMs)) continue;
    if (predicate(sample)) {
      startedAt ??= atMs;
      lastSeenAt = atMs;
      continue;
    }
    if (startedAt != null) longest = Math.max(longest, (lastSeenAt ?? atMs) - startedAt);
    startedAt = null;
    lastSeenAt = null;
  }
  if (startedAt != null) longest = Math.max(longest, (lastSeenAt ?? startedAt) - startedAt);
  return longest;
}

export function summarizeIndicatorStackMonitoring({
  startedAtMs,
  endedAtMs,
  samples = [],
  events = [],
  eventCounts = {},
  indicatorRange = {},
}) {
  const issueOccurrences = samples.flatMap((sample) => sample.issues || []);
  const networkLogicalCodes = plainRecord(indicatorRange.logicalCodes);
  const consoleErrors = events.filter((event) => event.type === "console-error");
  const runtimeExceptions = events.filter((event) => event.type === "runtime-exception");
  const networkFailures = events.filter((event) => (
    event.type === "network-failure" && event.canceled !== true
  ));
  const wsFrames = events.filter((event) => (
    event.type === "websocket-frame" && event.appOwned !== false
  ));
  const websocketErrors = events.filter((event) => (
    event.type === "websocket-error" && event.appOwned !== false
  ));
  const unrecoveredWebsocketErrors = websocketErrors.filter((error) => !wsFrames.some((frame) => (
    frame.atMs > error.atMs
    && frame.url === error.url
    && frame.direction === "received"
  )));
  const consoleErrorCount = Number(eventCounts["console-error"] ?? consoleErrors.length) || 0;
  const runtimeExceptionCount = Number(
    eventCounts["runtime-exception"] ?? runtimeExceptions.length,
  ) || 0;
  const networkFailureCount = Number(
    eventCounts["network-failure"] ?? networkFailures.length,
  ) || 0;
  const websocketFrameCount = Number(
    eventCounts["websocket-frame"] ?? wsFrames.length,
  ) || 0;
  const websocketErrorCount = Number(
    eventCounts["websocket-error"] ?? websocketErrors.length,
  ) || 0;
  const nonOkIndicatorResponses = Object.entries(networkLogicalCodes)
    .filter(([code]) => !["OK", "UNAVAILABLE"].includes(code))
    .reduce((total, [, count]) => total + Number(count || 0), 0);
  const issueCounts = countBy(issueOccurrences);
  if (consoleErrorCount > 0) issueCounts["browser-console-errors"] = consoleErrorCount;
  if (runtimeExceptionCount > 0) {
    issueCounts["browser-runtime-exceptions"] = runtimeExceptionCount;
  }
  if (networkFailureCount > 0) issueCounts["browser-network-failures"] = networkFailureCount;
  if (unrecoveredWebsocketErrors.length > 0) {
    issueCounts["browser-websocket-errors"] = unrecoveredWebsocketErrors.length;
  }
  if (nonOkIndicatorResponses > 0) {
    issueCounts["indicator-range-logical-errors"] = nonOkIndicatorResponses;
  }
  const websocketSendErrorDelta = positiveDelta(samples, (sample) => sumNumericLeaves(
    sample.backend?.indicators?.websocket?.metrics?.send_errors,
  ));
  const websocketSendTimeoutDelta = positiveDelta(samples, (sample) => sumNumericLeaves(
    sample.backend?.indicators?.websocket?.metrics?.send_timeouts,
  ));
  const executorFailureDelta = positiveDelta(samples, (sample) => sumNumericLeaves(
    Object.fromEntries(Object.entries(sample.backend?.indicators?.executors || {}).map(
      ([key, item]) => [key, item?.failed || 0],
    )),
  ));
  const eventBusDropDelta = positiveDelta(
    samples,
    (sample) => sample.backend?.debug?.eventBus?.eventsDropped,
  );
  const eventCallbackErrorDelta = positiveDelta(
    samples,
    (sample) => sample.backend?.debug?.eventBus?.callbackErrors,
  );
  if (websocketSendErrorDelta > 0) {
    issueCounts["indicator-websocket-send-errors"] = websocketSendErrorDelta;
  }
  if (websocketSendTimeoutDelta > 0) {
    issueCounts["indicator-websocket-send-timeouts"] = websocketSendTimeoutDelta;
  }
  if (executorFailureDelta > 0) issueCounts["indicator-executor-failures"] = executorFailureDelta;
  if (eventBusDropDelta > 0) issueCounts["backend-event-bus-drops"] = eventBusDropDelta;
  if (eventCallbackErrorDelta > 0) {
    issueCounts["backend-event-callback-errors"] = eventCallbackErrorDelta;
  }
  const gateDurationsMs = longestGateDurations(samples);
  const stalledGateIssues = {
    "initial-history-pending": "initial-history-stalled",
    "history-window-pending": "history-window-stalled",
    "initial-hydration-unsettled": "initial-hydration-stalled",
  };
  for (const [gate, durationMs] of Object.entries(gateDurationsMs)) {
    const issue = stalledGateIssues[gate];
    if (issue && durationMs >= STALLED_GATE_THRESHOLD_MS) issueCounts[issue] = durationMs;
  }
  const currentSeriesOpenGapMs = longestBooleanDuration(samples, hasCurrentSeriesOpenGap);
  if (currentSeriesOpenGapMs >= STALLED_GATE_THRESHOLD_MS) {
    issueCounts["current-series-kline-gap-stalled"] = currentSeriesOpenGapMs;
  }
  return {
    schemaVersion: 1,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, Number(endedAtMs) - Number(startedAtMs)),
    sampleCount: samples.length,
    issueCounts,
    clean: Object.keys(issueCounts).length === 0,
    indicatorRange,
    browser: {
      consoleErrors: consoleErrorCount,
      runtimeExceptions: runtimeExceptionCount,
      networkFailures: networkFailureCount,
      websocketFrames: websocketFrameCount,
      websocketErrors: websocketErrorCount,
      unrecoveredWebsocketErrors: unrecoveredWebsocketErrors.length,
    },
    eventCounts: { ...eventCounts },
    counterDeltas: {
      websocketSendErrors: websocketSendErrorDelta,
      websocketSendTimeouts: websocketSendTimeoutDelta,
      executorFailures: executorFailureDelta,
      eventBusDrops: eventBusDropDelta,
      eventCallbackErrors: eventCallbackErrorDelta,
    },
    gateDurationsMs,
    backendGateDurationsMs: {
      currentSeriesOpenGap: currentSeriesOpenGapMs,
    },
    firstSample: samples.at(0) || null,
    lastSample: samples.at(-1) || null,
  };
}

export function formatIndicatorStackMarkdown(summary) {
  const issueLines = Object.entries(summary.issueCounts || {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([issue, count]) => `- ${issue}: ${count}`);
  const last = summary.lastSample || {};
  const runtimes = Array.isArray(last.frontend?.runtimes) ? last.frontend.runtimes : [];
  const runtimeLines = runtimes.flatMap((runtime) => (
    (runtime.indicators || []).map((indicator) => (
      `- ${runtime.context?.marketType || "?"}:${runtime.context?.symbol || "?"}`
      + `@${runtime.context?.interval || "?"} / ${indicator.name}: ${indicator.status}`
      + ` (${indicator.lines?.map((line) => `${line.name}=${line.pointCount}`).join(", ") || "no lines"})`
    ))
  ));
  return [
    "# CandleScope indicator stack monitor",
    "",
    `- Result: ${summary.clean ? "clean" : "issues detected"}`,
    `- Duration: ${summary.durationMs} ms`,
    `- Samples: ${summary.sampleCount}`,
    `- Indicator range requests: ${summary.indicatorRange?.requestCount || 0}`,
    `- Indicator response bytes: ${summary.indicatorRange?.totalEncodedBytes || 0}`,
    `- WebSocket frames: ${summary.browser?.websocketFrames || 0}`,
    `- Latest open storage gaps: ${last.backend?.storage?.openGapCount || 0}`,
    "",
    "## Issues",
    "",
    ...(issueLines.length ? issueLines : ["- none"]),
    "",
    "## Latest indicator coverage",
    "",
    ...(runtimeLines.length ? runtimeLines : ["- no frontend runtime snapshot"]),
    "",
    "## Gate durations",
    "",
    "```json",
    JSON.stringify({
      frontend: summary.gateDurationsMs || {},
      backend: summary.backendGateDurationsMs || {},
    }, null, 2),
    "```",
    "",
    "## Latest scheduler",
    "",
    "```json",
    JSON.stringify(last.backend?.storage?.scheduler || null, null, 2),
    "```",
    "",
    "## Indicator range logical codes",
    "",
    "```json",
    JSON.stringify(summary.indicatorRange?.logicalCodes || {}, null, 2),
    "```",
    "",
  ].join("\n");
}
