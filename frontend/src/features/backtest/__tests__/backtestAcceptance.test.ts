import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createBacktestApi, type BacktestApiClient } from "../backtestApi.js";
import { isBacktestEntryEnabled } from "../backtestFlags.js";
import { createBacktestStore, reportHidesApproximate } from "../backtestStore.js";
import type { BacktestReport, BacktestRunRecord } from "../backtestTypes.js";
import { runCreateMonitorExport } from "../backtestWorkspace.js";

function report(): BacktestReport {
  return {
    schemaVersion: "candlescope.backtest-report/1",
    runId: "bt_1",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    report_label: "APPROXIMATE",
    hashes: { report: "sha256:r" },
    metrics: {
      fill_count: 1,
      ambiguity_count: 0,
      rejected_order_count: 0,
      trade_count: 0,
      winning_trade_count: 0,
      win_rate: "0",
      realized_net_pnl: "0",
    },
    unmodeled: ["queue position"],
    suitable_for: ["bar-close strategy comparison"],
    not_suitable_for: ["live trading approval"],
    fills: [{ order_id: "ord-1", sequence: "2", price: "100", qty: "1", reason: "NEXT_BAR_OPEN" }],
    trades: [],
  };
}

function fakeApi(run: BacktestRunRecord, exported: Record<string, unknown>): BacktestApiClient {
  return {
    async capabilities() {
      return {
        flags: { BACKTEST_ENABLED: true },
        fidelity_modes: ["BAR_APPROX"],
        strategies: [],
      };
    },
    async listDatasets() {
      return [];
    },
    async previewSnapshot() {
      return {
        data_epoch: "sha256:e",
        snapshot_hash: "sha256:s",
        coverage_start_ms: 1,
        coverage_end_ms: 2,
        row_count: 1,
        quality: { status: "accepted" },
        fidelity_capabilities: ["BAR_APPROX"],
      };
    },
    async resolveChartContext() {
      throw new Error("unused");
    },
    async materializeChartContext() {
      throw new Error("unused");
    },
    async listRuns() {
      return [run];
    },
    async validate() {
      return { ok: true };
    },
    async createRun() {
      return run;
    },
    async getRun() {
      return run;
    },
    async getReport() {
      return report();
    },
    async getChart() {
      return {
        run_id: run.run_id,
        chart_hash: "sha256:chart-1",
        symbol: "BTCUSDT",
        interval: "1m",
        bars: [],
        fills: [],
        equity_curve: [],
        truncated: false,
      };
    },
    async exportRun() {
      return exported;
    },
    async cancelRun() {
      return run;
    },
    async resumeRun() {
      return run;
    },
    async listStudies() {
      return [];
    },
    async createStudy() {
      throw new Error("unused");
    },
    async startStudy() {
      throw new Error("unused");
    },
    async cancelStudy() {
      throw new Error("unused");
    },
    async revealStudyHoldout() {
      throw new Error("unused");
    },
    async compareStudy() {
      throw new Error("unused");
    },
    async createStrategyRevision() { throw new Error("unused"); },
    async smokeStrategyRevision() { throw new Error("unused"); },
    async getSignalTrace() {
      return { schema: "SIGNAL_TRACE_V1", runId: run.run_id, items: [], nextAfter: null, limit: 200 };
    },
    async compareRuns() { throw new Error("unused"); },
    async compareRecentRun() { throw new Error("unused"); },
    async cloneRun() { throw new Error("unused"); },
    async copyStrategyRevision() { throw new Error("unused"); },
    async archiveStrategyRevision() { throw new Error("unused"); },
    async createReviewBridge() { throw new Error("unused"); },
    async getReviewBridge() { throw new Error("unused"); },
    async revealReviewBridge() { throw new Error("unused"); },
    async inspectPythonBundle() { throw new Error("unused"); },
    async createPythonBundle() { throw new Error("unused"); },
    async getPythonBundle() { throw new Error("unused"); },
    async createPythonRevision() { throw new Error("unused"); },
    async getPythonRuntimeReceipt() { throw new Error("unused"); },
  };
}

test("create, monitor, disconnect, and export do not cancel the run", async () => {
  const run: BacktestRunRecord = {
    run_id: "bt_1",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:c",
  };
  const exported = {
    manifest: { reportLabel: "APPROXIMATE", runId: "bt_1" },
    report: report(),
    csv: "order_id,sequence,price,qty,reason\nord-1,2,100,1,NEXT_BAR_OPEN\n",
  };
  const store = createBacktestStore();
  const result = await runCreateMonitorExport({
    api: fakeApi(run, exported),
    body: { fidelity_mode: "BAR_APPROX" },
    idempotencyKey: "k1",
    store,
  });
  store.applyStream({ type: "RESYNC_REQUIRED" });
  assert.equal(result.cancelled, false);
  assert.equal(result.report.report_label, "APPROXIMATE");
  assert.equal(store.getState().resyncRequired, true);
  assert.equal(store.getState().selectedRunId, "bt_1");
  assert.equal(store.getState().runs[0]?.state, "COMPLETED");
  assert.equal((result.exported.manifest as { reportLabel: string }).reportLabel, "APPROXIMATE");
  assert.equal(reportHidesApproximate(result.report), false);
});

test("refresh after disconnect keeps the last known run", () => {
  const store = createBacktestStore();
  store.applyRuns([
    {
      run_id: "bt_1",
      state: "RUNNING",
      fidelity_mode: "BAR_APPROX",
      source_event_kind: "BAR",
      config_hash: "sha256:c",
    },
  ]);
  store.applyStream({ type: "PROGRESS", sequence: 9 });
  store.applyStream({ type: "RESYNC_REQUIRED" });
  assert.equal(store.getState().runs[0]?.run_id, "bt_1");
  assert.equal(store.getState().lastSequence, 9);
});

test("entry stays closed unless the frontend flag is on", () => {
  assert.equal(isBacktestEntryEnabled({ VITE_BACKTEST_ENTRY_ENABLED: "0" }), false);
  assert.equal(isBacktestEntryEnabled({}), false);
});

test("Study V2 holdout reveal uses the dedicated one-shot endpoint", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({
      study_id: "study/with space",
      name: "RSI24",
      hypothesis: "RSI24 persists OOS",
      state: "RUNNING",
      strategy_revision_id: "builtin-rsi-wilder-long-short-v1",
      config_hash: "sha256:study",
      trials: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const study = await createBacktestApi("/api/v1/backtests")
      .revealStudyHoldout("study/with space");
    assert.equal(study.study_id, "study/with space");
    assert.deepEqual(calls, [{
      url: "/api/v1/backtests/studies/study%2Fwith%20space/reveal-holdout",
      method: "POST",
    }]);
  } finally {
    mock.restoreAll();
  }
});

test("repeated unit workflow of create-to-export stays deterministic", async () => {
  const run: BacktestRunRecord = {
    run_id: "bt_1",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:c",
  };
  const labels: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    const result = await runCreateMonitorExport({
      api: fakeApi(run, { manifest: { reportLabel: "APPROXIMATE" } }),
      body: { fidelity_mode: "BAR_APPROX" },
      idempotencyKey: `k-${index}`,
    });
    labels.push(result.report.report_label);
  }
  assert.equal(new Set(labels).size, 1);
  assert.equal(labels[0], "APPROXIMATE");
});
