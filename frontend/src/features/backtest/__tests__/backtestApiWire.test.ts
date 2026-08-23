import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createBacktestApi } from "../backtestApi.js";
import type { RunCompareV2, SignalTracePage } from "../backtestTypes.js";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function responseFor(url: string): Response {
  if (url.includes("/signal-trace")) {
    const page: SignalTracePage = {
      schema: "SIGNAL_TRACE_V1",
      runId: "run/ one",
      items: [],
      nextAfter: null,
      limit: 2,
    };
    return Response.json(page);
  }
  if (url.includes("/compare/pair")) {
    const comparison: RunCompareV2 = {
      schema: "RUN_COMPARE_V2",
      directComparisonAllowed: true,
      incompatibleFields: [],
      precisionExplanation: null,
      parameterDiff: {},
      tradeDiff: {},
      costDiff: {},
      left: { runId: "left/ one", hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
      right: { runId: "right?two", hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
    };
    return Response.json(comparison);
  }
  return Response.json({
    ok: true,
    datasets: [],
    runs: [],
    studies: [],
    run_id: "run/ one",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:config",
  });
}

function bodyOf(request: CapturedRequest): unknown {
  return request.init?.body === undefined ? undefined : JSON.parse(String(request.init.body));
}

test("all existing backtest API methods keep their stable wire contract", async () => {
  const calls: CapturedRequest[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return responseFor(url);
  });
  const signal = new AbortController().signal;
  const api = createBacktestApi("/backtest-wire");
  try {
    await api.capabilities(signal);
    await api.listDatasets(signal);
    await api.previewSnapshot({ dataset_id: "data/ one", data_epoch: "epoch", start_time_ms: 1, end_time_ms: 2 }, signal);
    await api.listRuns(signal);
    await api.validate({ mode: "validate" }, signal);
    await api.createRun({ mode: "create" }, "idem-create", signal);
    await api.getRun("run/ one", signal);
    await api.getReport("run/ one", signal);
    await api.getChart("run/ one", signal);
    await api.exportRun("run/ one", signal);
    await api.cancelRun("run/ one", signal);
    await api.resumeRun("run/ one", signal);
    await api.listStudies(signal);
    await api.createStudy({ name: "study" }, signal);
    await api.startStudy("study/ one", signal);
    await api.cancelStudy("study/ one", signal);
    await api.revealStudyHoldout("study/ one", signal);
    await api.compareStudy("study/ one", signal);
    await api.createStrategyRevision({ name: "revision" }, signal);
    await api.smokeStrategyRevision("revision/ one", { smoke: true }, signal);
    await api.getSignalTrace("run/ one", 7, 23, signal);
    await api.compareRuns("left/ one", "right?two", signal);
    await api.cloneRun("run/ one", "length", 24, "idem-clone", signal);
    await api.copyStrategyRevision("revision/ one", "copy", signal);
    await api.archiveStrategyRevision("revision/ one", signal);
    await api.createReviewBridge("run/ one", 11, 22, signal);
    await api.getReviewBridge("bridge/ one", signal);
    await api.revealReviewBridge("bridge/ one", signal);
    await api.inspectPythonBundle("zip-inspect", signal);
    await api.createPythonBundle("zip-create", signal);
    await api.getPythonBundle("bundle/ one", signal);
    await api.createPythonRevision("bundle/ one", signal);
    await api.getPythonRuntimeReceipt("revision/ one", signal);
  } finally {
    mock.restoreAll();
  }

  assert.equal(calls.length, 33);
  assert.deepEqual(calls.map((call) => [call.init?.method ?? "GET", call.url]), [
    ["GET", "/backtest-wire/capabilities"],
    ["GET", "/backtest-wire/datasets"],
    ["POST", "/backtest-wire/datasets/snapshot"],
    ["GET", "/backtest-wire/runs"],
    ["POST", "/backtest-wire/runs/validate"],
    ["POST", "/backtest-wire/runs"],
    ["GET", "/backtest-wire/runs/run%2F%20one"],
    ["GET", "/backtest-wire/runs/run%2F%20one/report"],
    ["GET", "/backtest-wire/runs/run%2F%20one/chart"],
    ["GET", "/backtest-wire/runs/run%2F%20one/export"],
    ["POST", "/backtest-wire/runs/run%2F%20one/cancel"],
    ["POST", "/backtest-wire/runs/run%2F%20one/resume"],
    ["GET", "/backtest-wire/studies"],
    ["POST", "/backtest-wire/studies"],
    ["POST", "/backtest-wire/studies/study%2F%20one/start"],
    ["POST", "/backtest-wire/studies/study%2F%20one/cancel"],
    ["POST", "/backtest-wire/studies/study%2F%20one/reveal-holdout"],
    ["GET", "/backtest-wire/studies/study%2F%20one/compare"],
    ["POST", "/backtest-wire/strategy-revisions"],
    ["POST", "/backtest-wire/strategy-revisions/revision%2F%20one/smoke"],
    ["GET", "/backtest-wire/runs/run%2F%20one/signal-trace?after=7&limit=23"],
    ["GET", "/backtest-wire/runs/compare/pair?left_run_id=left%2F+one&right_run_id=right%3Ftwo"],
    ["POST", "/backtest-wire/runs/run%2F%20one/clone"],
    ["POST", "/backtest-wire/strategy-revisions/revision%2F%20one/copy"],
    ["POST", "/backtest-wire/strategy-revisions/revision%2F%20one/archive"],
    ["POST", "/backtest-wire/runs/run%2F%20one/review-bridge"],
    ["GET", "/backtest-wire/review-bridges/bridge%2F%20one"],
    ["POST", "/backtest-wire/review-bridges/bridge%2F%20one/reveal"],
    ["POST", "/backtest-wire/strategy-bundles/inspect"],
    ["POST", "/backtest-wire/strategy-bundles"],
    ["GET", "/backtest-wire/strategy-bundles/bundle%2F%20one"],
    ["POST", "/backtest-wire/strategy-revisions/python"],
    ["GET", "/backtest-wire/strategy-revisions/revision%2F%20one/runtime-receipt"],
  ]);
  assert.ok(calls.every((call) => call.init?.signal === signal));
  assert.deepEqual(bodyOf(calls[2]!), { dataset_id: "data/ one", data_epoch: "epoch", start_time_ms: 1, end_time_ms: 2 });
  assert.deepEqual(bodyOf(calls[4]!), { mode: "validate" });
  assert.deepEqual(bodyOf(calls[5]!), { mode: "create" });
  assert.equal(new Headers(calls[5]!.init?.headers).get("Idempotency-Key"), "idem-create");
  assert.deepEqual(bodyOf(calls[22]!), { parameter: "length", value: 24 });
  assert.equal(new Headers(calls[22]!.init?.headers).get("Idempotency-Key"), "idem-clone");
  assert.deepEqual(bodyOf(calls[25]!), { start_time_ms: 11, end_time_ms: 22 });
  assert.deepEqual(bodyOf(calls[28]!), { zip_base64: "zip-inspect" });
  assert.deepEqual(bodyOf(calls[29]!), { zip_base64: "zip-create" });
  assert.deepEqual(bodyOf(calls[31]!), { bundle_id: "bundle/ one" });
});

test("wire errors keep backend code and message and fail closed", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "BACKTEST_STORAGE_TRANSIENT", message: "try again" },
  }, { status: 503 }));
  try {
    await assert.rejects(
      createBacktestApi("/wire").listRuns(),
      /BACKTEST_STORAGE_TRANSIENT: try again/,
    );
  } finally {
    mock.restoreAll();
  }
});

test("chart-context methods use the additive two-stage wire contract", async () => {
  const calls: CapturedRequest[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({
      schema_version: "candlescope.backtest-chart-context/1",
      status: "NEEDS_DATA",
      resolution_token: "token",
      chart_context_hash: "sha256:context",
      expires_at_ms: 1,
    });
  });
  const api = createBacktestApi("/wire");
  const signal = new AbortController().signal;
  const resolveBody = {
    exchange: "binance",
    market_type: "futures",
    symbol: "BTCUSDT",
    interval: "1h",
    range_mode: "CUSTOM" as const,
    start_time_ms: 1,
    end_time_ms: 2,
    fidelity_preference: "FAST" as const,
  };
  const materializeBody = {
    resolution_token: "resolution-token",
    user_confirmed: true,
    idempotency_key: "chart-materialize-1",
    expected_dataset_id: "local-1",
    expected_data_epoch: "sha256:epoch",
  };
  try {
    await api.resolveChartContext(resolveBody, signal);
    await api.materializeChartContext(materializeBody, signal);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(calls.map((call) => [call.init?.method, call.url]), [
    ["POST", "/wire/chart-context/resolve"],
    ["POST", "/wire/chart-context/materialize"],
  ]);
  assert.deepEqual(bodyOf(calls[0]!), resolveBody);
  assert.deepEqual(bodyOf(calls[1]!), materializeBody);
  assert.ok(calls.every((call) => call.init?.signal === signal));
});

test("signal trace pagination and Run compare compatibility stay typed", async () => {
  const urls: string[] = [];
  const responses: unknown[] = [
    { schema: "SIGNAL_TRACE_V1", runId: "bt_1", items: [{ ordinal: 1, event_time_ms: 10, payload: { rsi: "29" }, row_hash: "sha256:1" }], nextAfter: 1, limit: 1 },
    { schema: "SIGNAL_TRACE_V1", runId: "bt_1", items: [{ ordinal: 2, event_time_ms: 20, payload: { rsi: "31" }, row_hash: "sha256:2" }], nextAfter: null, limit: 1 },
    {
      schema: "RUN_COMPARE_V2", directComparisonAllowed: false,
      incompatibleFields: ["fidelity_mode"], precisionExplanation: null,
      parameterDiff: { length: { left: 2, right: 3 } },
      tradeDiff: { netPnl: { left: "1", right: "2", delta: "1" } }, costDiff: {},
      left: { runId: "bt_1", hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
      right: { runId: "bt_2", hashes: {}, equity: [], equityDaily: [], drawdownDaily: [], metrics: {} },
    },
  ];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json(responses.shift());
  });
  try {
    const api = createBacktestApi("/wire");
    const first = await api.getSignalTrace("bt_1", 0, 1);
    const second = await api.getSignalTrace("bt_1", first.nextAfter ?? 0, 1);
    const comparison = await api.compareRuns("bt_1", "bt_2");
    assert.equal(first.items[0]?.row_hash, "sha256:1");
    assert.equal(second.nextAfter, null);
    assert.equal(comparison.schema, "RUN_COMPARE_V2");
    assert.equal(comparison.directComparisonAllowed, false);
    assert.deepEqual(comparison.incompatibleFields, ["fidelity_mode"]);
    assert.equal(comparison.tradeDiff.netPnl?.delta, "1");
    assert.deepEqual(urls, [
      "/wire/runs/bt_1/signal-trace?after=0&limit=1",
      "/wire/runs/bt_1/signal-trace?after=1&limit=1",
      "/wire/runs/compare/pair?left_run_id=bt_1&right_run_id=bt_2",
    ]);
  } finally {
    mock.restoreAll();
  }
});
