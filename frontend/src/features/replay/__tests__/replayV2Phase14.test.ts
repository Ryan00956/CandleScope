import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayCapabilities, parseReplayCatalog } from "../replayParser.js";
import { parseReplaySegmentPreparePlan } from "../replaySegmentTypes.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
} from "../trainingHubModel.js";
import { enabledCapabilities } from "./fixtures.js";


function catalog() {
  const epoch = `sha256:${"a".repeat(64)}` as const;
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: epoch,
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: true,
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 10,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: epoch,
      bounds: null,
      eligible_ranges: [],
    }],
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "replay.data.prepare.v1",
    state: "PREPARE_ON_CREATE",
    source_kind: "BAR",
    identity: {
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      base_interval: "1m",
    },
    estimated_size_bytes: 393_840,
    estimated_rows: 1_641,
    history_policy: {
      schema_version: "replay.data-policy.v1",
      indicator_warmup_bars: 200,
      visible_history_lookback: {
        mode: "DURATION",
        duration_ms: 12_000_000,
      },
      visible_history_rows_estimate: 200,
      effective_warmup_bars_estimate: 200,
      forward_cache_ms: 86_400_000,
      forward_rows_estimate: 1_440,
      estimate_kind: "EXACT",
      max_dataset_rows: 250_000,
      accepted: true,
      blocked_reason: null,
      ...overrides,
    },
    prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE",
    existing_ready_segments: 0,
    existing_ready_bytes: 0,
    selection_loads_history: false,
    create_loads_only_selected_range: true,
    download_worker_enabled: false,
    auto_gc_enabled: false,
    failure_policy: "QUARANTINE_AND_FAIL_CLOSED",
    historical_book: {
      feature_enabled: false,
      requested_mode: "OFF",
      capability_state: "UNSUPPORTED_NO_HISTORY",
      reason: "FEATURE_DISABLED",
      source: "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1",
      snapshot_and_ordered_deltas: false,
      continuity_contract: "SNAPSHOT_BRIDGE_AND_U_u_pu",
      pinnable: false,
      queue_exact: false,
      execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
      ready_archive_bytes: 0,
      max_archive_bytes: 1_099_511_627_776,
    },
    account_history: {
      protocol: "replay.account-history.archive.v1",
      feature_enabled: false,
      requested_mode: "APPROX_PROXY",
      capability_state: "UNSUPPORTED_NO_HISTORY",
      reason: "FEATURE_DISABLED",
      fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      supported_contract_model: "LINEAR_QUOTE_SETTLED_V1",
      supported_position_mode: "ONE_WAY",
      supported_margin_asset_mode: "SINGLE_QUOTE",
      historical_funding_exact: false,
      public_kline_proxy_accepted: false,
      ready_archive_bytes: 0,
      max_archive_bytes: 137_438_953_472,
      coverage: null,
      account_history_ref: null,
    },
  };
}

test("Phase 14 create payload separates indicator warmup from visible history", () => {
  const sourceCatalog = catalog();
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const draft = createTrainingRunDraft(sourceCatalog);
  assert.equal(draft.indicatorWarmupBars, 200);
  assert.equal(draft.visibleHistoryMode, "DURATION");
  assert.equal(draft.visibleHistoryLookbackMs, 12_000_000);
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, sourceCatalog);
  assert.equal(evaluation.canSubmit, true);
  const payload = buildTrainingRunCreateRequest(draft, evaluation, sourceCatalog);
  assert.equal(payload.indicator_warmup_bars, 200);
  assert.deepEqual(payload.visible_history_lookback, {
    mode: "DURATION",
    duration_ms: 12_000_000,
  });
  assert.equal("warmup_bars" in payload, false);
});

test("Phase 14 model rejects misalignment and accepts explicit all-available policy", () => {
  const sourceCatalog = catalog();
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const base = createTrainingRunDraft(sourceCatalog);
  const misaligned = evaluateTrainingRunDraft(
    { ...base, visibleHistoryLookbackMs: 60_001 },
    capabilities,
    sourceCatalog,
  );
  assert.equal(misaligned.canSubmit, false);
  assert.match(misaligned.errors.join("\n"), /精确对齐基础周期/);

  const allAvailable = {
    ...base,
    visibleHistoryMode: "ALL_AVAILABLE" as const,
    visibleHistoryLookbackMs: null,
  };
  const accepted = evaluateTrainingRunDraft(
    allAvailable,
    capabilities,
    sourceCatalog,
  );
  assert.equal(accepted.canSubmit, true);
  assert.deepEqual(
    buildTrainingRunCreateRequest(
      allAvailable,
      accepted,
      sourceCatalog,
    ).visible_history_lookback,
    { mode: "ALL_AVAILABLE", duration_ms: null },
  );
});

test("Phase 14 prepare plan carries strict role estimates and blocks rejected budgets", () => {
  const parsed = parseReplaySegmentPreparePlan(plan());
  assert.equal(parsed.history_policy.accepted, true);
  assert.equal(parsed.history_policy.effective_warmup_bars_estimate, 200);

  const blocked = parseReplaySegmentPreparePlan(plan({
    accepted: false,
    blocked_reason: "VISIBLE_HISTORY_BUDGET_EXCEEDED",
  }));
  assert.equal(blocked.history_policy.accepted, false);
  assert.throws(() => parseReplaySegmentPreparePlan(plan({
    accepted: false,
    blocked_reason: null,
  })));
  assert.throws(() => parseReplaySegmentPreparePlan(plan({
    effective_warmup_bars_estimate: 199,
  })));
});
