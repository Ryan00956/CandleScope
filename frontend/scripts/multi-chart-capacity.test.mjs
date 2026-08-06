import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CAPACITY_SCHEMA_VERSION,
  buildWorkspaceBootstrap,
  createNetworkFailureTracker,
  eventLoopLagForWindow,
  evaluateCapacityResult,
  isCapacityReadySnapshot,
  isRealtimeSettledSnapshot,
  leaseMapping,
  parseArgs,
  seriesAnalysis,
  validateCapacityEvidence,
  writeProtocolStream,
} from "./multi-chart-capacity.mjs";


test("capacity CLI accepts only the frozen 1/2/4/8/16 and S1-S5/C1 matrix", () => {
  assert.equal(parseArgs(["--cells", "16", "--scenario", "s5", "--duration-ms", "1000"]).cells, 16);
  assert.equal(parseArgs(["--cells", "16", "--scenario", "s5", "--duration-ms", "1000"]).scenario, "S5");
  assert.throws(() => parseArgs(["--cells", "3"]), /must be one of/);
  assert.equal(parseArgs(["--scenario", "C1"]).requireDatabaseState, "empty");
  assert.equal(parseArgs(["--scenario", "S1", "--require-database-state", "warm"]).requireDatabaseState, "warm");
  assert.throws(() => parseArgs(["--scenario", "W3"]), /must be one of/);
  assert.throws(() => parseArgs(["--require-database-state", "cold"]), /must be auto, warm, or empty/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("phase 2 bootstrap produces exact v6 1/2/4/8/16-cell trees", () => {
  for (const cells of [1, 2, 4, 8, 16]) {
    const bootstrap = buildWorkspaceBootstrap({ cells, scenario: "S1", now: 100 });
    assert.equal(bootstrap.record.document.schemaVersion, 6);
    assert.equal(bootstrap.record.document.revision, 1);
    assert.equal(bootstrap.record.document.windows["main-window"].layoutLocked, true);
    assert.equal(bootstrap.expectedSeries.length, 1);
    const serialized = JSON.stringify(bootstrap.record.document.windows["main-window"].layoutTree);
    for (let index = 1; index <= cells; index += 1) assert.match(serialized, new RegExp(`cell-${index}`));
    assert.equal(Object.keys(bootstrap.record.document.cells).length, cells);
  }
  assert.throws(() => buildWorkspaceBootstrap({ cells: 64, scenario: "S1" }), /cannot represent 64/);
});

test("S2, S3, and C1 freeze release-sized series shapes", () => {
  const s2 = buildWorkspaceBootstrap({ cells: 16, scenario: "S2" });
  assert.equal(s2.expectedSeries.length, 8);
  assert.equal(s2.expectedClaimsBySeries["BTCUSDT@1m"], 16);
  assert.deepEqual(
    Object.entries(s2.expectedClaimsBySeries).filter(([series]) => series !== "BTCUSDT@1m").map(([, count]) => count),
    Array(7).fill(2),
  );
  assert.deepEqual(buildWorkspaceBootstrap({ cells: 4, scenario: "S3" }).expectedSeries, [
    "BNBUSDT@1m", "BTCUSDT@1m", "ETHUSDT@1m", "SOLUSDT@1m",
  ]);
  const c1 = buildWorkspaceBootstrap({ cells: 16, scenario: "C1" });
  assert.equal(c1.expectedSeries.length, 16);
  assert.equal(Object.keys(c1.record.document.cells).length, 16);
  assert.equal(c1.record.document.cells["cell-1"].indicators.length, 2);
  assert.deepEqual(
    c1.record.document.cells["cell-1"].indicators.map((indicator) => indicator.executionTarget),
    ["local", "local"],
  );
  assert.equal(c1.record.document.linkGroups.A.market, false);
  const s5 = buildWorkspaceBootstrap({ cells: 16, scenario: "S5" });
  assert.equal(s5.expectedClaimsBySeries["BTCUSDT@1m"], 1);
  assert.equal(s5.expectedLeaseClaimsBySeries["BTCUSDT@1m"], 2);
  assert.deepEqual(
    Object.values(s5.expectedLeaseClaimsBySeries),
    Array(16).fill(2),
  );
});

test("batch lease mapping validates stable absolute claims across browser replacement", () => {
  const before = { dataManager: { directSubscriptionsBySeries: { "BTCUSDT@1m": 1 } } };
  const after = { dataManager: { directSubscriptionsBySeries: { "BTCUSDT@1m": 1 } } };
  const mapped = leaseMapping(before, after, ["BTCUSDT@1m"], { "BTCUSDT@1m": 1 }, true);
  assert.deepEqual(mapped.claimMismatches, []);
  assert.equal(mapped.leases, 1);
  assert.deepEqual(mapped.duplicateSeries, []);
});

test("gate evaluation computes pass, fail, and unsupported instead of trusting a caller result", () => {
  const base = {
    supported: true,
    requestedCells: 2,
    readiness: {
      ready: true,
      visibleCells: 2,
      documentVisibility: "visible",
      realtimeSettled: true,
      realtimeStatuses: ["live", "live"],
    },
    errors: { console: [], exceptions: [], network: [] },
    backendAfter: { ok: true, schemaVersion: "candlescope.backend.capacity/1" },
    mapping: { observedSeries: 1, expectedSeries: 1, duplicateSeries: [], claimMismatches: [] },
    canvasRemounts: 0,
    backgroundSuppression: {
      hidden: true,
      allMinimized: true,
      formingDelta: 0,
      previewDelta: 0,
      pendingFrames: 0,
    },
  };
  assert.equal(evaluateCapacityResult(base).result, "pass");
  assert.equal(evaluateCapacityResult({ ...base, canvasRemounts: 1 }).result, "fail");
  assert.equal(evaluateCapacityResult({ supported: false, requestedCells: 8 }).result, "unsupported");
});

test("capacity evidence validator enforces the stable top-level schema", () => {
  const evidence = {
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    git: { commit: "abc", dirty: true },
    hardware: { profileSha256: `sha256:${"a".repeat(64)}` },
    scenario: { id: "S1", windows: 1, cells: 1 },
    data: {},
    frontend: {}, backend: {}, upstream: {}, gates: {}, result: "pass",
  };
  assert.deepEqual(validateCapacityEvidence(evidence), []);
  assert.match(validateCapacityEvidence({ ...evidence, result: "maybe" }).join(" "), /result/);
  assert.match(validateCapacityEvidence({ ...evidence, data: null }).join(" "), /data/);
  assert.match(validateCapacityEvidence({ ...evidence, hardware: { profileSha256: "sha256:abc" } }).join(" "), /hardware/);
});

test("network failure evidence retains request identity and ignores explicit cancellation", () => {
  const tracker = createNetworkFailureTracker();
  tracker.requestWillBeSent({
    requestId: "failed",
    request: { method: "GET", url: "http://127.0.0.1:18081/api/v1/indicators/diagnostics" },
    type: "Fetch",
  });
  const failed = tracker.loadingFailed({
    requestId: "failed",
    type: "Fetch",
    errorText: "net::ERR_FAILED",
    corsErrorStatus: { corsError: "MissingAllowOriginHeader" },
  });
  assert.equal(failed.method, "GET");
  assert.equal(failed.url, "http://127.0.0.1:18081/api/v1/indicators/diagnostics");
  assert.deepEqual(failed.corsErrorStatus, { corsError: "MissingAllowOriginHeader" });

  tracker.requestWillBeSent({ requestId: "canceled", request: { method: "GET", url: "http://example.test/" } });
  assert.equal(tracker.loadingFailed({ requestId: "canceled", canceled: true, errorText: "net::ERR_FAILED" }), null);
});

test("capacity first-usable readiness requires every Cell data but measures realtime separately", () => {
  const stable = {
    visibleCells: 2,
    canvasCount: 14,
    chartSurfaceCount: 2,
    canvasQuietMs: 500,
    chartSurfaceQuietMs: 500,
    statuses: ["multi-chart-cell-status live", "multi-chart-cell-status fallback"],
    marketDataReady: ["true", "true"],
    documentVisibility: "visible",
  };
  assert.equal(isCapacityReadySnapshot(stable, 2), true);
  assert.equal(isCapacityReadySnapshot({ ...stable, marketDataReady: ["true", "false"] }, 2), false);
  assert.equal(isCapacityReadySnapshot({ ...stable, statuses: ["live", "connecting"] }, 2), true);
  assert.equal(isRealtimeSettledSnapshot(stable, 2), true);
  assert.equal(isRealtimeSettledSnapshot({ ...stable, statuses: ["live", "connecting"] }, 2), false);
  assert.equal(isCapacityReadySnapshot({ ...stable, documentVisibility: "hidden" }, 2), false);
  assert.equal(isCapacityReadySnapshot({ ...stable, canvasQuietMs: 0 }, 2), true);
  assert.equal(isCapacityReadySnapshot({ ...stable, chartSurfaceCount: 1 }, 2), false);
  assert.equal(isCapacityReadySnapshot({ ...stable, chartSurfaceQuietMs: 499 }, 2), false);
});

test("event-loop lag gate only uses samples created by the current scenario", () => {
  assert.deepEqual(eventLoopLagForWindow(
    { sample_sequence: 10 },
    {
      sample_sequence: 13,
      recent_samples: [
        { sequence: 9, value_ms: 900 },
        { sequence: 11, value_ms: 4 },
        { sequence: 12, value_ms: 8 },
        { sequence: 13, value_ms: 12 },
      ],
    },
  ), {
    beforeSequence: 10,
    afterSequence: 13,
    samples: [4, 8, 12],
    p99Ms: 12,
  });
});

test("retained heap analysis ignores unsampled null checkpoints", () => {
  assert.deepEqual(seriesAnalysis([
    { retained: 100 },
    { retained: null },
    { retained: undefined },
    { retained: 110 },
  ], "retained"), {
    samples: 2,
    start: 100,
    end: 110,
    min: 100,
    max: 110,
    deltaPct: 10,
    finalWindowDeltaPct: 0,
    plateau: true,
  });
});

test("protocol tracing stream writes bounded chunks without one giant JSON string", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-trace-test-"));
  const outputPath = path.join(directory, "trace.json");
  const chunks = [
    { data: '{"traceEvents":[', eof: false },
    { data: Buffer.from('{"name":"ready"}').toString("base64"), base64Encoded: true, eof: false },
    { data: "]}", eof: true },
  ];
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "IO.read") return chunks.shift();
      return {};
    },
  };

  try {
    await writeProtocolStream(cdp, "trace-stream", outputPath);
    assert.equal(fs.readFileSync(outputPath, "utf8"), '{"traceEvents":[{"name":"ready"}]}');
    assert.equal(calls.filter((call) => call.method === "IO.read").length, 3);
    assert.deepEqual(calls.at(-1), {
      method: "IO.close",
      params: { handle: "trace-stream" },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
