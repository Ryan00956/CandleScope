import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  DEFAULT_DRAWING_WORKER_MAX_RESULT_BYTES,
  createDrawingWorkerJobHeader,
  drawingWorkerBitmapByteLength,
  drawingWorkerRequestTransferables,
  drawingWorkerViewportByteLength,
  isDrawingWorkerRequest,
  isDrawingWorkerResponse,
  releaseDrawingWorkerDrawResult,
  sameDrawingWorkerJob,
  type DrawingWorkerDrawResult,
  type DrawingWorkerEntityPatch,
  type DrawingWorkerJobHeader,
  type DrawingWorkerRenderRequest,
  type DrawingWorkerRenderResponse,
  type DrawingWorkerResponse,
  type DrawingWorkerTypedDrawResult,
  type DrawingWorkerViewportPayload,
} from "../drawingWorkerProtocol.js";
import {
  createDrawingWorkerClient,
  MAX_DRAWING_WORKER_RESULT_DELIVERY_DELAY_MS,
  type DrawingWorkerTransport,
} from "../drawingWorkerClient.js";
import { createDrawingWorkerProcessor } from "../drawingWorkerProcessor.js";

function stamp(overrides: Partial<DrawingRenderRevisionStamp> = {}): DrawingRenderRevisionStamp {
  return Object.freeze({
    scopeKey: "scope",
    documentRevision: 1,
    surfaceGeneration: 2,
    dataRevision: 3,
    projectionRevision: 4,
    lineageIndexRevision: 5,
    viewportRevision: 6,
    themeRevision: 7,
    widthCssPx: 800,
    heightCssPx: 400,
    dpr: 1.5,
    ...overrides,
  });
}

function viewport(
  id = "stroke",
  coordinates: readonly number[] = [0, 0, 10, 10],
): DrawingWorkerViewportPayload {
  const pointCount = coordinates.length / 2;
  return {
    widthCssPx: 800,
    heightCssPx: 400,
    dpr: 1.5,
    entityIds: [id],
    kindCodes: new Uint8Array([8]),
    pointOffsets: new Uint32Array([0]),
    pointCounts: new Uint32Array([pointCount]),
    points: new Float64Array(coordinates),
    bboxes: new Float64Array([0, 0, 10, 10]),
    pathBreakOffsets: new Uint32Array([0]),
    pathBreakCounts: new Uint32Array([0]),
    pathBreaks: new Uint32Array(),
    paintSpecs: [{
      entityIndex: 0,
      strokeColor: "#123456",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 2,
      opacity: 0.8,
      compositeOperation: "source-over",
      brushShape: "round",
      pathInterpolation: "quadratic",
      selected: false,
    }],
  };
}

function upsert(
  entityId: string,
  documentRevision: number,
  canonicalPoints: readonly number[] = [0, 1, 2, 3, 4, 5],
  options: Readonly<{
    geometryRevision?: number;
    styleRevision?: number;
    pathBreaks?: readonly number[];
    kind?: "freehand" | "highlighter";
  }> = {},
): DrawingWorkerEntityPatch {
  return {
    op: "upsert",
    scopeKey: "scope",
    documentRevision,
    entityId,
    kind: options.kind ?? "freehand",
    geometryRevision: options.geometryRevision ?? documentRevision,
    styleRevision: options.styleRevision ?? 1,
    canonicalPoints: new Float64Array(canonicalPoints),
    pathBreaks: new Uint32Array(options.pathBreaks ?? []),
  };
}

function remove(entityId: string, documentRevision: number): DrawingWorkerEntityPatch {
  return { op: "delete", scopeKey: "scope", documentRevision, entityId };
}

function request(
  header: DrawingWorkerJobHeader,
  payload: DrawingWorkerViewportPayload,
  patches: readonly DrawingWorkerEntityPatch[] = [],
): DrawingWorkerRenderRequest {
  return {
    type: "drawing-worker/render",
    header,
    patches,
    viewport: payload,
    maxResultBytes: DEFAULT_DRAWING_WORKER_MAX_RESULT_BYTES,
  };
}

function typedResult(
  header: DrawingWorkerJobHeader,
  payload = viewport(),
  rawPointCount = payload.points.length / 2,
): DrawingWorkerRenderResponse {
  const result: DrawingWorkerTypedDrawResult = {
    kind: "typed-draw-result",
    ...payload,
    byteLength: drawingWorkerViewportByteLength(payload),
    rawPointCount,
    renderedPointCount: payload.points.length / 2,
    canonicalEntityCount: 1,
  };
  return { type: "drawing-worker/result", header, result };
}

class MockTransport implements DrawingWorkerTransport {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly posts: Array<{ message: unknown; transferables: readonly Transferable[] }> = [];
  terminated = false;
  throwOnPost = false;

  postMessage(message: unknown, transferables: Transferable[] = []): void {
    if (this.throwOnPost) throw new Error("post failed");
    this.posts.push({ message, transferables });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for drawing worker test state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("protocol requires the complete render stamp and preserves strict job identity", () => {
  const header = createDrawingWorkerJobHeader(1, 9, stamp());
  const valid = request(header, viewport(), [upsert("stroke", 1)]);
  assert.equal(isDrawingWorkerRequest(valid), true);
  assert.equal(sameDrawingWorkerJob(header, { ...header, stamp: { ...header.stamp } }), true);
  for (const key of Object.keys(header.stamp) as Array<keyof DrawingRenderRevisionStamp>) {
    const value = header.stamp[key];
    const changedStamp = {
      ...header.stamp,
      [key]: typeof value === "string" ? `${value}-changed` : Number(value) + 1,
    } as DrawingRenderRevisionStamp;
    assert.equal(sameDrawingWorkerJob(header, { ...header, stamp: changedStamp }), false, key);
  }
  assert.equal(isDrawingWorkerRequest({
    ...valid,
    header: { ...header, stamp: { scopeKey: "scope", documentRevision: 1 } },
  }), false);
  assert.equal(isDrawingWorkerRequest({ ...valid, maxResultBytes: 1 }), false);
  assert.equal(isDrawingWorkerRequest({
    ...valid,
    viewport: { ...valid.viewport, dpr: 2 },
  }), false, "viewport dimensions must match the complete stamp");
  assert.equal(isDrawingWorkerRequest({
    ...valid,
    viewport: {
      ...valid.viewport,
      paintSpecs: [{ ...valid.viewport.paintSpecs[0], entityIndex: 1 }],
    },
  }), false, "paint specs are bounded to freehand/highlighter entity indexes");
  assert.equal(isDrawingWorkerRequest({
    ...valid,
    viewport: {
      ...valid.viewport,
      paintSpecs: [{ ...valid.viewport.paintSpecs[0], compositeOperation: "copy" }],
    },
  }), false, "transparent atlas tiles reject compositing modes that can clear their bbox");
  assert.equal(drawingWorkerRequestTransferables(valid).length, 10);
});

test("typed result transferables are explicitly detached when a stale result is released", () => {
  const response = typedResult(createDrawingWorkerJobHeader(1, 1, stamp()));
  assert.equal(isDrawingWorkerResponse(response), true);
  const points = (response.result as DrawingWorkerTypedDrawResult).points;
  assert.ok(points.byteLength > 0);
  releaseDrawingWorkerDrawResult(response.result);
  assert.equal(points.byteLength, 0);
});

test("client keeps exactly one in-flight plus one pending-latest and carries forward patches", () => {
  const transport = new MockTransport();
  const dropped: number[] = [];
  const client = createDrawingWorkerClient({
    transportFactory: () => transport,
    onQueueDrop: (header) => dropped.push(header.jobId),
  });
  const firstHeader = client.submit({
    stamp: stamp(),
    patches: [upsert("first", 1)],
    viewport: viewport("first"),
  });
  assert.ok(firstHeader);
  const secondViewport = viewport("second");
  const secondHeader = client.submit({
    stamp: stamp({ documentRevision: 2, viewportRevision: 7 }),
    patches: [upsert("second", 2)],
    viewport: secondViewport,
  });
  const thirdHeader = client.submit({
    stamp: stamp({ documentRevision: 3, viewportRevision: 8 }),
    patches: [upsert("third", 3)],
    viewport: viewport("third"),
  });
  assert.ok(secondHeader && thirdHeader);
  assert.deepEqual(client.snapshot(), {
    ...client.snapshot(),
    availability: "available",
    queueDepth: 2,
    inFlight: 1,
    pending: 1,
    submittedCount: 3,
    dispatchedCount: 1,
    queueDropCount: 1,
  });
  assert.deepEqual(dropped, [secondHeader.jobId]);
  assert.equal(secondViewport.points.byteLength, 0, "overwritten viewport was released");
  assert.equal(transport.posts.filter(({ message }) => (
    (message as { type?: string }).type === "drawing-worker/render"
  )).length, 1);

  transport.emit({ type: "drawing-worker/cancelled", header: firstHeader });
  const renderPosts = transport.posts.filter(({ message }) => (
    (message as { type?: string }).type === "drawing-worker/render"
  ));
  assert.equal(renderPosts.length, 2);
  const latestRequest = renderPosts[1]?.message as DrawingWorkerRenderRequest;
  assert.equal(latestRequest.header.jobId, thirdHeader.jobId);
  assert.deepEqual(latestRequest.patches.map((patch) => patch.entityId).sort(), ["second", "third"]);
  assert.equal(client.snapshot().queueDepth, 1);
  client.dispose();
});

test("client result delivery delay preserves one in-flight plus pending-latest backpressure", async () => {
  const transport = new MockTransport();
  const accepted: number[] = [];
  const dropped: number[] = [];
  const client = createDrawingWorkerClient({
    transportFactory: () => transport,
    resultDeliveryDelayMs: 25,
    onResult: ({ header }) => accepted.push(header.jobId),
    onQueueDrop: (header) => dropped.push(header.jobId),
  });
  try {
    const first = client.submit({ stamp: stamp(), viewport: viewport("first") });
    const second = client.submit({
      stamp: stamp({ documentRevision: 2, viewportRevision: 7 }),
      viewport: viewport("second"),
    });
    assert.ok(first && second);

    transport.emit(typedResult(first, viewport("first-result")));
    assert.equal(client.snapshot().inFlightHeader?.jobId, first.jobId);
    assert.equal(client.snapshot().pendingHeader?.jobId, second.jobId);
    assert.deepEqual(accepted, []);

    const third = client.submit({
      stamp: stamp({ documentRevision: 3, viewportRevision: 8 }),
      viewport: viewport("third"),
    });
    assert.ok(third);
    assert.deepEqual(dropped, [second.jobId]);
    assert.equal(client.snapshot().queueDepth, 2);
    assert.equal(client.snapshot().inFlightHeader?.jobId, first.jobId);
    assert.equal(client.snapshot().pendingHeader?.jobId, third.jobId);

    await waitUntil(() => client.snapshot().inFlightHeader?.jobId === third.jobId);
    assert.deepEqual(accepted, [], "obsolete delayed result must not publish");
    const renderPosts = transport.posts.filter(({ message }) => (
      (message as { type?: string }).type === "drawing-worker/render"
    ));
    assert.equal(renderPosts.length, 2);
    assert.equal(
      (renderPosts[1]?.message as DrawingWorkerRenderRequest).header.jobId,
      third.jobId,
    );

    transport.emit(typedResult(third, viewport("third-result")));
    assert.equal(client.snapshot().inFlightHeader?.jobId, third.jobId);
    assert.deepEqual(accepted, []);
    await waitUntil(() => accepted.length === 1);
    assert.deepEqual(accepted, [third.jobId]);
    assert.equal(client.snapshot().queueDepth, 0);
  } finally {
    client.dispose();
  }
});

test("client validates result delay and releases delayed responses on shutdown", async () => {
  assert.throws(
    () => createDrawingWorkerClient({ resultDeliveryDelayMs: -1 }),
    /result delivery delay/,
  );
  assert.throws(
    () => createDrawingWorkerClient({ resultDeliveryDelayMs: Number.POSITIVE_INFINITY }),
    /result delivery delay/,
  );
  assert.throws(
    () => createDrawingWorkerClient({
      resultDeliveryDelayMs: MAX_DRAWING_WORKER_RESULT_DELIVERY_DELAY_MS + 1,
    }),
    /result delivery delay/,
  );

  for (const shutdown of ["dispose", "unavailable"] as const) {
    const transport = new MockTransport();
    const accepted: number[] = [];
    const client = createDrawingWorkerClient({
      transportFactory: () => transport,
      resultDeliveryDelayMs: 50,
      onResult: ({ header }) => accepted.push(header.jobId),
    });
    const header = client.submit({ stamp: stamp(), viewport: viewport(shutdown) });
    assert.ok(header);
    const response = typedResult(header, viewport(`${shutdown}-result`));
    const points = response.result.kind === "typed-draw-result"
      ? response.result.points
      : null;
    transport.emit(response);
    assert.ok(points && points.byteLength > 0);
    if (shutdown === "dispose") client.dispose();
    else transport.onerror?.(new Event("error"));
    assert.equal(points?.byteLength, 0, `${shutdown} must release the delayed response`);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(accepted, []);
  }
});

test("client rejects matching-but-obsolete and unexpected results without publishing them", () => {
  const transport = new MockTransport();
  const accepted: number[] = [];
  const stale: number[] = [];
  const client = createDrawingWorkerClient({
    transportFactory: () => transport,
    onResult: ({ header }) => accepted.push(header.jobId),
    onStaleResult: ({ header }) => stale.push(header.jobId),
  });
  const first = client.submit({ stamp: stamp(), viewport: viewport("first") });
  const latest = client.submit({
    stamp: stamp({ viewportRevision: 7 }),
    viewport: viewport("latest"),
  });
  assert.ok(first && latest);
  const obsolete = typedResult(first, viewport("obsolete"));
  const obsoletePoints = (obsolete.result as DrawingWorkerTypedDrawResult).points;
  transport.emit(obsolete);
  assert.equal(obsoletePoints.byteLength, 0);
  assert.deepEqual(accepted, []);
  assert.deepEqual(stale, [first.jobId]);
  assert.equal(client.snapshot().inFlightHeader?.jobId, latest.jobId);

  const unexpectedHeader = createDrawingWorkerJobHeader(
    99,
    99,
    stamp({ viewportRevision: 99 }),
  );
  transport.emit(typedResult(unexpectedHeader, viewport("unexpected")));
  assert.equal(client.snapshot().inFlightHeader?.jobId, latest.jobId);
  transport.emit(typedResult(latest, viewport("latest")));
  assert.deepEqual(accepted, [latest.jobId]);
  assert.equal(client.snapshot().staleResultCount, 2);
  assert.equal(client.snapshot().resultCount, 1);
  client.dispose();
});

test("client suppresses an obsolete in-flight error before dispatching same-stamp pending latest", () => {
  const transport = new MockTransport();
  const errored: number[] = [];
  const client = createDrawingWorkerClient({
    transportFactory: () => transport,
    onJobError: ({ header }) => errored.push(header.jobId),
  });
  const sharedStamp = stamp({ viewportRevision: 7 });
  const first = client.submit({ stamp: sharedStamp, viewport: viewport("first") });
  const latest = client.submit({ stamp: sharedStamp, viewport: viewport("latest") });
  assert.ok(first && latest);

  transport.emit({
    type: "drawing-worker/error",
    header: first,
    code: "processing-failed",
    message: "obsolete job failed",
  });

  assert.deepEqual(errored, [], "obsolete errors cannot publish their main-thread fallback");
  assert.equal(client.snapshot().staleResultCount, 1);
  assert.equal(client.snapshot().errorCount, 0);
  assert.equal(client.snapshot().inFlightHeader?.jobId, latest.jobId);
  client.dispose();
});

test("client exposes forced fallback, construction, transport, protocol, and post failures", () => {
  const reasons: string[] = [];
  const forcedPayload = viewport();
  const forced = createDrawingWorkerClient({
    forceMainThreadFallback: true,
    onUnavailable: (reason) => reasons.push(reason),
  });
  assert.equal(forced.submit({ stamp: stamp(), viewport: forcedPayload }), null);
  assert.ok(forcedPayload.points.byteLength > 0, "rejected fallback submission retains caller ownership");

  createDrawingWorkerClient({
    transportFactory: () => { throw new Error("constructor failed"); },
    onUnavailable: (reason) => reasons.push(reason),
  });

  const protocolTransport = new MockTransport();
  const protocol = createDrawingWorkerClient({
    transportFactory: () => protocolTransport,
    onUnavailable: (reason) => reasons.push(reason),
  });
  protocol.submit({ stamp: stamp(), viewport: viewport() });
  protocolTransport.emit({ nope: true });
  assert.equal(protocol.available, false);
  assert.equal(protocolTransport.terminated, true);

  const postTransport = new MockTransport();
  postTransport.throwOnPost = true;
  const post = createDrawingWorkerClient({
    transportFactory: () => postTransport,
    onUnavailable: (reason) => reasons.push(reason),
  });
  assert.ok(post.submit({ stamp: stamp(), viewport: viewport() }));

  const errorTransport = new MockTransport();
  const errored = createDrawingWorkerClient({
    transportFactory: () => errorTransport,
    onUnavailable: (reason) => reasons.push(reason),
  });
  errored.submit({ stamp: stamp(), viewport: viewport() });
  errorTransport.onerror?.(new Event("error"));
  assert.equal(errored.available, false);
  assert.deepEqual(reasons, [
    "forced-main-thread-fallback",
    "construction-failed",
    "protocol-error",
    "post-message-failed",
    "transport-error",
  ]);
});

test("processor applies incremental upsert/delete patches and returns bounded typed draw data", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const transferCounts: number[] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage: (message, transferables) => {
      responses.push(message);
      transferCounts.push(transferables.length);
    },
    yieldControl: async () => {},
  });
  const firstHeader = createDrawingWorkerJobHeader(1, 1, stamp());
  assert.equal(await processor.handleMessage(request(
    firstHeader,
    viewport("first"),
    [upsert("first", 1, [0, 0, 1, 1, 2, 2, 3, 3])],
  )), true);
  const first = responses[0];
  assert.equal(first?.type, "drawing-worker/result");
  if (first?.type === "drawing-worker/result") {
    assert.equal(first.result.rawPointCount, 4);
    assert.equal(first.result.renderedPointCount, 2);
    assert.equal(first.result.canonicalEntityCount, 1);
  }
  assert.equal(transferCounts[0], 8);

  const secondHeader = createDrawingWorkerJobHeader(
    2,
    2,
    stamp({ documentRevision: 2, viewportRevision: 7 }),
  );
  await processor.handleMessage(request(
    secondHeader,
    viewport("second"),
    [remove("first", 2), upsert("second", 2)],
  ));
  assert.deepEqual(processor.snapshot().scopes, [{
    scopeKey: "scope",
    documentRevision: 2,
    entityIds: ["second"],
    canonicalPointCount: 3,
    lodEntityCount: 1,
    lodFinitePointCount: 3,
    lodGapPointCount: 0,
    lodPathCount: 1,
    lodEndpointPointCount: 2,
    lodHierarchyBuildCount: 2,
    screenLodEntityCount: 1,
    screenLodFinitePointCount: 2,
    screenLodGapPointCount: 0,
    screenLodPathCount: 1,
    screenLodEndpointPointCount: 2,
    screenLodHierarchyBuildCount: 2,
    screenLodHierarchyReuseCount: 0,
    renderedPointCount: 2,
    paintedEntityCount: 1,
  }]);
});

test("processor builds reusable canonical and final-screen LOD mirrors without mutating canonical geometry", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: async () => {},
  });
  const canonical = [
    0, 0,
    1, 1,
    2, 0,
    Number.NaN, Number.NaN,
    10, 0,
    11, 1,
    12, 0,
  ];
  const immutableBefore = [...canonical];
  const sharedStamp = stamp();
  const screenViewport = (): DrawingWorkerViewportPayload => ({
    ...viewport("stroke", [
      0, 0,
      1, 1,
      10, 10,
      Number.NaN, Number.NaN,
      20, 20,
      21, 21,
    ]),
    bboxes: new Float64Array([0, 0, 21, 21]),
    pathBreakCounts: new Uint32Array([1]),
    pathBreaks: new Uint32Array([2]),
  });
  await processor.handleMessage(request(
    createDrawingWorkerJobHeader(1, 1, sharedStamp),
    screenViewport(),
    [upsert("stroke", 1, canonical, { geometryRevision: 10, pathBreaks: [2] })],
  ));
  assert.deepEqual(canonical, immutableBefore, "LOD derivation cannot rewrite canonical coordinates");
  assert.deepEqual(processor.snapshot().scopes[0], {
    scopeKey: "scope",
    documentRevision: 1,
    entityIds: ["stroke"],
    canonicalPointCount: 7,
    lodEntityCount: 1,
    lodFinitePointCount: 6,
    lodGapPointCount: 1,
    lodPathCount: 3,
    lodEndpointPointCount: 5,
    lodHierarchyBuildCount: 1,
    screenLodEntityCount: 1,
    screenLodFinitePointCount: 5,
    screenLodGapPointCount: 1,
    screenLodPathCount: 3,
    screenLodEndpointPointCount: 5,
    screenLodHierarchyBuildCount: 1,
    screenLodHierarchyReuseCount: 0,
    renderedPointCount: 6,
    paintedEntityCount: 1,
  });

  await processor.handleMessage(request(
    createDrawingWorkerJobHeader(2, 2, sharedStamp),
    screenViewport(),
  ));
  let snapshot = processor.snapshot().scopes[0];
  assert.equal(snapshot?.lodHierarchyBuildCount, 1, "unchanged patch state reuses canonical LOD");
  assert.equal(snapshot?.screenLodHierarchyBuildCount, 1);
  assert.equal(snapshot?.screenLodHierarchyReuseCount, 1, "same final screen layer is reused");

  await processor.handleMessage(request(
    createDrawingWorkerJobHeader(3, 3, stamp({ documentRevision: 2 })),
    screenViewport(),
    [upsert("stroke", 2, canonical, {
      geometryRevision: 10,
      styleRevision: 2,
      pathBreaks: [2],
    })],
  ));
  snapshot = processor.snapshot().scopes[0];
  assert.equal(snapshot?.lodHierarchyBuildCount, 1, "style-only patches retain nested geometry");
  assert.equal(snapshot?.lodFinitePointCount, 6);

  const replacement = [...canonical];
  replacement[2] = 1.5;
  await processor.handleMessage(request(
    createDrawingWorkerJobHeader(4, 4, stamp({ documentRevision: 3 })),
    screenViewport(),
    [upsert("stroke", 3, replacement, {
      geometryRevision: 10,
      styleRevision: 2,
      pathBreaks: [2],
    })],
  ));
  snapshot = processor.snapshot().scopes[0];
  assert.equal(
    snapshot?.lodHierarchyBuildCount,
    2,
    "same local revision cannot reuse a hierarchy when replacement geometry differs",
  );
  assert.equal(responses.length, 4);
});

test("processor observes cooperative generation cancellation at a yield boundary", async () => {
  const responses: DrawingWorkerResponse[] = [];
  let resume: (() => void) | null = null;
  let firstYield = true;
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: () => {
      if (!firstYield) return Promise.resolve();
      firstYield = false;
      return new Promise<void>((resolve) => { resume = resolve; });
    },
  });
  const header = createDrawingWorkerJobHeader(1, 4, stamp());
  const work = processor.handleMessage(request(header, viewport(), [upsert("stroke", 1)]));
  await Promise.resolve();
  await processor.handleMessage({
    type: "drawing-worker/cancel",
    schemaVersion: 1,
    throughGeneration: 4,
  });
  const continueWork = resume as (() => void) | null;
  assert.ok(continueWork);
  continueWork();
  await work;
  assert.deepEqual(responses, [{ type: "drawing-worker/cancelled", header }]);
  assert.equal(processor.snapshot().cancelledThroughGeneration, 4);
  assert.deepEqual(processor.snapshot().scopes[0]?.entityIds, ["stroke"]);
});

test("processor cancels between canonical paths and resumes the missing LOD mirror on the next job", async () => {
  const responses: DrawingWorkerResponse[] = [];
  let yieldCount = 0;
  let resume: (() => void) | null = null;
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: () => {
      yieldCount += 1;
      if (yieldCount !== 2) return Promise.resolve();
      return new Promise<void>((resolve) => { resume = resolve; });
    },
  });
  const firstHeader = createDrawingWorkerJobHeader(1, 4, stamp());
  const work = processor.handleMessage(request(
    firstHeader,
    viewport(),
    [upsert("stroke", 1, [0, 0, 1, 1, 10, 10, 11, 11], { pathBreaks: [2] })],
  ));
  while (!resume) await Promise.resolve();
  await processor.handleMessage({
    type: "drawing-worker/cancel",
    schemaVersion: 1,
    throughGeneration: 4,
  });
  const continueWork = resume as (() => void) | null;
  assert.ok(continueWork);
  continueWork();
  await work;
  assert.deepEqual(responses, [{ type: "drawing-worker/cancelled", header: firstHeader }]);
  let snapshot = processor.snapshot().scopes[0];
  assert.deepEqual(snapshot?.entityIds, ["stroke"], "canonical patch remains mirrored after cancel");
  assert.equal(snapshot?.lodEntityCount, 0, "partial hierarchy is never published");
  assert.equal(snapshot?.lodHierarchyBuildCount, 0);
  assert.equal(snapshot?.screenLodEntityCount, 0);

  const nextHeader = createDrawingWorkerJobHeader(
    2,
    5,
    stamp({ viewportRevision: 7 }),
  );
  await processor.handleMessage(request(nextHeader, viewport()));
  snapshot = processor.snapshot().scopes[0];
  assert.equal(snapshot?.lodEntityCount, 1);
  assert.equal(snapshot?.lodPathCount, 2);
  assert.equal(snapshot?.lodEndpointPointCount, 4);
  assert.equal(snapshot?.lodHierarchyBuildCount, 1);
  assert.equal(responses.at(-1)?.type, "drawing-worker/result");
});

test("processor fails closed on an invalid request that still has a valid header", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: async () => {},
  });
  const header = createDrawingWorkerJobHeader(1, 1, stamp());
  assert.equal(await processor.handleMessage({ ...request(header, viewport()), maxResultBytes: 1 }), false);
  assert.deepEqual(responses, [{
    type: "drawing-worker/error",
    header,
    code: "invalid-request",
    message: "drawing worker request is invalid",
  }]);
});

test("bitmap cleanup closes transferable resources when that optional backend is used", () => {
  let closed = 0;
  const result = {
    kind: "bitmap-draw-result",
    bitmap: { close: () => { closed += 1; } } as ImageBitmap,
    widthCssPx: 100,
    heightCssPx: 50,
    dpr: 2,
    atlasWidthPhysicalPx: 200,
    atlasHeightPhysicalPx: 100,
    byteLength: drawingWorkerBitmapByteLength({ widthCssPx: 100, heightCssPx: 50, dpr: 2 }),
    layers: [{
      entityIndex: 0,
      lastEntityIndex: 0,
      sourceXPhysicalPx: 0,
      sourceYPhysicalPx: 0,
      sourceWidthPhysicalPx: 200,
      sourceHeightPhysicalPx: 100,
      destinationXCssPx: 0,
      destinationYCssPx: 0,
      destinationWidthCssPx: 100,
      destinationHeightCssPx: 50,
      opacity: 1,
      compositeOperation: "source-over",
    }],
    rawPointCount: 2,
    renderedPointCount: 2,
    canonicalEntityCount: 1,
  } satisfies DrawingWorkerDrawResult;
  releaseDrawingWorkerDrawResult(result);
  assert.equal(closed, 1);
});

class FakeRasterContext {
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  lineWidth = 1;
  globalCompositeOperation: GlobalCompositeOperation = "source-over";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  globalAlpha = 1;
  readonly strokes: Array<{
    strokeStyle: string | CanvasGradient | CanvasPattern;
    lineWidth: number;
    globalAlpha: number;
    globalCompositeOperation: GlobalCompositeOperation;
    lineCap: CanvasLineCap;
    lineJoin: CanvasLineJoin;
    commands: readonly string[];
  }> = [];
  #commands: string[] = [];

  save(): void {}
  restore(): void {}
  beginPath(): void { this.#commands = []; }
  rect(x: number, y: number, width: number, height: number): void {
    this.#commands.push(`R${x},${y},${width},${height}`);
  }
  clip(): void {}
  moveTo(x: number, y: number): void { this.#commands.push(`M${x},${y}`); }
  lineTo(x: number, y: number): void { this.#commands.push(`L${x},${y}`); }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.#commands.push(`Q${cpx},${cpy},${x},${y}`);
  }
  stroke(): void {
    this.strokes.push({
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      commands: [...this.#commands],
    });
  }
}

test("processor releases a bitmap before reporting failed result delivery", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const context = new FakeRasterContext();
  let bitmapCloseCount = 0;
  const processor = createDrawingWorkerProcessor({
    postMessage(message) {
      if (message.type === "drawing-worker/result") throw new Error("result post failed");
      responses.push(message);
    },
    yieldControl: async () => {},
    offscreenCanvasFactory(width, height) {
      return {
        getContext: () => context,
        transferToImageBitmap: () => ({
          close: () => { bitmapCloseCount += 1; },
          width,
          height,
        } as ImageBitmap),
      };
    },
  });

  const header = createDrawingWorkerJobHeader(1, 1, stamp());
  assert.equal(await processor.handleMessage(request(
    header,
    viewport("post-failure"),
    [upsert("post-failure", 1)],
  )), true);
  assert.equal(bitmapCloseCount, 1);
  assert.deepEqual(responses, [{
    type: "drawing-worker/error",
    header,
    code: "processing-failed",
    message: "result post failed",
  }]);
});

test("processor paints a bounded DPR bitmap in canonical z order with serialized brush state", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const transferCounts: number[] = [];
  const context = new FakeRasterContext();
  const factoryDimensions: number[][] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage(message, transferables) {
      responses.push(message);
      transferCounts.push(transferables.length);
    },
    yieldControl: async () => {},
    offscreenCanvasFactory(width, height) {
      factoryDimensions.push([width, height]);
      return {
        getContext: () => context,
        transferToImageBitmap: () => ({ close() {}, width, height } as ImageBitmap),
      };
    },
  });
  const payload: DrawingWorkerViewportPayload = {
    widthCssPx: 800,
    heightCssPx: 400,
    dpr: 1.5,
    entityIds: ["back", "front"],
    kindCodes: new Uint8Array([8, 9]),
    pointOffsets: new Uint32Array([0, 3]),
    pointCounts: new Uint32Array([3, 3]),
    points: new Float64Array([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]),
    bboxes: new Float64Array([1, 1, 3, 3, 4, 4, 6, 6]),
    pathBreakOffsets: new Uint32Array([0, 0]),
    pathBreakCounts: new Uint32Array([0, 0]),
    pathBreaks: new Uint32Array(),
    paintSpecs: [{
      entityIndex: 1,
      strokeColor: "#ffff00",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 12,
      opacity: 0.25,
      compositeOperation: "multiply",
      brushShape: "square",
      pathInterpolation: "linear",
      selected: false,
    }, {
      entityIndex: 0,
      strokeColor: "#0000ff",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 2,
      opacity: 0.9,
      compositeOperation: "source-over",
      brushShape: "round",
      pathInterpolation: "quadratic",
      selected: true,
    }],
  };
  const header = createDrawingWorkerJobHeader(1, 1, stamp());
  await processor.handleMessage(request(header, payload, [
    upsert("back", 1),
    upsert("front", 1),
  ]));
  assert.deepEqual(factoryDimensions, [[24, 33]]);
  assert.equal(responses[0]?.type, "drawing-worker/result");
  if (responses[0]?.type === "drawing-worker/result") {
    assert.equal(responses[0].result.kind, "bitmap-draw-result");
    assert.equal(responses[0].result.byteLength, 24 * 33 * 4);
    assert.equal(responses[0].result.renderedPointCount, 6);
    if (responses[0].result.kind === "bitmap-draw-result") {
      assert.deepEqual(responses[0].result.layers.map((layer) => ({
        entityIndex: layer.entityIndex,
        lastEntityIndex: layer.lastEntityIndex,
        opacity: layer.opacity,
        compositeOperation: layer.compositeOperation,
      })), [{
        entityIndex: 0,
        lastEntityIndex: 0,
        opacity: 0.6,
        compositeOperation: "source-over",
      }, {
        entityIndex: 1,
        lastEntityIndex: 1,
        opacity: 0.25,
        compositeOperation: "multiply",
      }]);
    }
  }
  assert.equal(transferCounts[0], 1);
  assert.deepEqual(context.strokes.map((stroke) => ({
    color: stroke.strokeStyle,
    width: stroke.lineWidth,
    alpha: stroke.globalAlpha,
    composite: stroke.globalCompositeOperation,
    cap: stroke.lineCap,
  })), [{
    color: "#ff6b6b",
    width: 3,
    alpha: 1,
    composite: "source-over",
    cap: "round",
  }, {
    color: "#ffff00",
    width: 18,
    alpha: 1,
    composite: "source-over",
    cap: "square",
  }]);
  assert.ok(context.strokes[0]?.commands.some((command) => command.startsWith("Q")));
  assert.ok(context.strokes[1]?.commands.some((command) => command.startsWith("L")));
});

test("processor retains the typed fallback when the bitmap backing store exceeds its byte budget", async () => {
  const responses: DrawingWorkerResponse[] = [];
  let factoryCalls = 0;
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: async () => {},
    maxAllowedResultBytes: 1_000,
    offscreenCanvasFactory: () => {
      factoryCalls += 1;
      return null;
    },
  });
  const header = createDrawingWorkerJobHeader(1, 1, stamp());
  await processor.handleMessage(request(header, viewport(), [upsert("stroke", 1)]));
  assert.equal(factoryCalls, 0, "oversized bitmap allocation is rejected before factory use");
  assert.equal(responses[0]?.type, "drawing-worker/result");
  if (responses[0]?.type === "drawing-worker/result") {
    assert.equal(responses[0].result.kind, "typed-draw-result");
  }
});

test("processor retains the typed fallback when OffscreenCanvas is unavailable", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const transferCounts: number[] = [];
  let factoryCalls = 0;
  const processor = createDrawingWorkerProcessor({
    postMessage(message, transferables) {
      responses.push(message);
      transferCounts.push(transferables.length);
    },
    yieldControl: async () => {},
    offscreenCanvasFactory: () => {
      factoryCalls += 1;
      return null;
    },
  });
  const payload: DrawingWorkerViewportPayload = {
    ...viewport("offscreen-unavailable", [2, 2, 8, 8]),
    widthCssPx: 32,
    heightCssPx: 24,
    dpr: 1,
  };
  const header = createDrawingWorkerJobHeader(7, 9, stamp({
    widthCssPx: payload.widthCssPx,
    heightCssPx: payload.heightCssPx,
    dpr: payload.dpr,
  }));

  assert.equal(await processor.handleMessage(request(
    header,
    payload,
    [upsert("offscreen-unavailable", 1)],
  )), true);
  assert.equal(factoryCalls, 1, "a valid bounded bitmap request probes capability exactly once");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.type, "drawing-worker/result");
  if (responses[0]?.type === "drawing-worker/result") {
    assert.deepEqual(responses[0].header, header);
    assert.equal(responses[0].result.kind, "typed-draw-result");
    if (responses[0].result.kind === "typed-draw-result") {
      assert.equal(responses[0].result.widthCssPx, payload.widthCssPx);
      assert.equal(responses[0].result.heightCssPx, payload.heightCssPx);
      assert.equal(responses[0].result.dpr, payload.dpr);
      assert.deepEqual(responses[0].result.entityIds, payload.entityIds);
      assert.deepEqual(responses[0].result.pointCounts, payload.pointCounts);
      assert.equal(responses[0].result.rawPointCount, 3);
      assert.equal(responses[0].result.renderedPointCount, 2);
      assert.equal(responses[0].result.canonicalEntityCount, 1);
      assert.equal(responses[0].result.byteLength, drawingWorkerViewportByteLength(payload));
    }
  }
  assert.deepEqual(transferCounts, [8]);
});

test("processor groups only consecutive opaque source-over freehands into one atlas layer", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const context = new FakeRasterContext();
  const factoryDimensions: number[][] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: async () => {},
    offscreenCanvasFactory(width, height) {
      factoryDimensions.push([width, height]);
      return {
        getContext: () => context,
        transferToImageBitmap: () => ({ close() {}, width, height } as ImageBitmap),
      };
    },
  });
  const makePaintSpec = (entityIndex: number) => ({
    entityIndex,
    strokeColor: `rgb(${entityIndex}, 0, 0)`,
    selectionHighlightColor: "#ff6b6b",
    lineWidthCssPx: 2,
    opacity: 1,
    compositeOperation: "source-over" as const,
    brushShape: "round" as const,
    pathInterpolation: "quadratic" as const,
    selected: false,
  });
  const payload: DrawingWorkerViewportPayload = {
    widthCssPx: 800,
    heightCssPx: 400,
    dpr: 1.5,
    entityIds: ["zero", "one", "interleaved-line", "three"],
    kindCodes: new Uint8Array([8, 8, 1, 8]),
    pointOffsets: new Uint32Array([0, 2, 4, 6]),
    pointCounts: new Uint32Array([2, 2, 2, 2]),
    points: new Float64Array([
      0, 0, 10, 10,
      0, 10, 10, 0,
      0, 5, 10, 5,
      5, 0, 5, 10,
    ]),
    bboxes: new Float64Array([
      0, 0, 10, 10,
      0, 0, 10, 10,
      0, 0, 10, 10,
      0, 0, 10, 10,
    ]),
    pathBreakOffsets: new Uint32Array([0, 0, 0, 0]),
    pathBreakCounts: new Uint32Array([0, 0, 0, 0]),
    pathBreaks: new Uint32Array(),
    paintSpecs: [makePaintSpec(0), makePaintSpec(1), makePaintSpec(3)],
  };
  const header = createDrawingWorkerJobHeader(1, 1, stamp());
  await processor.handleMessage(request(header, payload, [
    upsert("zero", 1),
    upsert("one", 1),
    upsert("three", 1),
  ]));
  assert.deepEqual(factoryDimensions, [[19, 38]]);
  const response = responses[0];
  assert.equal(isDrawingWorkerResponse(response), true);
  assert.equal(response?.type, "drawing-worker/result");
  if (response?.type === "drawing-worker/result"
    && response.result.kind === "bitmap-draw-result") {
    assert.deepEqual(response.result.layers.map((layer) => [
      layer.entityIndex,
      layer.lastEntityIndex,
    ]), [[0, 1], [3, 3]]);
    assert.equal(response.result.byteLength, 19 * 38 * 4);
  }
  assert.equal(context.strokes.length, 3, "every grouped entity is painted once in z order");
});

test("DPR2 atlas padding retains thick round and square caps without crossing pane bounds", async () => {
  const responses: DrawingWorkerResponse[] = [];
  const context = new FakeRasterContext();
  const factoryDimensions: number[][] = [];
  const processor = createDrawingWorkerProcessor({
    postMessage: (message) => responses.push(message),
    yieldControl: async () => {},
    offscreenCanvasFactory(width, height) {
      factoryDimensions.push([width, height]);
      return {
        getContext: () => context,
        transferToImageBitmap: () => ({ close() {}, width, height } as ImageBitmap),
      };
    },
  });
  const payload: DrawingWorkerViewportPayload = {
    widthCssPx: 100,
    heightCssPx: 80,
    dpr: 2,
    entityIds: ["round-edge", "square-inside"],
    kindCodes: new Uint8Array([8, 8]),
    pointOffsets: new Uint32Array([0, 2]),
    pointCounts: new Uint32Array([2, 2]),
    points: new Float64Array([1, 10, 30, 10, 40, 40, 60, 40]),
    bboxes: new Float64Array([1, 10, 30, 10, 40, 40, 60, 40]),
    pathBreakOffsets: new Uint32Array([0, 0]),
    pathBreakCounts: new Uint32Array([0, 0]),
    pathBreaks: new Uint32Array(),
    paintSpecs: [{
      entityIndex: 0,
      strokeColor: "#0000ff",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 20,
      opacity: 0.8,
      compositeOperation: "source-over",
      brushShape: "round",
      pathInterpolation: "quadratic",
      selected: false,
    }, {
      entityIndex: 1,
      strokeColor: "#00ff00",
      selectionHighlightColor: "#ff6b6b",
      lineWidthCssPx: 20,
      opacity: 0.8,
      compositeOperation: "source-over",
      brushShape: "square",
      pathInterpolation: "linear",
      selected: false,
    }],
  };
  await processor.handleMessage(request(
    createDrawingWorkerJobHeader(1, 1, stamp({ widthCssPx: 100, heightCssPx: 80, dpr: 2 })),
    payload,
    [upsert("round-edge", 1), upsert("square-inside", 1)],
  ));
  assert.deepEqual(factoryDimensions, [[102, 104]]);
  const response = responses[0];
  assert.equal(response?.type, "drawing-worker/result");
  if (response?.type !== "drawing-worker/result"
    || response.result.kind !== "bitmap-draw-result") return;
  const [roundLayer, squareLayer] = response.result.layers;
  assert.deepEqual(roundLayer && {
    x: roundLayer.destinationXCssPx,
    y: roundLayer.destinationYCssPx,
    width: roundLayer.destinationWidthCssPx,
    height: roundLayer.destinationHeightCssPx,
  }, { x: 0, y: 0, width: 41, height: 21 });
  assert.deepEqual(squareLayer && {
    x: squareLayer.destinationXCssPx,
    y: squareLayer.destinationYCssPx,
    width: squareLayer.destinationWidthCssPx,
    height: squareLayer.destinationHeightCssPx,
  }, { x: 24.5, y: 24.5, width: 51, height: 31 });
  assert.ok((squareLayer?.destinationXCssPx ?? 40) < 40);
  assert.ok((squareLayer?.destinationXCssPx ?? 0)
    + (squareLayer?.destinationWidthCssPx ?? 0) > 60);
  assert.ok(response.result.layers.every((layer) => (
    layer.destinationXCssPx >= 0
    && layer.destinationYCssPx >= 0
    && layer.destinationXCssPx + layer.destinationWidthCssPx <= payload.widthCssPx
    && layer.destinationYCssPx + layer.destinationHeightCssPx <= payload.heightCssPx
  )), "stroke padding is clamped only at the pane boundary");
});
