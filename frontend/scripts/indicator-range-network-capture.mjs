const INDICATOR_RANGE_PATHS = new Set([
  "/api/v1/indicators/range",
  "/api/v1/indicators/range/batch",
]);

export const INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS = Object.freeze({
  maxTotalBufferSize: 128 * 1024 * 1024,
  maxResourceBufferSize: 64 * 1024 * 1024,
  maxPostDataSize: 4 * 1024 * 1024,
});

function unwrapCdpResult(value) {
  if (value && typeof value === "object" && Number.isFinite(value.id) && "result" in value) {
    return value.result;
  }
  return value;
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function responseText(result) {
  if (!result || typeof result.body !== "string") return "";
  return result.base64Encoded
    ? Buffer.from(result.body, "base64").toString("utf8")
    : result.body;
}

function isIndicatorRangeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return INDICATOR_RANGE_PATHS.has(url.pathname.replace(/\/+$/, ""));
  } catch {
    return false;
  }
}

function countBy(records, selector) {
  const counts = {};
  for (const record of records) {
    const value = selector(record);
    if (value == null || value === "") continue;
    const key = String(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicRecord(record) {
  const body = record.requestBody || {};
  const start = finiteOrNull(body.start);
  const end = finiteOrNull(body.end);
  const batchItems = (Array.isArray(body.requests) ? body.requests : body.items || [])
    .map((item) => {
      const itemStart = finiteOrNull(item?.start);
      const itemEnd = finiteOrNull(item?.end);
      if (itemStart == null || itemEnd == null) return null;
      return {
        clientId: item.clientId ?? null,
        indicator: item.name || item.customId || item.clientId || null,
        reason: item.reason || body.reason || "unspecified",
        start: itemStart,
        end: itemEnd,
      };
    })
    .filter(Boolean);
  return {
    sequence: record.sequence,
    phase: record.phase,
    requestId: record.requestId,
    startedAtMs: record.startedAtMs,
    finishedAtMs: record.finishedAtMs ?? null,
    durationMs: record.finishedAtMs != null
      ? Math.max(0, record.finishedAtMs - record.startedAtMs)
      : null,
    method: record.method,
    url: record.url,
    postData: record.postData ?? null,
    requestBody: record.requestBody ?? null,
    clientId: body.clientId ?? null,
    indicator: body.name || body.customId || body.clientId || null,
    reason: body.reason || "unspecified",
    requestedRange: start != null && end != null ? { start, end } : null,
    batchSize: batchItems.length,
    batchItems,
    status: finiteOrNull(record.status),
    encodedDataLength: finiteOrNull(record.encodedDataLength) ?? 0,
    fromDiskCache: Boolean(record.fromDiskCache),
    fromServiceWorker: Boolean(record.fromServiceWorker),
    logicalOk: typeof record.logicalOk === "boolean" ? record.logicalOk : null,
    logicalCode: record.logicalCode || null,
    responseRange: record.responseRange || null,
    failed: Boolean(record.failed),
    canceled: Boolean(record.canceled),
    errorText: record.errorText || null,
    requestPostDataError: record.requestPostDataError || null,
    responseBodyError: record.responseBodyError || null,
  };
}

export function summarizeIndicatorRangeRequests(records = [], {
  phase = null,
  phasePrefix = null,
} = {}) {
  const normalized = records
    .map((record) => (record.requestBody !== undefined ? publicRecord(record) : record))
    .filter((record) => {
      if (phase != null && record.phase !== phase) return false;
      if (phasePrefix != null && !String(record.phase || "").startsWith(phasePrefix)) return false;
      return true;
    });
  const totalEncodedBytes = normalized.reduce(
    (total, record) => total + Math.max(0, Number(record.encodedDataLength) || 0),
    0,
  );
  const requestedRanges = normalized.flatMap((record) => {
    if (Array.isArray(record.batchItems) && record.batchItems.length > 0) {
      return record.batchItems;
    }
    if (!record.requestedRange) return [];
    return [{
      clientId: record.clientId,
      indicator: record.indicator,
      reason: record.reason,
      ...record.requestedRange,
    }];
  });
  const logicalCodeFor = (record) => (
    record.logicalCode
    || (record.logicalOk === true ? "OK" : record.logicalOk === false ? "ERROR_WITHOUT_CODE" : "UNAVAILABLE")
  );

  return {
    requestCount: normalized.length,
    logicalRequestCount: requestedRanges.length,
    completedCount: normalized.filter((record) => record.finishedAtMs != null && !record.failed).length,
    failedCount: normalized.filter((record) => record.failed).length,
    canceledCount: normalized.filter((record) => record.canceled).length,
    totalEncodedBytes,
    requestedRanges,
    reasons: countBy(normalized, (record) => record.reason),
    statuses: countBy(normalized, (record) => record.status),
    logicalCodes: countBy(normalized, logicalCodeFor),
    phases: countBy(normalized, (record) => record.phase),
  };
}

export function createIndicatorRangeNetworkCapture(cdp, {
  initialPhase = "startup",
  now = () => Date.now(),
} = {}) {
  const records = new Map();
  const pending = new Set();
  const active = new Set();
  let sequence = 0;
  let phase = initialPhase;
  let lastActivityMs = now();

  const touch = () => {
    lastActivityMs = now();
  };

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  };

  const readRequestPostData = (record) => track((async () => {
    try {
      const raw = await cdp.send("Network.getRequestPostData", { requestId: record.requestId });
      const result = unwrapCdpResult(raw);
      if (typeof result?.postData === "string") {
        record.postData = result.postData;
        record.requestBody = parseJson(result.postData);
      }
    } catch (error) {
      record.requestPostDataError = error?.message || String(error);
    }
  })());

  const readResponseBody = (record) => track((async () => {
    try {
      const raw = await cdp.send("Network.getResponseBody", { requestId: record.requestId });
      const text = responseText(unwrapCdpResult(raw));
      const body = parseJson(text);
      if (body && typeof body === "object") {
        record.logicalOk = typeof body.ok === "boolean" ? body.ok : null;
        record.logicalCode = body.code
          || (body.ok === true ? "OK" : body.ok === false ? "ERROR_WITHOUT_CODE" : null);
        record.responseRange = body.range || body.detail?.range || null;
      }
    } catch (error) {
      record.responseBodyError = error?.message || String(error);
    }
  })());

  cdp.on("Network.requestWillBeSent", (event) => {
    const requestId = event?.requestId;
    const request = event?.request;
    if (
      !requestId
      || String(request?.method || "").toUpperCase() !== "POST"
      || !isIndicatorRangeUrl(request?.url)
    ) return;
    sequence += 1;
    const postData = typeof request.postData === "string" ? request.postData : null;
    const record = {
      sequence,
      phase,
      requestId,
      startedAtMs: now(),
      method: request.method || "POST",
      url: request.url,
      postData,
      requestBody: parseJson(postData),
      status: null,
      encodedDataLength: 0,
      failed: false,
      canceled: false,
    };
    records.set(requestId, record);
    active.add(requestId);
    touch();
    if (!postData && request.hasPostData) readRequestPostData(record);
  });

  cdp.on("Network.responseReceived", (event) => {
    const record = records.get(event?.requestId);
    if (!record) return;
    const response = event.response || {};
    record.status = response.status;
    record.fromDiskCache = response.fromDiskCache;
    record.fromServiceWorker = response.fromServiceWorker;
    record.encodedDataLength = Math.max(
      Number(record.encodedDataLength) || 0,
      Number(response.encodedDataLength) || 0,
    );
    touch();
  });

  cdp.on("Network.loadingFinished", (event) => {
    const record = records.get(event?.requestId);
    if (!record) return;
    record.finishedAtMs = now();
    record.encodedDataLength = Math.max(0, Number(event.encodedDataLength) || 0);
    active.delete(event.requestId);
    touch();
    readResponseBody(record);
  });

  cdp.on("Network.loadingFailed", (event) => {
    const record = records.get(event?.requestId);
    if (!record) return;
    record.finishedAtMs = now();
    record.failed = true;
    record.canceled = Boolean(event.canceled || event.errorText === "net::ERR_ABORTED");
    record.errorText = event.errorText || null;
    active.delete(event.requestId);
    touch();
  });

  const flush = async (timeoutMs = 5_000) => {
    const deadline = now() + Math.max(0, timeoutMs);
    while (pending.size > 0 && now() < deadline) {
      await Promise.race([
        Promise.allSettled(Array.from(pending)),
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
    }
    return pending.size === 0;
  };

  const waitForIdle = async ({ quietMs = 1_000, timeoutMs = 10_000 } = {}) => {
    const deadline = now() + Math.max(0, timeoutMs);
    while (now() < deadline) {
      if (active.size === 0 && now() - lastActivityMs >= quietMs) {
        await flush(Math.max(0, deadline - now()));
        return active.size === 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await flush(250);
    return false;
  };

  const getRecords = () => Array.from(records.values())
    .sort((left, right) => left.sequence - right.sequence)
    .map(publicRecord);

  return {
    startPhase(nextPhase) {
      phase = String(nextPhase || "unlabeled");
      touch();
      return phase;
    },
    currentPhase() {
      return phase;
    },
    flush,
    waitForIdle,
    records: getRecords,
    summary(options = {}) {
      return summarizeIndicatorRangeRequests(getRecords(), options);
    },
  };
}
