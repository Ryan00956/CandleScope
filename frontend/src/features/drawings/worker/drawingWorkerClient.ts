import {
  DEFAULT_DRAWING_WORKER_MAX_RESULT_BYTES,
  DRAWING_WORKER_SCHEMA_VERSION,
  createDrawingWorkerJobHeader,
  isDrawingWorkerRequest,
  isDrawingWorkerResponse,
  releaseDrawingWorkerDrawResult,
  releaseDrawingWorkerEntityPatches,
  releaseDrawingWorkerViewportPayload,
  sameDrawingWorkerJob,
  drawingWorkerRequestTransferables,
  type DrawingWorkerEntityPatch,
  type DrawingWorkerJobHeader,
  type DrawingWorkerRenderRequest,
  type DrawingWorkerRenderResponse,
  type DrawingWorkerResponse,
  type DrawingWorkerViewportPayload,
} from "./drawingWorkerProtocol.js";
import type { DrawingRenderRevisionStamp } from "../engine/drawingRenderScheduler.js";

export type DrawingWorkerUnavailableReason =
  | "unsupported"
  | "forced-main-thread-fallback"
  | "construction-failed"
  | "transport-error"
  | "protocol-error"
  | "post-message-failed";

export interface DrawingWorkerTransport {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage(message: unknown, transferables?: Transferable[]): void;
  terminate(): void;
}

export interface DrawingWorkerSubmitInput {
  readonly stamp: DrawingRenderRevisionStamp;
  readonly patches?: readonly DrawingWorkerEntityPatch[];
  readonly viewport: DrawingWorkerViewportPayload;
  readonly maxResultBytes?: number;
}

export interface DrawingWorkerClientSnapshot {
  readonly availability: "available" | "unavailable" | "disposed";
  readonly unavailableReason: DrawingWorkerUnavailableReason | null;
  readonly queueDepth: 0 | 1 | 2;
  readonly inFlight: 0 | 1;
  readonly pending: 0 | 1;
  readonly submittedCount: number;
  readonly dispatchedCount: number;
  readonly resultCount: number;
  readonly cancelledCount: number;
  readonly staleResultCount: number;
  readonly queueDropCount: number;
  readonly errorCount: number;
  readonly latestSubmittedHeader: DrawingWorkerJobHeader | null;
  readonly inFlightHeader: DrawingWorkerJobHeader | null;
  readonly pendingHeader: DrawingWorkerJobHeader | null;
}

export interface DrawingWorkerClientOptions {
  transportFactory?: () => DrawingWorkerTransport;
  forceMainThreadFallback?: boolean;
  /**
   * Mount-locked benchmark hook. A terminal worker response remains owned by
   * the client, and the job remains in-flight, until this delay elapses.
   */
  resultDeliveryDelayMs?: number;
  onResult?(response: DrawingWorkerRenderResponse): void;
  onStaleResult?(response: DrawingWorkerRenderResponse): void;
  onQueueDrop?(dropped: DrawingWorkerJobHeader, replacement: DrawingWorkerJobHeader): void;
  onJobError?(response: Extract<DrawingWorkerResponse, { type: "drawing-worker/error" }>): void;
  onUnavailable?(reason: DrawingWorkerUnavailableReason, error: unknown): void;
  onStateChange?(snapshot: DrawingWorkerClientSnapshot): void;
}

export interface DrawingWorkerClient {
  readonly available: boolean;
  submit(input: DrawingWorkerSubmitInput): DrawingWorkerJobHeader | null;
  snapshot(): DrawingWorkerClientSnapshot;
  dispose(): void;
}

interface QueuedDrawingWorkerJob {
  readonly request: DrawingWorkerRenderRequest;
}

export const MAX_DRAWING_WORKER_RESULT_DELIVERY_DELAY_MS = 5_000;

function normalizedResultDeliveryDelayMs(value: number | undefined): number {
  const delayMs = value ?? 0;
  if (!Number.isFinite(delayMs)
    || delayMs < 0
    || delayMs > MAX_DRAWING_WORKER_RESULT_DELIVERY_DELAY_MS) {
    throw new TypeError(
      `drawing worker result delivery delay must be between 0 and ${MAX_DRAWING_WORKER_RESULT_DELIVERY_DELAY_MS}ms`,
    );
  }
  return delayMs;
}

export function isDrawingWorkerSupported(): boolean {
  return typeof Worker === "function"
    && typeof ArrayBuffer === "function"
    && typeof structuredClone === "function";
}

function createDefaultDrawingWorkerTransport(): DrawingWorkerTransport {
  if (!isDrawingWorkerSupported()) throw new Error("drawing worker is unsupported");
  return new Worker(
    new URL("./drawing.worker.ts", import.meta.url),
    { type: "module", name: "candlescope-drawing-worker" },
  ) as unknown as DrawingWorkerTransport;
}

/**
 * Latest-wins worker scheduler. Ownership of viewport and patch transferables
 * moves to the client only after a successful submit call.
 */
export function createDrawingWorkerClient(
  options: DrawingWorkerClientOptions = {},
): DrawingWorkerClient {
  const resultDeliveryDelayMs = normalizedResultDeliveryDelayMs(
    options.resultDeliveryDelayMs,
  );
  let availability: DrawingWorkerClientSnapshot["availability"] = "unavailable";
  let unavailableReason: DrawingWorkerUnavailableReason | null = null;
  let transport: DrawingWorkerTransport | null = null;
  let inFlight: QueuedDrawingWorkerJob | null = null;
  let pending: QueuedDrawingWorkerJob | null = null;
  let latestSubmittedHeader: DrawingWorkerJobHeader | null = null;
  let sequence = 0;
  let submittedCount = 0;
  let dispatchedCount = 0;
  let resultCount = 0;
  let cancelledCount = 0;
  let staleResultCount = 0;
  let queueDropCount = 0;
  let errorCount = 0;
  let cancelSentThroughGeneration = 0;
  let delayedResponse: DrawingWorkerResponse | null = null;
  let delayedResponseHandle: ReturnType<typeof setTimeout> | null = null;

  const readSnapshot = (): DrawingWorkerClientSnapshot => Object.freeze({
    availability,
    unavailableReason,
    queueDepth: (Number(inFlight !== null) + Number(pending !== null)) as 0 | 1 | 2,
    inFlight: Number(inFlight !== null) as 0 | 1,
    pending: Number(pending !== null) as 0 | 1,
    submittedCount,
    dispatchedCount,
    resultCount,
    cancelledCount,
    staleResultCount,
    queueDropCount,
    errorCount,
    latestSubmittedHeader,
    inFlightHeader: inFlight?.request.header ?? null,
    pendingHeader: pending?.request.header ?? null,
  });

  const notifyState = (): void => {
    try {
      options.onStateChange?.(readSnapshot());
    } catch {
      // Instrumentation callbacks must never break scheduling.
    }
  };

  const releaseJob = (job: QueuedDrawingWorkerJob | null): void => {
    if (!job) return;
    releaseDrawingWorkerViewportPayload(job.request.viewport);
    releaseDrawingWorkerEntityPatches(job.request.patches);
  };

  const releaseResponse = (response: DrawingWorkerResponse | null): void => {
    if (response?.type === "drawing-worker/result") {
      releaseDrawingWorkerDrawResult(response.result);
    }
  };

  const clearDelayedResponse = (): void => {
    if (delayedResponseHandle !== null) clearTimeout(delayedResponseHandle);
    delayedResponseHandle = null;
    const response = delayedResponse;
    delayedResponse = null;
    releaseResponse(response);
  };

  const markUnavailable = (
    reason: DrawingWorkerUnavailableReason,
    error: unknown,
  ): void => {
    if (availability !== "available") return;
    availability = "unavailable";
    unavailableReason = reason;
    errorCount += 1;
    const activeTransport = transport;
    transport = null;
    if (activeTransport) {
      activeTransport.onmessage = null;
      activeTransport.onerror = null;
      try { activeTransport.terminate(); } catch { /* no-op */ }
    }
    clearDelayedResponse();
    releaseJob(inFlight);
    releaseJob(pending);
    inFlight = null;
    pending = null;
    try { options.onUnavailable?.(reason, error); } catch { /* no-op */ }
    notifyState();
  };

  const postCancelForInFlight = (): void => {
    const active = inFlight;
    if (!active || !transport) return;
    const throughGeneration = active.request.header.generation;
    if (throughGeneration <= cancelSentThroughGeneration) return;
    cancelSentThroughGeneration = throughGeneration;
    try {
      transport.postMessage({
        type: "drawing-worker/cancel",
        schemaVersion: DRAWING_WORKER_SCHEMA_VERSION,
        throughGeneration,
      }, []);
    } catch (error) {
      markUnavailable("post-message-failed", error);
    }
  };

  const dispatch = (job: QueuedDrawingWorkerJob): void => {
    if (availability !== "available" || !transport) return;
    inFlight = job;
    dispatchedCount += 1;
    notifyState();
    try {
      transport.postMessage(job.request, drawingWorkerRequestTransferables(job.request));
    } catch (error) {
      markUnavailable("post-message-failed", error);
    }
  };

  const dispatchPending = (): void => {
    if (availability !== "available" || inFlight || !pending) {
      notifyState();
      return;
    }
    const next = pending;
    pending = null;
    dispatch(next);
  };

  const finishExpectedResponse = (response: DrawingWorkerResponse): void => {
    const active = inFlight;
    if (!active || !sameDrawingWorkerJob(response.header, active.request.header)) {
      if (response.type === "drawing-worker/result") {
        staleResultCount += 1;
        try { options.onStaleResult?.(response); } catch { /* no-op */ }
        releaseDrawingWorkerDrawResult(response.result);
      }
      notifyState();
      return;
    }
    inFlight = null;
    cancelSentThroughGeneration = Math.max(
      cancelSentThroughGeneration,
      response.header.generation,
    );
    const isLatest = latestSubmittedHeader !== null
      && sameDrawingWorkerJob(response.header, latestSubmittedHeader);
    if (response.type === "drawing-worker/result") {
      if (!isLatest) {
        staleResultCount += 1;
        try { options.onStaleResult?.(response); } catch { /* no-op */ }
        releaseDrawingWorkerDrawResult(response.result);
      } else {
        resultCount += 1;
        if (!options.onResult) {
          releaseDrawingWorkerDrawResult(response.result);
        } else try {
          options.onResult(response);
        } catch {
          errorCount += 1;
          releaseDrawingWorkerDrawResult(response.result);
        }
      }
    } else if (response.type === "drawing-worker/cancelled") {
      cancelledCount += 1;
    } else {
      // A terminal error for the superseded in-flight job must never trigger
      // that job's main-thread fallback. Its pending-latest replacement may
      // intentionally share the same document/frame stamp while changing
      // selection or dynamic-overlay ownership.
      if (!isLatest) {
        staleResultCount += 1;
      } else {
        errorCount += 1;
        try { options.onJobError?.(response); } catch { /* no-op */ }
      }
    }
    dispatchPending();
  };

  const finishDelayedResponse = (): void => {
    delayedResponseHandle = null;
    const response = delayedResponse;
    delayedResponse = null;
    if (response) finishExpectedResponse(response);
  };

  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (availability !== "available") return;
    if (!isDrawingWorkerResponse(event.data)) {
      markUnavailable("protocol-error", new TypeError("invalid drawing worker response"));
      return;
    }
    const response = event.data;
    const active = inFlight;
    if (resultDeliveryDelayMs <= 0
      || !active
      || !sameDrawingWorkerJob(response.header, active.request.header)) {
      finishExpectedResponse(response);
      return;
    }
    if (delayedResponse) {
      // A transport must emit one terminal response per job. Treat a duplicate
      // as stale without allowing it to bypass the configured delivery delay.
      staleResultCount += 1;
      if (response.type === "drawing-worker/result") {
        try { options.onStaleResult?.(response); } catch { /* no-op */ }
      }
      releaseResponse(response);
      notifyState();
      return;
    }
    delayedResponse = response;
    delayedResponseHandle = setTimeout(finishDelayedResponse, resultDeliveryDelayMs);
    notifyState();
  };

  const handleTransportError = (event: Event): void => {
    markUnavailable("transport-error", event);
  };

  if (options.forceMainThreadFallback === true) {
    unavailableReason = "forced-main-thread-fallback";
    try { options.onUnavailable?.(unavailableReason, null); } catch { /* no-op */ }
  } else if (!options.transportFactory && !isDrawingWorkerSupported()) {
    unavailableReason = "unsupported";
    try { options.onUnavailable?.(unavailableReason, null); } catch { /* no-op */ }
  } else {
    try {
      transport = (options.transportFactory ?? createDefaultDrawingWorkerTransport)();
      transport.onmessage = handleMessage;
      transport.onerror = handleTransportError;
      availability = "available";
    } catch (error) {
      unavailableReason = "construction-failed";
      try { options.onUnavailable?.(unavailableReason, error); } catch { /* no-op */ }
    }
  }

  const mergePendingJob = (
    previous: QueuedDrawingWorkerJob,
    replacement: QueuedDrawingWorkerJob,
  ): QueuedDrawingWorkerJob => {
    if (previous.request.header.stamp.scopeKey
      !== replacement.request.header.stamp.scopeKey) {
      releaseJob(previous);
      return replacement;
    }
    const mergedPatches = new Map<string, DrawingWorkerEntityPatch>();
    for (const patch of previous.request.patches) mergedPatches.set(patch.entityId, patch);
    for (const patch of replacement.request.patches) {
      const superseded = mergedPatches.get(patch.entityId);
      if (superseded && superseded !== patch) releaseDrawingWorkerEntityPatches([superseded]);
      mergedPatches.set(patch.entityId, patch);
    }
    releaseDrawingWorkerViewportPayload(previous.request.viewport);
    return Object.freeze({
      request: Object.freeze({
        ...replacement.request,
        patches: Object.freeze([...mergedPatches.values()]),
      }),
    });
  };

  const client: DrawingWorkerClient = Object.freeze({
    get available() { return availability === "available"; },
    submit(input: DrawingWorkerSubmitInput): DrawingWorkerJobHeader | null {
      if (availability !== "available") return null;
      sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
      const header = createDrawingWorkerJobHeader(sequence, sequence, input.stamp);
      const request: DrawingWorkerRenderRequest = Object.freeze({
        type: "drawing-worker/render",
        header,
        patches: Object.freeze([...(input.patches ?? [])]),
        viewport: input.viewport,
        maxResultBytes: input.maxResultBytes ?? DEFAULT_DRAWING_WORKER_MAX_RESULT_BYTES,
      });
      if (!isDrawingWorkerRequest(request)) {
        throw new TypeError("drawing worker submission is invalid or exceeds its byte budget");
      }
      const job = Object.freeze({ request });
      submittedCount += 1;
      latestSubmittedHeader = header;
      if (!inFlight) {
        dispatch(job);
        return header;
      }
      if (pending) {
        const droppedHeader = pending.request.header;
        pending = mergePendingJob(pending, job);
        queueDropCount += 1;
        try { options.onQueueDrop?.(droppedHeader, header); } catch { /* no-op */ }
      } else {
        pending = job;
      }
      postCancelForInFlight();
      notifyState();
      return header;
    },
    snapshot: readSnapshot,
    dispose(): void {
      if (availability === "disposed") return;
      const activeTransport = transport;
      if (activeTransport && inFlight) {
        try {
          activeTransport.postMessage({
            type: "drawing-worker/cancel",
            schemaVersion: DRAWING_WORKER_SCHEMA_VERSION,
            throughGeneration: inFlight.request.header.generation,
          }, []);
        } catch {
          // Termination below is the fail-closed cancellation boundary.
        }
      }
      transport = null;
      if (activeTransport) {
        activeTransport.onmessage = null;
        activeTransport.onerror = null;
        try { activeTransport.terminate(); } catch { /* no-op */ }
      }
      clearDelayedResponse();
      releaseJob(inFlight);
      releaseJob(pending);
      inFlight = null;
      pending = null;
      availability = "disposed";
      notifyState();
    },
  });
  notifyState();
  return client;
}
