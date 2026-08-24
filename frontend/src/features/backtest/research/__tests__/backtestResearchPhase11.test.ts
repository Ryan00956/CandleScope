import assert from "node:assert/strict";
import test from "node:test";

import type { BacktestDataset, BacktestSnapshot } from "../../backtestApi.js";
import { isBacktestResearchAdvancedEnabled } from "../../backtestFlags.js";
import {
  composeResearchRunDraft,
  composeResearchStudyDraft,
  normalizeResearchRunDraft,
  normalizeResearchStudyDraft,
  parseResearchObjectJson,
  researchReplayHref,
  researchRunIsActive,
  researchStudyIsActive,
} from "../backtestResearchAdvancedModel.js";

const dataset: BacktestDataset = {
  dataset_id: "dataset-12345678",
  data_epoch: "sha256:epoch",
  name: "BTC 15m",
  symbol: "BTCUSDT",
  interval: "15m",
  rows: 1_000,
  first_open_ms: 1_000,
  last_close_ms: 2_000,
  strategy_revisions: [],
};
const snapshot: BacktestSnapshot = {
  data_epoch: "sha256:new-epoch",
  snapshot_hash: "sha256:snapshot",
  coverage_start_ms: 1_000,
  coverage_end_ms: 2_000,
  row_count: 1_000,
  quality: { status: "accepted" },
  fidelity_capabilities: ["BAR_APPROX"],
};

test("advanced research flag remains default-off and accepts explicit enablement", () => {
  assert.equal(isBacktestResearchAdvancedEnabled({}), false);
  assert.equal(isBacktestResearchAdvancedEnabled({ VITE_BACKTEST_RESEARCH_ADVANCED_ENABLED: "1" }), true);
});

test("Run draft exposes advanced execution fields but immutable identity is rebound", () => {
  const draft = composeResearchRunDraft({
    context: null,
    run: null,
    dataset,
    snapshot,
    revisionId: "rev-12345678",
    session: { exchange: "binance", marketType: "usdm", symbol: "BTCUSDT", interval: "15m" },
    startTimeMs: 1_000,
    endTimeMs: 2_000,
  });
  assert.equal(draft.participation_rate, null);
  assert.equal(draft.max_drawdown_percent, "50");
  const normalized = normalizeResearchRunDraft({
    draft: { ...draft, dataset_id: "attacker", snapshot_hash: "attacker", fidelity_mode: "AGG_TRADE_EXECUTION" },
    dataset,
    snapshot,
    revisionId: "rev-authority",
    session: { exchange: "okx", marketType: "swap", symbol: "ETHUSDT", interval: "1h" },
    startTimeMs: 1_100,
    endTimeMs: 1_900,
  });
  assert.equal(normalized.dataset_id, dataset.dataset_id);
  assert.equal(normalized.snapshot_hash, snapshot.snapshot_hash);
  assert.equal(normalized.strategy_revision_id, "rev-authority");
  assert.equal(normalized.source_event_kind, "AGG_TRADE");
});

test("changing revision does not leak the previous Run output contract", () => {
  const draft = composeResearchRunDraft({
    context: null,
    run: {
      run_id: "bt_previous",
      state: "COMPLETED",
      fidelity_mode: "BAR_APPROX",
      source_event_kind: "BAR",
      config_hash: "sha256:previous",
      config_json: JSON.stringify({
        strategy_revision_id: "builtin-expression-model-v1",
        output_mode: "TARGET_POSITION",
        parameters: { threshold: 1 },
      }),
    },
    dataset,
    snapshot,
    revisionId: "builtin-rsi-wilder-long-short-v1",
    outputMode: "SIGNAL",
    session: { exchange: "binance", marketType: "usdm", symbol: "BTCUSDT", interval: "15m" },
    startTimeMs: 1_000,
    endTimeMs: 2_000,
  });
  assert.equal(draft.output_mode, "SIGNAL");
  assert.deepEqual(draft.parameters, {});
});

test("Study draft remains a separate object and normalization never starts it", () => {
  const draft = composeResearchStudyDraft({
    context: null,
    dataset,
    snapshot,
    revisionId: "rev-12345678",
    startTimeMs: 1_000,
    endTimeMs: 2_000,
  });
  const normalized = normalizeResearchStudyDraft({
    draft: { ...draft, dataset_id: "wrong", state: "RUNNING" },
    dataset,
    snapshot,
    revisionId: "rev-authority",
    startTimeMs: 1_100,
    endTimeMs: 1_900,
  });
  assert.equal(normalized.dataset_id, dataset.dataset_id);
  assert.equal(normalized.dataset_snapshot_hash, snapshot.snapshot_hash);
  assert.equal(normalized.strategy_revision_id, "rev-authority");
  assert.equal("start" in normalized, false);
});

test("Study defaults fit the selected local range and freeze one schema candidate", () => {
  const hour = 3_600_000;
  const localDataset = {
    ...dataset,
    interval: "1h",
    first_open_ms: 0,
    last_close_ms: 60 * hour - 1,
  };
  const draft = composeResearchStudyDraft({
    context: null,
    dataset: localDataset,
    snapshot,
    revisionId: "builtin-expression-model-v1",
    parameterSchema: [{ name: "threshold", default: 0 }],
    startTimeMs: 0,
    endTimeMs: 60 * hour - 1,
  });
  assert.equal(draft.train_ms, 36 * hour);
  assert.equal(draft.test_ms, 12 * hour);
  assert.equal(draft.step_ms, 12 * hour);
  assert.deepEqual(draft.parameter_space, { threshold: [0] });
});

test("replay handoff uses only the server-created TrainingRun id", () => {
  assert.equal(researchReplayHref({
    bridgeId: "btrb_1",
    trainingRun: { run_id: "tr_12345678" },
  }), "/replay.html?run=tr_12345678");
  assert.equal(researchReplayHref({ trainingRun: { run_id: "bad id" } }), null);
  assert.equal(researchReplayHref({ bridgeId: "tr_guessed_12345678" }), null);
});

test("advanced JSON and lifecycle helpers fail closed", () => {
  assert.throws(() => parseResearchObjectJson("[]", "Run draft"), /must be a JSON object/);
  assert.equal(researchRunIsActive({ run_id: "bt_1", state: "RUNNING", fidelity_mode: "BAR_APPROX", source_event_kind: "BAR", config_hash: "sha256:x" }), true);
  assert.equal(researchRunIsActive({ run_id: "bt_1", state: "COMPLETED", fidelity_mode: "BAR_APPROX", source_event_kind: "BAR", config_hash: "sha256:x" }), false);
  assert.equal(researchStudyIsActive("RUNNING"), true);
  assert.equal(researchStudyIsActive("COMPLETED"), false);
});
