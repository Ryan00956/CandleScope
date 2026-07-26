import assert from "node:assert/strict";
import test from "node:test";

import {
  SemanticViewActionSampler,
  buildEquityPolyline,
  parseReplayEquityResponse,
  parseReplayIntegrityResponse,
  parseReplayReviewResponse,
} from "../replayIntegrityModel.js";
import { buildTrainingRunCreateRequest, evaluateTrainingRunDraft } from "../trainingHubModel.js";
import { parseReplayCapabilities, parseReplayCatalog } from "../replayParser.js";
import { enabledCapabilities } from "./fixtures.js";

function replayCatalog() {
  const epoch = `sha256:${"a".repeat(64)}`;
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
      eligible_window_count: 50,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: epoch,
      bounds: null,
      eligible_ranges: [],
    }],
  });
}

function phase17ReviewResponse() {
  const hash = `sha256:${"8".repeat(64)}`;
  const accountHash = `sha256:${"4".repeat(64)}`;
  const ledgerHash = `sha256:${"5".repeat(64)}`;
  const viewerHash = `sha256:${"6".repeat(64)}`;
  const publicTime = {
    policy: "HIDE_ALL",
    timeline_ms: 946_684_800_000,
    relative_ms: 0,
    sequence: 0,
    label: "D+1 T+00:00:00",
  };
  const cursor = { virtual_time_ms: 946_684_800_000, source_sequence: 0 };
  const baseRule = {
    revision: 1,
    effective_cursor: cursor,
    public_time: publicTime,
    fidelity: "USER_CONFIGURED_AUDITED",
    reason: "training creation",
    command_id: null,
    old: null,
  };
  const feePolicy = {
    ...baseRule,
    kind: "FEE_POLICY",
    maker_fee_bps: "1",
    taker_fee_bps: "4",
    policy_hash: `sha256:${"a".repeat(64)}`,
    new: { maker_fee_bps: "1", taker_fee_bps: "4" },
  };
  const leveragePolicy = {
    ...baseRule,
    kind: "LEVERAGE_CAP",
    max_leverage: "10",
    policy_hash: `sha256:${"b".repeat(64)}`,
    new: { max_leverage: "10" },
  };
  const fundingPolicy = {
    ...baseRule,
    kind: "FUNDING_POLICY",
    funding_mode: "OFF",
    fixed_funding_rate: null,
    funding_interval_ms: null,
    policy_hash: `sha256:${"c".repeat(64)}`,
    new: {
      funding_mode: "OFF",
      fixed_funding_rate: null,
      funding_interval_ms: null,
    },
  };
  const rules = {
    protocol: "replay.v2",
    schema_version: "replay.run-rules.v1",
    run_id: "run-1",
    effective_cursor: cursor,
    fee_policy: feePolicy,
    leverage_policy: leveragePolicy,
    funding_policy: fundingPolicy,
    instrument_rules: [{
      track_id: "track-1",
      revision: 1,
      effective_virtual_time_ms: 946_684_800_000,
      rule: { exchange_max_leverage: "20" },
      rule_hash: `sha256:${"d".repeat(64)}`,
      fidelity: "EXCHANGE_ARCHIVE_EXACT",
      immutable_exchange_rule: true,
    }],
    effective_leverage_by_track: { "track-1": "10" },
    history: [feePolicy, leveragePolicy, fundingPolicy],
  };
  const projection = {
    schema_version: "replay.review.timeline.v1",
    run_id: "run-1",
    cursor,
    tracks: [{
      track_id: "track-1",
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      source_kind: "BAR",
      position: {},
      account: {},
    }],
    orders: [],
    fills: [],
    ledger: [],
    markers: [],
    liquidations: [],
    books: [],
    account: {
      account_model: "PERPETUAL_LINEAR",
      ledger_tail_hash: ledgerHash,
    },
    account_hash: accountHash,
    rules,
    viewer_state: {
      run_id: "run-1",
      selected_track_id: "track-1",
      display_interval: "1m",
      semantic_view_revision: 1,
    },
    viewer_hash: viewerHash,
    drawing_document_hash: null,
    drawing_revision: 0,
    domain: { equity: "10000", order_count: 0, fill_count: 0 },
  };
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.timeline.v1",
    review_id: "review-1",
    run_id: "run-1",
    read_only: true,
    selected_event_id: "checkpoint-7",
    selected_timeline_sequence: 1,
    selected_state_hash: hash,
    original_state_hash: hash,
    original_cursor: cursor,
    dataset_epoch: `sha256:${"9".repeat(64)}`,
    cursor_revision: 1,
    playback_state: "PAUSED",
    playback_rate: "1",
    projection,
    drawing_document: null,
    immutability_proof: {
      original_account_hash: accountHash,
      original_ledger_tail_hash: ledgerHash,
      original_viewer_revision: 1,
      original_viewer_hash: viewerHash,
      verified: true,
    },
    budget: {
      critical_events: 1,
      critical_event_limit: 8_192,
      viewport_samples: 0,
      viewport_sample_limit: 2_048,
      anchor_used_bytes: 4_096,
      anchor_limit_bytes: 512 * 1_024 * 1_024,
      artifact_used_bytes: 2_048,
      artifact_limit_bytes: 128 * 1_024 * 1_024,
    },
    events: [{
      event_id: "checkpoint-7",
      event_type: "INITIAL_CHECKPOINT",
      category: "SYSTEM",
      timeline_sequence: 1,
      checkpoint_id: 7,
      source_sequence: 0,
      event_sequence: 1,
      state_hash: hash,
      account_hash: accountHash,
      ledger_tail_hash: ledgerHash,
      viewer_revision: 1,
      anchor_set_hash: `sha256:${"2".repeat(64)}`,
      event_hash: `sha256:${"3".repeat(64)}`,
      public_time: publicTime,
      detail: null,
    }],
    jump_targets: [{
      event_id: "checkpoint-7",
      event_type: "INITIAL_CHECKPOINT",
      category: "SYSTEM",
    }],
  };
}


test("Phase 4 integrity parser keeps only public time and audited mutation values", () => {
  const response = parseReplayIntegrityResponse({
    protocol: "replay.v2",
    run_id: "run-1",
    integrity_mode: "PRACTICE",
    configured_time_disclosure_policy: "HIDE_DAY",
    effective_time_disclosure_policy: "HIDE_DAY",
    strict_eligible: false,
    start_time_known: false,
    revealed: false,
    allowed_mutations: ["deposit", "withdraw"],
    result_label: "PRACTICE",
    active_rule_revision: 1,
    active_rule_hash: `sha256:${"a".repeat(64)}`,
    active_rule: { requested_start_ms: null },
    start_selection: {
      schema_version: "replay.start-selection.v1",
      start_mode: "RANDOM",
      seed_source: "SERVER",
      seed_disclosed: false,
      random_seed: null,
      dataset_epoch: `sha256:${"d".repeat(64)}`,
      parent_selection_hash: null,
      selection_hash: `sha256:${"e".repeat(64)}`,
      public_start: {
        policy: "HIDE_DAY",
        timeline_ms: 946_684_800_000,
        relative_ms: 0,
        sequence: 0,
        label: "D+1 16:00:00",
      },
      public_end: {
        policy: "HIDE_DAY",
        timeline_ms: 946_771_200_000,
        relative_ms: 86_400_000,
        sequence: 1,
        label: "D+2 16:00:00",
      },
    },
    public_time: {
      policy: "HIDE_DAY",
      timeline_ms: 946_684_800_000,
      relative_ms: 0,
      sequence: 0,
      label: "D+1 16:00:00",
    },
    mutations: [{
      action_sequence: 2,
      event_id: "action-00000002",
      command_id: "deposit-1",
      event_type: "DEPOSIT",
      rule_revision: 1,
      public_time: {
        policy: "HIDE_DAY",
        timeline_ms: 946_684_800_000,
        relative_ms: 0,
        sequence: 0,
        label: "D+1 16:00:00",
      },
      old_value: { equity: "10000" },
      new_value: { equity: "10250" },
      reason: "practice capital",
      state_hash_before: `sha256:${"b".repeat(64)}`,
      state_hash_after: `sha256:${"c".repeat(64)}`,
    }],
  });
  assert.equal(response.public_time.label, "D+1 16:00:00");
  assert.equal(response.mutations[0]?.new_value.equity, "10250");
  assert.equal(JSON.stringify(response).includes("1710000000000"), false);
});


test("equity parser and polyline remain bounded and Decimal-backed", () => {
  const response = parseReplayEquityResponse({
    protocol: "replay.v2",
    run_id: "run-1",
    resolution: "EVENT",
    bounded: true,
    limits: { EVENT: 2048, "1M": 4096, "15M": 2048, "1H": 2048 },
    samples: [
      {
        source_sequence: 0,
        revision: 0,
        public_time: { policy: "HIDE_ALL", timeline_ms: 946684800000, relative_ms: 0, sequence: 0, label: "D+1 T+00:00:00" },
        equity: "10000",
        cash_balance: "10000",
        unrealized_pnl: "0",
        ledger_tail_hash: `sha256:${"d".repeat(64)}`,
        state_hash: `sha256:${"e".repeat(64)}`,
      },
      {
        source_sequence: 1,
        revision: 1,
        public_time: { policy: "HIDE_ALL", timeline_ms: 946684860000, relative_ms: 60000, sequence: 1, label: "D+1 T+00:01:00" },
        equity: "10125.5",
        cash_balance: "10000",
        unrealized_pnl: "125.5",
        ledger_tail_hash: `sha256:${"f".repeat(64)}`,
        state_hash: `sha256:${"1".repeat(64)}`,
      },
    ],
  });
  assert.equal(response.bounded, true);
  const points = buildEquityPolyline(response.samples, 320, 96);
  assert.match(points, /^0,96 /);
  assert.match(points, /320,0$/);
});


test("review parser preserves read-only original hash and exact checkpoint selection", () => {
  const review = parseReplayReviewResponse(phase17ReviewResponse());
  assert.equal(review.read_only, true);
  assert.equal(review.events[0]?.state_hash, review.original_state_hash);
  assert.equal(review.projection.rules.instrument_rules[0]?.immutable_exchange_rule, true);
  assert.equal(review.budget.anchor_limit_bytes, 512 * 1_024 * 1_024);
});


test("semantic view sampler collapses one hundred thousand gestures to one command", () => {
  const sampler = new SemanticViewActionSampler();
  for (let index = 0; index < 100_000; index += 1) {
    sampler.offer("VISIBLE_RANGE", "main-chart-range", {
      from_sequence: index,
      to_sequence: index + 100,
    });
  }
  const pending = sampler.flush();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.value.from_sequence, 99_999);
  assert.equal(sampler.pendingCount, 0);
});


test("create contract exposes all seven policies and explicit integrity allowlist", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = replayCatalog();
  const draft = {
    name: "Practice",
    sourceKind: "BAR" as const,
    startMode: "RANDOM" as const,
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    settlementAsset: "USDT",
    baseInterval: "1m",
    displayInterval: "1m",
    requestedStartMs: null,
    indicatorWarmupBars: 200,
    visibleHistoryMode: "DURATION" as const,
    visibleHistoryLookbackMs: 12_000_000,
    forwardCacheMs: 86_400_000,
    initialEquity: "10000",
    maxLeverage: "3",
    makerFeeBps: "2",
    takerFeeBps: "5",
    marketSlippageBps: "1",
    marginMode: "CROSS" as const,
    fundingMode: "OFF" as const,
    accountDataMode: "APPROX_PROXY" as const,
    fixedFundingRate: "0.0001",
    fundingIntervalMs: 28_800_000,
    bookMode: "OFF" as const,
    integrityMode: "PRACTICE" as const,
    timeDisclosurePolicy: "HIDE_MINUTE" as const,
    allowedMutations: ["deposit", "withdraw"] as const,
  };
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog);
  assert.equal(evaluation.canSubmit, true);
  const request = buildTrainingRunCreateRequest(draft, evaluation, catalog);
  assert.equal(request.integrity_mode, "PRACTICE");
  assert.equal(request.time_disclosure_policy, "HIDE_MINUTE");
  assert.deepEqual(request.allowed_mutations, ["deposit", "withdraw"]);
  assert.equal(request.allow_rule_changes, true);
});
