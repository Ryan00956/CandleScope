import assert from "node:assert/strict";
import test from "node:test";

import {
  assessIndicatorStackSample,
  compactStorageHealth,
  isForegroundBackfillReason,
  summarizeIndicatorStackMonitoring,
} from "./indicator-stack-monitor-core.mjs";

test("foreground reason classification treats promoted audit demand as foreground", () => {
  assert.equal(isForegroundBackfillReason("background_gap_audit"), false);
  assert.equal(isForegroundBackfillReason("background_gap_audit+initial_history"), true);
  assert.equal(isForegroundBackfillReason("visible_range_gap"), true);
});

test("storage diagnostics flag foreground work stranded in a spare scheduler slot", () => {
  const storage = compactStorageHealth({
    status: "ok",
    open_gap_count: 1,
    backfill: {
      ready_chunks: 2,
      running_chunks: 1,
      max_concurrency: 4,
      next_drain_in_ms: null,
      pending: [{
        series: "binance:spot:BTCUSDT:1h",
        reason: "background_gap_audit+initial_history",
        priority: 10,
        pending_chunks: 1,
      }],
    },
  });

  assert.equal(storage.scheduler.foregroundUndrained, true);
  assert.deepEqual(assessIndicatorStackSample({
    browser: { readyState: "complete", barCount: 1500 },
    frontend: { runtimes: [] },
    backend: { storage },
  }), [
    "frontend-indicator-diagnostics-unavailable",
    "scheduler-foreground-undrained",
  ]);
});

test("monitor summary combines sampled, browser, and logical transport failures", () => {
  const summary = summarizeIndicatorStackMonitoring({
    startedAtMs: 100,
    endedAtMs: 1100,
    samples: [{ issues: ["visible-indicator-no-data"] }],
    events: [
      { type: "console-error" },
      { type: "websocket-frame" },
    ],
    indicatorRange: {
      requestCount: 1,
      logicalCodes: { INDICATOR_RANGE_NOT_READY: 1 },
    },
  });

  assert.equal(summary.clean, false);
  assert.equal(summary.durationMs, 1000);
  assert.deepEqual(summary.issueCounts, {
    "visible-indicator-no-data": 1,
    "browser-console-errors": 1,
    "indicator-range-logical-errors": 1,
  });
});

test("monitor only promotes a pending frontend gate after it remains stalled", () => {
  const short = summarizeIndicatorStackMonitoring({
    startedAtMs: 0,
    endedAtMs: 5_000,
    samples: [0, 5_000].map((atMs) => ({
      atMs,
      frontend: { runtimes: [{ gates: ["initial-hydration-unsettled"] }] },
      issues: [],
    })),
  });
  assert.equal(short.issueCounts["initial-hydration-stalled"], undefined);

  const stalled = summarizeIndicatorStackMonitoring({
    startedAtMs: 0,
    endedAtMs: 12_000,
    samples: [0, 6_000, 12_000].map((atMs) => ({
      atMs,
      frontend: { runtimes: [{ gates: ["initial-hydration-unsettled"] }] },
      issues: [],
    })),
  });
  assert.equal(stalled.issueCounts["initial-hydration-stalled"], 12_000);
});

test("monitor ignores unrelated gaps and promotes a current-series gap only when stalled", () => {
  const sample = (atMs, marketType) => ({
    atMs,
    frontend: {
      runtimes: [{
        context: {
          exchange: "binance",
          marketType: "spot",
          symbol: "BTCUSDT",
          interval: "1h",
        },
      }],
    },
    backend: {
      storage: {
        openGaps: [{
          exchange: "binance",
          marketType,
          symbol: "BTCUSDT",
          interval: "1h",
        }],
      },
    },
    issues: [],
  });
  const unrelated = summarizeIndicatorStackMonitoring({
    startedAtMs: 0,
    endedAtMs: 12_000,
    samples: [sample(0, "futures"), sample(12_000, "futures")],
  });
  assert.equal(unrelated.issueCounts["current-series-kline-gap-stalled"], undefined);

  const stalled = summarizeIndicatorStackMonitoring({
    startedAtMs: 0,
    endedAtMs: 12_000,
    samples: [sample(0, "spot"), sample(6_000, "spot"), sample(12_000, "spot")],
  });
  assert.equal(stalled.issueCounts["current-series-kline-gap-stalled"], 12_000);
});
