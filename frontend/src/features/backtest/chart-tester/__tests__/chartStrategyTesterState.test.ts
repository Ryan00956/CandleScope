import assert from "node:assert/strict";
import test from "node:test";

import type { ChartSession } from "../../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../../chart-workspace/chartWorkspaceTypes.js";
import {
  chartStrategyTesterStaleReasons,
  createChartStrategyTesterState,
  currentChartStrategyTesterToken,
  reduceChartStrategyTesterState,
  type ChartStrategyTesterInputs,
  type ChartStrategyTesterStaleReason,
  type ResultProjectionIdentity,
} from "../chartStrategyTesterState.js";

const session: ChartSession = {
  exchange: "binance",
  marketType: "futures",
  symbol: "BTCUSDT",
  interval: "1h",
};

const attachment: ChartStrategyAttachmentRecord = {
  schemaVersion: 1,
  strategyDraftId: "draft-12345678",
  strategyRevisionId: "revision-1",
  displayName: "Strategy",
  language: "pyne",
  parameters: { fast: 7, slow: 21 },
  rangeMode: "ALL_AVAILABLE",
  customRange: null,
  fidelityPreference: "FAST",
  quickPresetId: "CRYPTO_PERP_STANDARD_V1",
  autoRun: false,
};

function inputs(
  patch: Partial<ChartStrategyTesterInputs> = {},
): ChartStrategyTesterInputs {
  return {
    session: { ...session },
    attachment: { ...attachment, parameters: { ...attachment.parameters } },
    draftContentRevision: 1,
    ...patch,
  };
}

const identity = (runId: string): ResultProjectionIdentity => ({
  cellScope: "workspace\u0000cell-1",
  chartContextHash: "sha256:context",
  strategyRevisionId: "revision-1",
  parameterHash: "sha256:parameters",
  datasetId: "local-12345678901234567890123456789012",
  dataEpoch: "sha256:epoch",
  snapshotHash: "sha256:snapshot",
  frozenContextHash: "sha256:frozen",
  startTimeMs: 1,
  endTimeMs: 2,
  executionProfileRevision: "EXECUTION_REALISM_V2",
  runId,
});

test("every chart and strategy identity transition has a typed stale reason", () => {
  const base = inputs();
  const cases: Array<[ChartStrategyTesterInputs, string]> = [
    [inputs({ session: { ...session, exchange: "okx" } }), "EXCHANGE_CHANGED"],
    [inputs({ session: { ...session, marketType: "spot" } }), "MARKET_TYPE_CHANGED"],
    [inputs({ session: { ...session, symbol: "ETHUSDT" } }), "SYMBOL_CHANGED"],
    [inputs({ session: { ...session, interval: "5m" } }), "INTERVAL_CHANGED"],
    [inputs({ attachment: { ...attachment, strategyDraftId: "draft-87654321" } }), "DRAFT_CHANGED"],
    [inputs({ draftContentRevision: 2 }), "DRAFT_CONTENT_CHANGED"],
    [inputs({ attachment: { ...attachment, language: "pine" } }), "LANGUAGE_CHANGED"],
    [inputs({ attachment: { ...attachment, strategyRevisionId: "revision-2" } }), "STRATEGY_REVISION_CHANGED"],
    [inputs({ attachment: { ...attachment, parameters: { fast: 8, slow: 21 } } }), "PARAMETERS_CHANGED"],
    [inputs({ attachment: {
      ...attachment,
      rangeMode: "CUSTOM",
      customRange: { startMs: 1, endMs: 2 },
    } }), "RANGE_CHANGED"],
    [inputs({ attachment: { ...attachment, fidelityPreference: "PRECISE" } }), "FIDELITY_CHANGED"],
    [inputs({ attachment: { ...attachment, quickPresetId: "CRYPTO_PERP_LOW_FEE_V1" } }), "QUICK_PRESET_CHANGED"],
    [inputs({ sourceKind: "IMPORTED_DATASET", datasetId: "local-other" }), "SOURCE_CHANGED"],
    [inputs({ dataEpoch: "sha256:next-epoch" }), "DATA_REVISION_CHANGED"],
  ];
  for (const [next, expected] of cases) {
    assert.ok(chartStrategyTesterStaleReasons(base, next).includes(
      expected as ChartStrategyTesterStaleReason,
    ), expected);
  }
  assert.deepEqual(
    chartStrategyTesterStaleReasons(base, inputs({
      attachment: { ...attachment, parameters: { slow: 21, fast: 7 } },
    })),
    [],
  );
});

test("stale transition hides completed projections in the same reducer step", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-1");
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST" });
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_COMPLETED",
    token: currentChartStrategyTesterToken(state),
    identity: identity("run-1"),
  });
  assert.equal(state.projectionVisible, true);

  state = reduceChartStrategyTesterState(state, {
    type: "SYNC_INPUTS",
    inputs: inputs({ session: { ...session, symbol: "ETHUSDT" } }),
  });
  assert.equal(state.status, "STALE");
  assert.equal(state.projectionVisible, false);
  assert.deepEqual(state.staleReasons, ["SYMBOL_CHANGED"]);
  assert.equal(state.resultIdentity?.runId, "run-1");
  assert.equal(state.inputs?.attachment.strategyRevisionId, "revision-1");
});

test("completed Runs keep the previous cell Run as the comparison baseline", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-1");
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST" });
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_COMPLETED",
    token: currentChartStrategyTesterToken(state),
    identity: identity("run-1"),
  });
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST" });
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_COMPLETED",
    token: currentChartStrategyTesterToken(state),
    identity: identity("run-2"),
    baselineRunId: "run-1",
  });
  assert.equal(state.resultIdentity?.runId, "run-2");
  assert.equal(state.baselineRunId, "run-1");
});

test("twenty rapid transitions accept only the final generation", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-1");
  const staleTokens = [];
  for (let index = 0; index < 20; index += 1) {
    state = reduceChartStrategyTesterState(state, {
      type: "SYNC_INPUTS",
      inputs: inputs({ session: { ...session, symbol: `ASSET${index}USDT` } }),
    });
    state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST" });
    staleTokens.push(currentChartStrategyTesterToken(state));
  }
  const finalToken = staleTokens.pop()!;
  for (const token of staleTokens.reverse()) {
    const before = state;
    state = reduceChartStrategyTesterState(state, {
      type: "REQUEST_COMPLETED",
      token,
      identity: identity(`stale-${token.generation}`),
    });
    assert.equal(state, before);
  }
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_COMPLETED",
    token: finalToken,
    identity: identity("final-run"),
  });
  assert.equal(state.status, "COMPLETED");
  assert.equal(state.resultIdentity?.runId, "final-run");
  assert.equal(state.projectionVisible, true);
});

test("detach invalidates inflight responses and clears result identity", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-1");
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST", status: "RUNNING" });
  const token = currentChartStrategyTesterToken(state);
  state = reduceChartStrategyTesterState(state, { type: "DETACH" });
  const detached = state;
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_COMPLETED",
    token,
    identity: identity("late-run"),
  });
  assert.equal(state, detached);
  assert.equal(state.status, "DETACHED");
  assert.equal(state.resultIdentity, null);
});

test("a response token or result from cell A cannot write cell B", () => {
  let first = createChartStrategyTesterState(inputs(), "workspace\u0000cell-a");
  let second = createChartStrategyTesterState(inputs(), "workspace\u0000cell-b");
  first = reduceChartStrategyTesterState(first, { type: "BEGIN_REQUEST" });
  second = reduceChartStrategyTesterState(second, { type: "BEGIN_REQUEST" });
  const secondBefore = second;
  second = reduceChartStrategyTesterState(second, {
    type: "REQUEST_COMPLETED",
    token: currentChartStrategyTesterToken(first),
    identity: { ...identity("wrong-cell"), cellScope: "workspace\u0000cell-a" },
  });
  assert.equal(second, secondBefore);

  second = reduceChartStrategyTesterState(second, {
    type: "REQUEST_COMPLETED",
    token: currentChartStrategyTesterToken(second),
    identity: { ...identity("wrong-identity"), cellScope: "workspace\u0000cell-a" },
  });
  assert.equal(second, secondBefore);
});

test("owned revision binding does not stale or invalidate the active generation", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-a");
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST" });
  const token = currentChartStrategyTesterToken(state);
  const bound = reduceChartStrategyTesterState(state, {
    type: "BIND_STRATEGY_REVISION",
    token,
    strategyRevisionId: "srv2_bound",
  });
  assert.equal(bound.generation, token.generation);
  assert.equal(bound.status, "RESOLVING");
  assert.equal(bound.inputs?.attachment.strategyRevisionId, "srv2_bound");
  assert.deepEqual(bound.staleReasons, []);
});

test("stop observing preserves Run id while invalidating late polling events", () => {
  let state = createChartStrategyTesterState(inputs(), "workspace\u0000cell-a");
  state = reduceChartStrategyTesterState(state, { type: "BEGIN_REQUEST", status: "RUNNING" });
  const token = currentChartStrategyTesterToken(state);
  state = reduceChartStrategyTesterState(state, {
    type: "REQUEST_STATUS",
    token,
    status: "RUNNING",
    activeRunId: "bt_background",
  });
  const stopped = reduceChartStrategyTesterState(state, { type: "STOP_OBSERVING" });
  assert.equal(stopped.status, "READY");
  assert.equal(stopped.activeRunId, "bt_background");
  assert.equal(stopped.generation, token.generation + 1);
  assert.equal(reduceChartStrategyTesterState(stopped, {
    type: "REQUEST_FAILED",
    token,
    error: { code: "LATE", message: "late", action: null },
  }), stopped);
});
