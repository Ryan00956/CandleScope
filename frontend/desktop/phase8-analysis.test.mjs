import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMemoryWarmupPlateau,
  analyzePhase8Soak,
  histogramPercentileDelta,
  percentile,
} from "./phase8-analysis.mjs";

function sample(atMs, factor = 1, authoritative = 0) {
  return {
    atMs,
    windows: Array.from({ length: 4 }, (_, index) => ({
      process: { privateBytes: (100 + index) * factor },
      renderer: {
        chartRoots: 16,
        heapUsedBytes: (50 + index) * factor,
        authoritativeCommits: authoritative / 4,
        metrics: {
          inputLatencies: [20, 30],
          longTasks: [],
        },
        broker: { klineStream: { counts: { closed: authoritative / 4, amended: 0, parseErrors: 0 } } },
        scheduler: { pendingAsync: 0, pendingFrames: 0 },
        indicators: { runtimeCount: 16, definitionCount: 32, issueCount: 0 },
      },
    })),
    backend: {
      dataManager: { activeSeries: 64, leasedSeries: 64, streamLeases: 64, uniqueLeaseConsumers: 64 },
      klineBatch: {
        websocket_connections: 4,
        logical_clients: 64,
        logical_series: 64,
        logical_subscriptions: 64,
        outbox_depth: 0,
        outbox_dropped_replaceable: 0,
        outbox_authoritative_timeouts: 0,
        item_failures: 0,
        interval_failures: 0,
        limits: { outboxSize: 1_024 },
        sent_by_type: { "bar.closed": authoritative },
        connections: [{ item_failures: 0, sent_by_type: { "bar.closed": authoritative } }],
      },
      runtime: {
        eventLoopLag: {
          p99_ms: 20,
          histogram: {
            bucket_width_ms: 1,
            max_ms: 1_000,
            counts: [0, authoritative + 1],
          },
        },
        processMemory: { privateBytes: 1_000 * factor },
      },
    },
  };
}

test("percentile uses the nearest-rank release definition", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.equal(percentile([], 0.95), null);
});

test("memory warmup requires a bounded plateau instead of a fixed delay", () => {
  assert.equal(analyzeMemoryWarmupPlateau([350, 380, 405, 420]).pass, false);
  const plateau = analyzeMemoryWarmupPlateau([425, 431, 430, 432, 429]);
  assert.equal(plateau.pass, true);
  assert.ok(plateau.spreadPercent < 5);
  assert.ok(plateau.trendPercent < 5);

  assert.equal(analyzeMemoryWarmupPlateau([400, 405, 412, 420, 430]).pass, false);
});

test("bounded exact W3 samples pass a short analysis contract", () => {
  const evidence = analyzePhase8Soak([
    sample(0, 1, 0),
    sample(500, 1.03, 4),
    sample(1_000, 1.02, 8),
  ], { requiredDurationMs: 1_000 });
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.measurements.authoritative.sentClosed, 8);
  assert.equal(evidence.measurements.authoritative.committedAuthoritative, 8);
});

test("monotonic memory, parse loss, and a shortened run fail closed", () => {
  const samples = [
    sample(0, 1, 0),
    sample(500, 1.15, 4),
    sample(1_000, 1.30, 8),
  ];
  samples.at(-1).windows[0].renderer.broker.klineStream.counts.parseErrors = 1;
  const evidence = analyzePhase8Soak(samples, { requiredDurationMs: 2_000 });
  assert.equal(evidence.result, "fail");
  assert.equal(evidence.gates.fullDuration, false);
  assert.equal(evidence.gates.noSilentTransportFailure, false);
  assert.equal(evidence.gates.heapBoundedAndPlateaued, false);
});

test("bounded transient queue work is allowed but overflow evidence fails closed", () => {
  const samples = [sample(0, 1, 0), sample(500, 1.03, 4), sample(1_000, 1.02, 8)];
  samples[1].windows[0].renderer.scheduler.pendingFrames = 8;
  samples[1].backend.klineBatch.outbox_depth = 7;
  assert.equal(analyzePhase8Soak(samples, { requiredDurationMs: 1_000 }).gates.queuesBounded, true);

  samples[1].backend.klineBatch.outbox_dropped_replaceable = 1;
  assert.equal(analyzePhase8Soak(samples, { requiredDurationMs: 1_000 }).gates.queuesBounded, false);
});

test("cumulative event-loop histogram is evaluated over the release window", () => {
  const samples = [sample(0, 1, 0), sample(1_000, 1.02, 100)];
  samples[0].backend.runtime.eventLoopLag.histogram.counts = [0, 10, 0, 0];
  samples[1].backend.runtime.eventLoopLag.histogram.counts = [0, 109, 0, 1];
  samples[0].backend.runtime.eventLoopLag.histogram.max_ms = 2;
  samples[1].backend.runtime.eventLoopLag.histogram.max_ms = 2;
  const evidence = analyzePhase8Soak(samples, { requiredDurationMs: 1_000 });
  assert.equal(evidence.measurements.eventLoopLagP99Ms, 1);
  assert.equal(evidence.gates.eventLoopLag, true);

  samples[1].backend.runtime.eventLoopLag.histogram.counts = [0, 108, 0, 2];
  const failed = analyzePhase8Soak(samples, { requiredDurationMs: 1_000 });
  assert.equal(failed.measurements.eventLoopLagP99Ms, 3);
});

test("short release windows exclude event-loop samples captured before the baseline", () => {
  const baseline = { bucket_width_ms: 1, max_ms: 1000, counts: [99, 0, 0, 0, 1] };
  const current = { bucket_width_ms: 1, max_ms: 1000, counts: [198, 1, 0, 0, 1] };
  assert.equal(histogramPercentileDelta(baseline, current, 0.99), 0);
});
