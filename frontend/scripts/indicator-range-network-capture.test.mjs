import assert from "node:assert/strict";
import test from "node:test";

import {
  createIndicatorRangeNetworkCapture,
  summarizeIndicatorRangeRequests,
} from "./indicator-range-network-capture.mjs";

class FakeCdp {
  constructor() {
    this.handlers = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }

  async send(method) {
    if (method === "Network.getResponseBody") {
      return {
        body: JSON.stringify({
          ok: false,
          code: "INDICATOR_RANGE_NOT_READY",
          detail: { range: { start: 100, end: 200 } },
        }),
        base64Encoded: false,
      };
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  }
}

test("captures indicator range request metadata, bytes, and logical response code", async () => {
  let nowMs = 1_000;
  const cdp = new FakeCdp();
  const capture = createIndicatorRangeNetworkCapture(cdp, { now: () => nowMs });
  const postData = JSON.stringify({
    clientId: "macd",
    name: "MACD",
    reason: "initial-visible",
    start: 100,
    end: 200,
  });

  cdp.emit("Network.requestWillBeSent", {
    requestId: "preflight-1",
    request: {
      method: "OPTIONS",
      url: "http://127.0.0.1:18080/api/v1/indicators/range",
    },
  });

  cdp.emit("Network.requestWillBeSent", {
    requestId: "request-1",
    request: {
      method: "POST",
      url: "http://127.0.0.1:18080/api/v1/indicators/range",
      postData,
    },
  });
  nowMs = 1_050;
  cdp.emit("Network.responseReceived", {
    requestId: "request-1",
    response: { status: 200, encodedDataLength: 120 },
  });
  nowMs = 1_100;
  cdp.emit("Network.loadingFinished", {
    requestId: "request-1",
    encodedDataLength: 456,
  });
  await capture.flush();

  assert.deepEqual(capture.summary(), {
    requestCount: 1,
    logicalRequestCount: 1,
    completedCount: 1,
    failedCount: 0,
    canceledCount: 0,
    totalEncodedBytes: 456,
    requestedRanges: [{
      clientId: "macd",
      indicator: "MACD",
      reason: "initial-visible",
      start: 100,
      end: 200,
    }],
    reasons: { "initial-visible": 1 },
    statuses: { 200: 1 },
    logicalCodes: { INDICATOR_RANGE_NOT_READY: 1 },
    phases: { startup: 1 },
  });
});

test("summaries can isolate the measured short-switch phases", () => {
  const summary = summarizeIndicatorRangeRequests([
    {
      phase: "short-switch-warm:15m",
      requestBody: { reason: "initial-visible", start: 10, end: 20 },
      encodedDataLength: 100,
    },
    {
      phase: "short-switch-measured:3m",
      requestBody: { reason: "window-delta", start: 30, end: 40 },
      encodedDataLength: 200,
    },
  ], { phasePrefix: "short-switch-measured:" });

  assert.equal(summary.requestCount, 1);
  assert.equal(summary.logicalRequestCount, 1);
  assert.equal(summary.totalEncodedBytes, 200);
  assert.deepEqual(summary.reasons, { "window-delta": 1 });
});

test("counts batch range requests as one physical request with multiple logical ranges", () => {
  const summary = summarizeIndicatorRangeRequests([{
    phase: "cold-load",
    requestBody: {
      requests: [
        { clientId: "vol", name: "VOL", start: 10, end: 20 },
        { clientId: "macd", name: "MACD", start: 10, end: 20 },
      ],
    },
    encodedDataLength: 512,
  }]);

  assert.equal(summary.requestCount, 1);
  assert.equal(summary.logicalRequestCount, 2);
  assert.equal(summary.requestedRanges.length, 2);
  assert.equal(summary.totalEncodedBytes, 512);
});
