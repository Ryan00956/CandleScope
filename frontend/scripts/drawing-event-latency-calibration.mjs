import { createHash } from "node:crypto";

import {
  DRAWING_EVENT_LATENCY_INPUT_TYPES,
  parseDrawingEventLatencyTrace,
} from "./drawing-event-latency-trace.mjs";
import { DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT } from "./drawing-soak-metrics.mjs";

const EVENT_LATENCY_ACQUISITION_LIMITS = Object.freeze({
  parserSchemaVersion: "drawing-event-latency-trace/v1",
  dispatchDeadlineMs: 30_000,
  streamDeadlineMs: 30_000,
  streamChunkBytes: 1_048_576,
  traceExcludedCategories: Object.freeze(["*"]),
});

const CALIBRATION_CONFIGURATION = DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.configuration;

class CalibrationDeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalibrationDeadlineError";
  }
}

class CalibrationDispatchAbortedError extends Error {
  constructor() {
    super("event latency calibration dispatch was aborted");
    this.name = "CalibrationDispatchAbortedError";
  }
}

function emptyDispatchCounts() {
  return Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [inputType, 0]),
  );
}

function expectedDispatchCounts() {
  return Object.fromEntries(
    DRAWING_EVENT_LATENCY_INPUT_TYPES.map((inputType) => [
      inputType,
      CALIBRATION_CONFIGURATION.dispatchesPerType,
    ]),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function withDeadline(promise, deadlineMs, label, onTimeout = null) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new CalibrationDeadlineError(
          `${label} exceeded the ${deadlineMs}ms deadline`,
        ));
      }, deadlineMs);
    }),
  ]);
}

async function sendCdp(cdp, method, params = {}) {
  const response = await cdp.send(method, params);
  if (response === null
    || typeof response !== "object"
    || !Object.hasOwn(response, "result")
    || response.result === null
    || typeof response.result !== "object") {
    throw new Error(`CDP ${method} did not return a result envelope`);
  }
  return response.result;
}

function validRect(rect) {
  return rect !== null
    && typeof rect === "object"
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 32
    && rect.height > 32;
}

function assertDispatchActive(control) {
  if (control.aborted) throw new CalibrationDispatchAbortedError();
}

async function dispatchCalibrationInputs(
  cdp,
  rect,
  waitForAnimationFrame,
  counts,
  state,
  control,
) {
  if (!validRect(rect)) throw new Error("event latency calibration plot rect is invalid");
  if (typeof waitForAnimationFrame !== "function") {
    throw new TypeError("event latency calibration requires an animation-frame waiter");
  }
  const cycles = CALIBRATION_CONFIGURATION.dispatchesPerType;
  const y = Math.round(rect.y + rect.height * 0.58);
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    assertDispatchActive(control);
    const direction = cycle % 2 === 0 ? -1 : 1;
    const fromRatio = direction < 0 ? 0.66 : 0.36;
    const toRatio = direction < 0 ? 0.36 : 0.66;
    const fromX = Math.round(rect.x + rect.width * fromRatio);
    const toX = Math.round(rect.x + rect.width * toRatio);
    state.mouse = { x: fromX, y };

    assertDispatchActive(control);
    await sendCdp(cdp, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    state.mouseDown = true;
    counts.pointerdown += 1;
    assertDispatchActive(control);
    await waitForAnimationFrame();
    assertDispatchActive(control);

    state.mouse = { x: toX, y };
    await sendCdp(cdp, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: toX,
      y,
      button: "left",
      buttons: 1,
    });
    counts.pointermove += 1;
    assertDispatchActive(control);
    await waitForAnimationFrame();
    assertDispatchActive(control);

    await sendCdp(cdp, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    state.mouseDown = false;
    counts.pointerup += 1;
    assertDispatchActive(control);
    await waitForAnimationFrame();
    assertDispatchActive(control);

    await sendCdp(cdp, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: toX,
      y,
      deltaX: 0,
      deltaY: direction * 72,
    });
    counts.wheel += 1;
    assertDispatchActive(control);
    await waitForAnimationFrame();
    assertDispatchActive(control);
  }
  // The rAF callback runs before paint/presentation. One additional frame keeps
  // the final wheel's presentation endpoint inside the trace window.
  await waitForAnimationFrame();
  assertDispatchActive(control);
}

async function closeStream(cdp, streamHandle) {
  if (typeof streamHandle !== "string" || streamHandle.length === 0) return;
  await sendCdp(cdp, "IO.close", { handle: streamHandle });
}

function assertStreamActive(control) {
  if (control.aborted) {
    throw new Error("event latency trace stream read was aborted");
  }
}

async function readTraceStream(cdp, streamHandle, control) {
  if (typeof streamHandle !== "string" || streamHandle.length === 0) {
    throw new Error("Tracing.tracingComplete did not provide a stream handle");
  }
  const chunks = [];
  let totalBytes = 0;
  let eof = false;
  while (!eof) {
    assertStreamActive(control);
    const result = await sendCdp(cdp, "IO.read", {
      handle: streamHandle,
      size: EVENT_LATENCY_ACQUISITION_LIMITS.streamChunkBytes,
    });
    assertStreamActive(control);
    if (typeof result.data !== "string" || typeof result.eof !== "boolean") {
      throw new Error("CDP IO.read returned an invalid trace stream chunk");
    }
    const chunk = Buffer.from(result.data, result.base64Encoded === true ? "base64" : "utf8");
    totalBytes += chunk.byteLength;
    if (totalBytes > CALIBRATION_CONFIGURATION.maxTraceBytes) {
      throw new Error(
        `event latency trace exceeded the ${CALIBRATION_CONFIGURATION.maxTraceBytes}`
          + " byte limit",
      );
    }
    chunks.push(chunk);
    eof = result.eof;
  }
  const raw = Buffer.concat(chunks, totalBytes);
  let trace = null;
  try {
    trace = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("event latency trace stream was not valid JSON", { cause: error });
  }
  return {
    trace,
    byteLength: totalBytes,
    chunkCount: chunks.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function traceEventCount(trace) {
  if (Array.isArray(trace)) return trace.length;
  return Array.isArray(trace?.traceEvents) ? trace.traceEvents.length : null;
}

function summarizeParserLatency(parser) {
  const inputTypes = {};
  let passed = parser?.passed === true;
  for (const inputType of DRAWING_EVENT_LATENCY_INPUT_TYPES) {
    const metric = parser?.inputTypes?.[inputType];
    const p95Ms = Number.isFinite(metric?.p95Ms) ? metric.p95Ms : null;
    const p99Ms = Number.isFinite(metric?.p99Ms) ? metric.p99Ms : null;
    const count = Number.isSafeInteger(metric?.count) ? metric.count : null;
    const p95Passed = p95Ms !== null
      && p95Ms <= CALIBRATION_CONFIGURATION.p95ThresholdMs;
    const p99Passed = p99Ms !== null
      && p99Ms <= CALIBRATION_CONFIGURATION.p99ThresholdMs;
    const countPassed = count === CALIBRATION_CONFIGURATION.dispatchesPerType;
    inputTypes[inputType] = {
      count,
      p50Ms: Number.isFinite(metric?.p50Ms) ? metric.p50Ms : null,
      p95Ms,
      p99Ms,
      countPassed,
      p95Passed,
      p99Passed,
      passed: countPassed && p95Passed && p99Passed,
    };
    passed = passed && inputTypes[inputType].passed;
  }
  return { passed, inputTypes };
}

function parserSchemaEvidencePassed(parser) {
  const expectedCount = CALIBRATION_CONFIGURATION.dispatchesPerType;
  const eiaf = parser?.eventsInAnimationFrame;
  return parser?.schemaVersion === EVENT_LATENCY_ACQUISITION_LIMITS.parserSchemaVersion
    && parser?.passed === true
    && parser?.excluded?.hover?.count === 0
    && eiaf?.supported === true
    && eiaf?.passed === true
    && eiaf?.inputTypes?.pointerdown?.count === expectedCount
    && eiaf?.inputTypes?.pointerup?.count === expectedCount;
}

function actualCountsMatchExpected(actual, expected) {
  return DRAWING_EVENT_LATENCY_INPUT_TYPES.every(
    (inputType) => actual[inputType] === expected[inputType],
  );
}

async function runAttempt({
  cdp,
  rect,
  waitForAnimationFrame,
  parseTrace,
  attemptNumber,
}) {
  const startedAt = new Date().toISOString();
  const actualDispatchCounts = emptyDispatchCounts();
  const expected = expectedDispatchCounts();
  const state = {
    mouseDown: false,
    mouse: {
      x: Math.round(rect?.x ?? 0),
      y: Math.round(rect?.y ?? 0),
    },
    startRequested: false,
    startConfirmed: false,
    endRequested: false,
    endConfirmed: false,
    completionObserved: false,
    completion: null,
    streamHandle: null,
    streamClosed: false,
    bufferUsageObserved: false,
    bufferUsageInvalid: false,
    maxBufferUsage: null,
    prepositionPromise: null,
    prepositionSettled: true,
    dispatchControl: { aborted: false },
    dispatchPromise: null,
    dispatchSettled: true,
    streamControl: { aborted: false },
    streamPromise: null,
    streamSettled: true,
    cleanupSafe: true,
    cleanupFailures: [],
  };
  let resolveTracingComplete;
  let tracingCompleteSettled = false;
  const tracingComplete = new Promise((resolve) => {
    resolveTracingComplete = (params) => {
      if (tracingCompleteSettled) return;
      tracingCompleteSettled = true;
      state.completionObserved = true;
      state.completion = params;
      resolve(params);
    };
  });
  let removeTracingComplete = () => {};
  let removeBufferUsage = () => {};
  let parser = null;
  let trace = null;
  let latency = null;
  let failure = null;
  let stage = "preposition";
  try {
    removeTracingComplete = cdp.on("Tracing.tracingComplete", resolveTracingComplete);
    removeBufferUsage = cdp.on("Tracing.bufferUsage", (params) => {
      const usage = Number.isFinite(params?.percentFull)
        ? params.percentFull
        : Number.isFinite(params?.value)
          ? params.value
          : null;
      if (usage === null || usage < 0 || usage > 1) {
        state.bufferUsageInvalid = true;
        return;
      }
      state.bufferUsageObserved = true;
      state.maxBufferUsage = state.maxBufferUsage === null
        ? usage
        : Math.max(state.maxBufferUsage, usage);
    });
    if (!validRect(rect)) throw new Error("event latency calibration plot rect is invalid");
    const initialPoint = {
      x: Math.round(rect.x + rect.width * 0.66),
      y: Math.round(rect.y + rect.height * 0.58),
    };
    state.mouse = initialPoint;
    state.prepositionSettled = false;
    state.prepositionPromise = (async () => {
      await sendCdp(cdp, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: initialPoint.x,
        y: initialPoint.y,
        button: "none",
        buttons: 0,
      });
      await waitForAnimationFrame();
      // Ensure the untraced hover has presented before Tracing.start, otherwise
      // its async EventLatency end could appear as an orphan inside the trace.
      await waitForAnimationFrame();
    })();
    state.prepositionPromise.then(
      () => { state.prepositionSettled = true; },
      () => { state.prepositionSettled = true; },
    );
    try {
      await withDeadline(
        state.prepositionPromise,
        EVENT_LATENCY_ACQUISITION_LIMITS.dispatchDeadlineMs,
        "event latency calibration preposition",
      );
    } catch (error) {
      if (error instanceof CalibrationDeadlineError && !state.prepositionSettled) {
        const stopped = await withDeadline(
          state.prepositionPromise.then(() => true, () => true),
          2_000,
          "event latency calibration preposition stop confirmation",
        ).catch(() => false);
        if (!stopped) {
          state.cleanupSafe = false;
          state.cleanupFailures.push("preposition did not settle after its deadline");
        }
      }
      throw error;
    }
    stage = "start";
    state.startRequested = true;
    await withDeadline(sendCdp(cdp, "Tracing.start", {
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "none",
      bufferUsageReportingInterval: 1_000,
      traceConfig: {
        recordMode: "recordAsMuchAsPossible",
        includedCategories: [...CALIBRATION_CONFIGURATION.categories],
        excludedCategories: [...EVENT_LATENCY_ACQUISITION_LIMITS.traceExcludedCategories],
      },
    }), EVENT_LATENCY_ACQUISITION_LIMITS.dispatchDeadlineMs,
    "event latency Tracing.start");
    state.startConfirmed = true;
    stage = "dispatch";
    state.dispatchSettled = false;
    state.dispatchPromise = dispatchCalibrationInputs(
      cdp,
      rect,
      waitForAnimationFrame,
      actualDispatchCounts,
      state,
      state.dispatchControl,
    );
    state.dispatchPromise.then(
      () => { state.dispatchSettled = true; },
      () => { state.dispatchSettled = true; },
    );
    try {
      await withDeadline(
        state.dispatchPromise,
        EVENT_LATENCY_ACQUISITION_LIMITS.dispatchDeadlineMs,
        "event latency calibration dispatch",
        () => { state.dispatchControl.aborted = true; },
      );
    } catch (error) {
      state.dispatchControl.aborted = true;
      if (error instanceof CalibrationDeadlineError && !state.dispatchSettled) {
        const stopped = await withDeadline(
          state.dispatchPromise.then(() => true, () => true),
          2_000,
          "event latency calibration dispatch stop confirmation",
        ).catch(() => false);
        if (!stopped) {
          state.cleanupSafe = false;
          state.cleanupFailures.push("dispatch did not stop after its deadline");
        }
      }
      throw error;
    }
    stage = "trace-end";
    state.endRequested = true;
    await withDeadline(
      sendCdp(cdp, "Tracing.end"),
      EVENT_LATENCY_ACQUISITION_LIMITS.streamDeadlineMs,
      "event latency Tracing.end",
    );
    state.endConfirmed = true;
    stage = "stream";
    state.streamSettled = false;
    state.streamPromise = (async () => {
      const completion = await tracingComplete;
      if (completion?.dataLossOccurred !== false) {
        throw new Error(
          "Chromium data loss evidence was missing or did not explicitly report false",
        );
      }
      if (!state.bufferUsageObserved || state.bufferUsageInvalid) {
        throw new Error("Chromium trace buffer usage evidence was missing or invalid");
      }
      state.streamHandle = completion?.stream ?? null;
      return readTraceStream(cdp, state.streamHandle, state.streamControl);
    })();
    state.streamPromise.then(
      () => { state.streamSettled = true; },
      () => { state.streamSettled = true; },
    );
    let streamResult;
    try {
      streamResult = await withDeadline(
        state.streamPromise,
        EVENT_LATENCY_ACQUISITION_LIMITS.streamDeadlineMs,
        "event latency trace stream",
        () => { state.streamControl.aborted = true; },
      );
    } catch (error) {
      state.streamControl.aborted = true;
      if (error instanceof CalibrationDeadlineError && !state.streamSettled) {
        const stopped = await withDeadline(
          state.streamPromise.then(() => true, () => true),
          2_000,
          "event latency trace stream stop confirmation",
        ).catch(() => false);
        if (!stopped) {
          state.cleanupSafe = false;
          state.cleanupFailures.push("trace stream read did not stop after its deadline");
        }
      }
      throw error;
    }
    trace = {
      byteLength: streamResult.byteLength,
      chunkCount: streamResult.chunkCount,
      eventCount: traceEventCount(streamResult.trace),
      sha256: streamResult.sha256,
      dataLossOccurred: false,
      maxBufferUsage: state.maxBufferUsage,
    };
    stage = "parse";
    parser = parseTrace(streamResult.trace, { expectedDispatchCounts: expected });
    if (parser === null || typeof parser !== "object") {
      throw new Error("event latency parser returned an invalid report");
    }
    latency = summarizeParserLatency(parser);
    const conservationPassed = actualCountsMatchExpected(actualDispatchCounts, expected);
    const schemaPassed = parserSchemaEvidencePassed(parser);
    if (!conservationPassed) {
      failure = {
        kind: "conservation",
        message: "successful CDP dispatch counts did not match the fixed calibration contract",
      };
    } else if (!schemaPassed) {
      failure = {
        kind: "schema",
        message: "event latency parser rejected the acquired trace",
      };
    } else if (!latency.passed) {
      failure = {
        kind: "threshold",
        message: "valid event latency samples exceeded the fixed p95/p99 thresholds",
      };
    }
  } catch (error) {
    if (stage === "trace-end" && state.endRequested && !state.endConfirmed) {
      state.cleanupSafe = false;
      state.cleanupFailures.push("Tracing.end result was not confirmed during acquisition");
    }
    failure = {
      kind: stage === "parse" ? "schema" : "technical",
      message: errorMessage(error),
    };
  } finally {
    state.dispatchControl.aborted = true;
    state.streamControl.aborted = true;
    if (state.prepositionPromise !== null && !state.prepositionSettled) {
      const stopped = await withDeadline(
        state.prepositionPromise.then(() => true, () => true),
        2_000,
        "event latency calibration preposition cleanup",
      ).catch(() => false);
      if (!stopped) {
        state.cleanupSafe = false;
        state.cleanupFailures.push("preposition cleanup could not confirm termination");
      }
    }
    if (state.dispatchPromise !== null && !state.dispatchSettled) {
      const stopped = await withDeadline(
        state.dispatchPromise.then(() => true, () => true),
        2_000,
        "event latency calibration dispatch cleanup",
      ).catch(() => false);
      if (!stopped) {
        state.cleanupSafe = false;
        state.cleanupFailures.push("dispatch cleanup could not confirm termination");
      }
    }
    if (state.streamPromise !== null && !state.streamSettled) {
      const stopped = await withDeadline(
        state.streamPromise.then(() => true, () => true),
        2_000,
        "event latency calibration stream cleanup",
      ).catch(() => false);
      if (!stopped) {
        state.cleanupSafe = false;
        state.cleanupFailures.push("stream cleanup could not confirm termination");
      }
    }
    if (state.mouseDown) {
      try {
        await withDeadline(sendCdp(cdp, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: state.mouse.x,
          y: state.mouse.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        }), EVENT_LATENCY_ACQUISITION_LIMITS.dispatchDeadlineMs,
        "event latency cleanup mouse release");
      } catch (error) {
        state.cleanupSafe = false;
        state.cleanupFailures.push(`mouse release failed: ${errorMessage(error)}`);
      }
      state.mouseDown = false;
    }
    if (state.startRequested && !state.startConfirmed) {
      state.cleanupSafe = false;
      state.cleanupFailures.push("Tracing.start result was not confirmed");
    }
    if (state.startRequested && !state.endConfirmed) {
      state.endRequested = true;
      try {
        await withDeadline(
          sendCdp(cdp, "Tracing.end"),
          EVENT_LATENCY_ACQUISITION_LIMITS.streamDeadlineMs,
          "event latency cleanup Tracing.end",
        );
        state.endConfirmed = true;
      } catch (error) {
        state.cleanupSafe = false;
        state.cleanupFailures.push(`Tracing.end failed: ${errorMessage(error)}`);
      }
    }
    if (state.endConfirmed && !state.completionObserved) {
      const completion = await withDeadline(
        tracingComplete,
        EVENT_LATENCY_ACQUISITION_LIMITS.streamDeadlineMs,
        "event latency trace cleanup completion",
      ).catch((error) => {
        state.cleanupSafe = false;
        state.cleanupFailures.push(`tracingComplete failed: ${errorMessage(error)}`);
        return null;
      });
      if (completion !== null) {
        state.completionObserved = true;
        state.completion = completion;
      }
    }
    if (state.completionObserved) {
      const streamHandle = state.completion?.stream;
      if (typeof streamHandle === "string" && streamHandle.length > 0) {
        state.streamHandle = streamHandle;
      } else {
        state.cleanupSafe = false;
        state.cleanupFailures.push("tracingComplete stream handle was missing");
      }
    }
    if (state.streamHandle !== null && !state.streamClosed) {
      try {
        await withDeadline(
          closeStream(cdp, state.streamHandle),
          EVENT_LATENCY_ACQUISITION_LIMITS.streamDeadlineMs,
          "event latency cleanup IO.close",
        );
        state.streamClosed = true;
      } catch (error) {
        state.cleanupSafe = false;
        state.cleanupFailures.push(`IO.close failed: ${errorMessage(error)}`);
      }
    }
    removeTracingComplete();
    removeBufferUsage();
  }
  if (!state.cleanupSafe) {
    failure = {
      kind: "cleanup",
      message: state.cleanupFailures.join("; "),
    };
  }
  const completedAt = new Date().toISOString();
  const conservationPassed = actualCountsMatchExpected(actualDispatchCounts, expected);
  const schemaPassed = parserSchemaEvidencePassed(parser);
  return {
    attemptNumber,
    startedAt,
    completedAt,
    actualDispatchCounts,
    parser,
    trace,
    latency,
    acquisition: {
      passed: failure === null && state.cleanupSafe,
      conservationPassed,
      schemaPassed,
      latencyPassed: latency?.passed === true,
      cleanupSafe: state.cleanupSafe,
      failureKind: failure?.kind ?? null,
      failureMessage: failure?.message ?? null,
    },
  };
}

function attemptSummary(attempt) {
  return {
    attempt: attempt.attemptNumber,
    passed: attempt.acquisition.passed,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    failureReason: attempt.acquisition.passed
      ? null
      : `${attempt.acquisition.failureKind}: ${attempt.acquisition.failureMessage}`,
  };
}

function configurationReport() {
  return {
    ...CALIBRATION_CONFIGURATION,
    categories: [...CALIBRATION_CONFIGURATION.categories],
  };
}

/**
 * Acquire a bounded Chromium presentation trace after the formal soak window.
 * All acquisition failures are returned as structured evidence so the already
 * frozen formal soak report is never discarded by the runner's outer catch.
 */
export async function runDrawingEventLatencyCalibration({
  cdp,
  rect,
  waitForAnimationFrame,
  provenance = {},
  parseTrace = parseDrawingEventLatencyTrace,
}) {
  const expected = expectedDispatchCounts();
  const windowStartedAt = new Date().toISOString();
  const attempts = [];
  let selected = null;
  try {
    if (cdp === null
      || typeof cdp !== "object"
      || typeof cdp.send !== "function"
      || typeof cdp.on !== "function") {
      throw new TypeError("event latency calibration requires a CDP connection");
    }
    for (let index = 0; index < CALIBRATION_CONFIGURATION.maxAttempts; index += 1) {
      const attempt = await runAttempt({
        cdp,
        rect,
        waitForAnimationFrame,
        parseTrace,
        attemptNumber: index + 1,
      });
      selected = attempt;
      const retryable = attempt.acquisition.cleanupSafe === true
        && ["technical", "conservation", "schema"].includes(
          attempt.acquisition.failureKind,
        );
      const retryScheduled = retryable
        && index + 1 < CALIBRATION_CONFIGURATION.maxAttempts;
      attempts.push(attemptSummary(attempt));
      if (!retryScheduled) break;
    }
  } catch (error) {
    selected = {
      actualDispatchCounts: emptyDispatchCounts(),
      parser: null,
      trace: null,
      latency: null,
      acquisition: {
        passed: false,
        evidencePassed: false,
        conservationPassed: false,
        schemaPassed: false,
        latencyPassed: false,
        failureKind: "technical",
        failureMessage: errorMessage(error),
      },
    };
  }
  const windowCompletedAt = new Date().toISOString();
  const acquisitionStartedAt = attempts[0]?.startedAt ?? windowStartedAt;
  const acquisitionCompletedAt = attempts.at(-1)?.completedAt ?? windowCompletedAt;
  return {
    schemaVersion: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.schemaVersion,
    window: DRAWING_EVENT_LATENCY_CALIBRATION_CONTRACT.window,
    configuration: configurationReport(),
    provenance: { ...provenance },
    expectedDispatchCounts: expected,
    actualDispatchCounts: selected.actualDispatchCounts,
    trace: selected.trace,
    parser: selected.parser,
    acquisition: {
      passed: selected.acquisition.passed,
      attemptCount: attempts.length,
      startedAt: acquisitionStartedAt,
      completedAt: acquisitionCompletedAt,
      failureReason: selected.acquisition.passed
        ? null
        : `${selected.acquisition.failureKind}: ${selected.acquisition.failureMessage}`,
    },
    attempts,
  };
}
