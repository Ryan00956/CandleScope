import assert from "node:assert/strict";
import test from "node:test";

import { resolveDrawingRasterBackend } from "../drawingRasterBackend.js";

test("drawing raster backend defaults to worker and rejects invalid values", () => {
  assert.deepEqual(resolveDrawingRasterBackend({ configured: undefined }), {
    requested: "worker",
    effective: "worker",
    source: "default",
    failedClosed: false,
    workerResultDeliveryDelayMs: 0,
  });
  assert.deepEqual(resolveDrawingRasterBackend({ configured: "invalid" }), {
    requested: "worker",
    effective: "worker",
    source: "default",
    failedClosed: true,
    workerResultDeliveryDelayMs: 0,
  });
});

test("drawing raster backend supports a mount-locked same-scene fallback", () => {
  assert.deepEqual(resolveDrawingRasterBackend({ configured: "main-thread" }), {
    requested: "main-thread",
    effective: "main-thread",
    source: "environment",
    failedClosed: false,
    workerResultDeliveryDelayMs: 0,
  });
  assert.deepEqual(resolveDrawingRasterBackend({
    configured: "worker",
    forceMainThreadFallback: true,
  }), {
    requested: "worker",
    effective: "main-thread",
    source: "benchmark-fallback",
    failedClosed: false,
    workerResultDeliveryDelayMs: 0,
  });
});

test("drawing raster backend normalizes the benchmark-only worker delivery delay", () => {
  assert.deepEqual(resolveDrawingRasterBackend({
    configured: "worker",
    workerResultDeliveryDelayMs: 32.9,
  }), {
    requested: "worker",
    effective: "worker",
    source: "environment",
    failedClosed: false,
    workerResultDeliveryDelayMs: 32,
  });
  assert.equal(resolveDrawingRasterBackend({
    workerResultDeliveryDelayMs: Number.POSITIVE_INFINITY,
  }).workerResultDeliveryDelayMs, 0);
  assert.equal(resolveDrawingRasterBackend({
    workerResultDeliveryDelayMs: 50_000,
  }).workerResultDeliveryDelayMs, 1_000);
});
