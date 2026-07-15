export const DRAWING_PERFORMANCE_RESET_STORAGE_TYPES = "indexeddb,local_storage";
export const DRAWING_PERFORMANCE_RELOAD_MARKER_KEY =
  "__CANDLESCOPE_DRAWING_PERF_RELOAD_GENERATION__";

let drawingPerformanceReloadSequence = 0;

function nextDrawingPerformanceReloadToken() {
  drawingPerformanceReloadSequence += 1;
  return `drawing-perf-reload-${Date.now()}-${drawingPerformanceReloadSequence}`;
}

function runtimeEvaluationValue(response) {
  const result = response?.result?.result;
  if (result?.subtype === "error") {
    throw new Error(result.description || result.value || "Runtime.evaluate failed");
  }
  if (response?.result?.exceptionDetails) {
    throw new Error(
      response.result.exceptionDetails.text || "Runtime.evaluate exception",
    );
  }
  return result?.value;
}

function drawingPerformanceReloadMarkerSource(token) {
  return `(() => {
    const marker = Object.freeze({
      token: ${JSON.stringify(token)},
      timeOrigin: Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
      href: location.href
    });
    Object.defineProperty(window, ${JSON.stringify(DRAWING_PERFORMANCE_RELOAD_MARKER_KEY)}, {
      value: marker,
      configurable: false,
      enumerable: false,
      writable: false
    });
  })();`;
}

async function readDrawingPerformanceDocumentGeneration(cdp) {
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const marker = window[${JSON.stringify(DRAWING_PERFORMANCE_RELOAD_MARKER_KEY)}];
      return JSON.stringify({
        token: typeof marker?.token === "string" ? marker.token : null,
        markerTimeOrigin: Number.isFinite(marker?.timeOrigin) ? marker.timeOrigin : null,
        timeOrigin: Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
        href: location.href,
        readyState: document.readyState
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const raw = runtimeEvaluationValue(response);
  if (typeof raw !== "string") {
    throw new Error("Drawing performance document generation is unavailable");
  }
  const generation = JSON.parse(raw);
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) {
    throw new Error("Drawing performance document generation is invalid");
  }
  return generation;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function drawingPerformanceOrigin(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch (error) {
    throw new TypeError("Drawing performance URL must be an absolute URL", { cause: error });
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.origin === "null") {
    throw new TypeError("Drawing performance URL must use an HTTP(S) origin");
  }
  return parsed.origin;
}

export function drawingPerformanceStorageResetRequest(url) {
  return Object.freeze({
    origin: drawingPerformanceOrigin(url),
    storageTypes: DRAWING_PERFORMANCE_RESET_STORAGE_TYPES,
  });
}

/**
 * Reset the isolated benchmark origin before its next-document bootstrap runs.
 * The production repository prefers canonical IndexedDB records over the
 * legacy localStorage compatibility snapshot, so both stores must be cleared
 * between iterations or a previous mutation can shadow the next fixture.
 */
export async function resetDrawingPerformanceOriginStorage(cdp, url) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new TypeError("Drawing performance CDP client is unavailable");
  }
  const request = drawingPerformanceStorageResetRequest(url);
  try {
    await cdp.send("Storage.clearDataForOrigin", request);
  } catch (error) {
    throw new Error(
      `Drawing performance origin storage reset failed for ${request.origin}`,
      { cause: error },
    );
  }
  return request;
}

export async function navigateToDrawingPerformanceScenario(cdp, originUrl, navigationUrl) {
  const resetRequest = await resetDrawingPerformanceOriginStorage(cdp, originUrl);
  const navigation = await cdp.send("Page.navigate", { url: navigationUrl });
  return Object.freeze({ resetRequest, navigation });
}

/**
 * Reload and prove that Runtime.evaluate has crossed into the new main-world
 * document before any readiness predicate can observe the previous page.
 * The unique script is installed immediately before Page.reload, so its token
 * cannot exist in the old document. Cleanup is mandatory on every outcome.
 */
export async function reloadFreshDrawingPerformanceDocument(cdp, {
  timeoutMs,
  pollIntervalMs = 25,
  markerToken = nextDrawingPerformanceReloadToken(),
  now = Date.now,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new TypeError("Drawing performance CDP client is unavailable");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Drawing performance reload timeout must be positive");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("Drawing performance reload poll interval must be non-negative");
  }
  if (typeof markerToken !== "string" || markerToken.length === 0) {
    throw new TypeError("Drawing performance reload marker must be a non-empty string");
  }

  const previous = await readDrawingPerformanceDocumentGeneration(cdp);
  const installed = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: drawingPerformanceReloadMarkerSource(markerToken),
  });
  const identifier = installed?.result?.identifier;
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("Drawing performance reload marker installation failed");
  }

  let receipt = null;
  let failure = null;
  const startedAt = now();
  let latest = null;
  let lastEvaluationError = null;
  try {
    await cdp.send("Page.reload", { ignoreCache: true });
    while (now() - startedAt < timeoutMs) {
      try {
        latest = await readDrawingPerformanceDocumentGeneration(cdp);
        lastEvaluationError = null;
        if (latest.token === markerToken) {
          receipt = Object.freeze({
            markerToken,
            previousTimeOrigin: previous.timeOrigin ?? null,
            currentTimeOrigin: latest.timeOrigin ?? null,
            href: typeof latest.href === "string" ? latest.href : null,
            readyState: typeof latest.readyState === "string" ? latest.readyState : null,
            waitedMs: Math.max(0, now() - startedAt),
          });
          break;
        }
      } catch (error) {
        // The old execution context is expected to disappear during reload.
        // Only a matching marker can complete the wait; persistent errors end
        // in the same fail-closed timeout with their final message attached.
        lastEvaluationError = error;
      }
      await wait(pollIntervalMs);
    }
    if (!receipt) {
      throw new Error(`Drawing performance reload did not reach a fresh document: ${JSON.stringify({
        markerToken,
        previous,
        latest,
        lastEvaluationError: lastEvaluationError
          ? errorMessage(lastEvaluationError)
          : null,
      })}`);
    }
  } catch (error) {
    failure = error;
  }

  let cleanupFailure = null;
  try {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure && cleanupFailure) {
    throw new Error(
      `Drawing performance reload failed (${errorMessage(failure)}) and its marker could not be removed`,
      { cause: cleanupFailure },
    );
  }
  if (cleanupFailure) {
    throw new Error("Drawing performance reload marker cleanup failed", {
      cause: cleanupFailure,
    });
  }
  if (failure) throw failure;
  return receipt;
}
