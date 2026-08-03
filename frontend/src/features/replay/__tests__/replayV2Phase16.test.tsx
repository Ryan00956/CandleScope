import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TrainingHubDialog from "../components/TrainingHubDialog.js";
import { parseReplayCapabilities, parseReplayCatalog } from "../replayParser.js";
import {
  buildReplayTrainingReportExport,
  replayTrainingReportToCsv,
} from "../replayReportExport.js";
import { parseReplayTrainingReportResponse } from "../replayIntegrityModel.js";
import { parseReplaySegmentPreparePlan } from "../replaySegmentTypes.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
} from "../trainingHubModel.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";
import {
  parseReplayAccountAuditResponse,
  parseReplayTrainingPortfolio,
} from "../replayV2Types.js";
import { ReplayV2ApiClient } from "../replayV2Api.js";
import { replayAdvanceIsCancelable } from "../useReplayViewerRuntime.js";
import { enabledCapabilities, replayDigest, replayReport } from "./fixtures.js";

const START_MS = 1_710_000_000_000;

test("Phase 16 polls and exposes cancellation only for guaranteed cancelable advances", () => {
  const command = (type: "advance" | "advance_by" | "advance_to", basis: string) => ({
    protocol: "replay.v2" as const,
    run_id: "run-16",
    command_id: `command-${type}-${basis}`,
    client_instance_id: "browser-16",
    expected_revision: 1,
    expected_cursor: {
      virtual_time_ms: START_MS,
      source_sequence: 1,
      revision: 1,
    },
    type,
    payload: type === "advance" ? { basis, count: 1 } : {},
  });

  assert.equal(replayAdvanceIsCancelable(null), false);
  assert.equal(replayAdvanceIsCancelable(command("advance", "BASE_BAR")), false);
  assert.equal(replayAdvanceIsCancelable(command("advance", "DISPLAY_BAR")), false);
  assert.equal(replayAdvanceIsCancelable(command("advance", "SOURCE_EVENT")), false);
  assert.equal(replayAdvanceIsCancelable(command("advance", "VIRTUAL_TIME")), true);
  assert.equal(replayAdvanceIsCancelable(command("advance_by", "legacy")), true);
  assert.equal(replayAdvanceIsCancelable(command("advance_to", "legacy")), true);
});

function visibleCatalog() {
  const epoch = replayDigest("a");
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: epoch,
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: false,
    entries: [{
      identity: {
        exchange: "binance",
        market_type: "usdm_perpetual",
        symbol: "BTCUSDT",
      },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 1,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: epoch,
      bounds: {
        earliest_open_ms: START_MS - 200 * 60_000,
        latest_source_open_ms: START_MS + 1_440 * 60_000,
        latest_closed_open_ms: START_MS + 1_440 * 60_000,
        total_count: 1_641,
      },
      gap_summary: {
        gaps: [],
        gap_count: 0,
        missing_bars: 0,
        scanned_bars: 1_641,
        scan_calls: 1,
        calendar_id: "continuous",
      },
      source_fingerprint: replayDigest("b"),
      eligible_ranges: [{
        interval: "1m",
        interval_ms: 60_000,
        first_start_ms: START_MS,
        last_start_ms: START_MS,
        count: 1,
        warmup_bars: 200,
        replay_bars: 1_440,
      }],
    }],
  });
}

function exactPlan(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "replay.data.prepare.v1",
    state: "PREPARE_ON_CREATE",
    source_kind: "BAR",
    identity: {
      exchange: "binance",
      market_type: "usdm_perpetual",
      symbol: "BTCUSDT",
      base_interval: "1m",
    },
    estimated_size_bytes: 394_560,
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
    },
    prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE",
    existing_ready_segments: 1,
    existing_ready_bytes: 394_560,
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
      feature_enabled: true,
      requested_mode: "HISTORICAL_EXACT",
      capability_state: "AVAILABLE_EXACT",
      reason: "VERIFIED_OPERATOR_CAPTURE",
      fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      supported_contract_model: "LINEAR_QUOTE_SETTLED_V1",
      supported_position_mode: "ONE_WAY",
      supported_margin_asset_mode: "SINGLE_QUOTE",
      historical_funding_exact: true,
      public_kline_proxy_accepted: false,
      ready_archive_bytes: 65_536,
      max_archive_bytes: 137_438_953_472,
      coverage: {
        range_start_ms: START_MS,
        range_end_ms: START_MS + 86_460_000,
      },
      account_history_ref: {
        schema_version: "replay.account-history-ref.v1",
        archive_id: "account-btc-202403",
        dataset_epoch: replayDigest("c"),
        checksum_sha256: replayDigest("d"),
      },
    },
    ...overrides,
  };
}

function exactPortfolioRaw() {
  return {
    schema_version: "replay.training.portfolio.v2",
    account_model: "TOUCH_OR_TAPE_V2",
    execution_model: "TOUCH_OR_TAPE_V2",
    execution_fidelity: "NO_BOOK_TOUCH_OR_TAPE_APPROX",
    settlement_account_shared: true,
    margin_mode: "CROSS",
    funding_mode: "HISTORICAL_EXACT",
    status: "ACTIVE",
    initial_equity: "10000",
    equity: "10001",
    cash_balance: "9999",
    available_equity: "9901",
    reserved_margin: "0",
    margin_used: "100",
    maintenance_margin: "5",
    realized_pnl: "0",
    unrealized_pnl: "2",
    fees_paid: "1",
    funding_cashflow: "-0.5",
    liquidation_fees_paid: "0",
    risk_ratio: "2000.2",
    positions: [],
    orders: [],
    fills: [],
    active_fee_policy: null,
    instrument_rules: [{
      track_id: "track-1",
      revision: 1,
      fidelity: "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE",
    }],
    isolated_allocations: {},
    next_funding_time_ms: START_MS + 28_800_000,
    liquidations: [],
    account_history: {
      mode: "HISTORICAL_EXACT",
      status: "ACTIVE",
      fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      archive_proof_hash: replayDigest("e"),
      bindings: [{
        track_id: "track-1",
        archive_id: "account-btc-202403",
        dataset_epoch: replayDigest("c"),
        checksum_sha256: replayDigest("d"),
        proof_hash: replayDigest("f"),
        event_chain_tail: replayDigest("1"),
        archive_generation: 1,
        last_event_sequence: 3,
        as_of_actual_time_ms: START_MS + 60_000,
        as_of_virtual_time_ms: START_MS + 60_000,
        mark_price: "101",
        index_price: "100.9",
        status: "READY",
      }],
      auditor: {
        status: "PASS",
        proof_hash: replayDigest("2"),
        differences: [],
      },
    },
    liquidation_channels: {
      simulated_account: {
        label: "模拟账户强平",
        source: "MODELLED_ACCOUNT",
        fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      },
      historical_market: {
        label: "历史市场爆仓",
        source: "INDEPENDENT_MARKET_LIQUIDATION_FEED",
        fidelity: "UNSUPPORTED_NO_HISTORY",
      },
    },
    ledger: {
      chain_version: "replay.training.contract-ledger.v1",
      entry_count: 3,
      tail_hash: replayDigest("3"),
      cash_total: "9999",
      reconciliation_delta: "0",
      entries: [],
    },
    fidelity: {
      instrument_rules: "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE",
      fees: "CONFIGURED_DECIMAL_FEE_POLICY",
      funding: "HISTORICAL_EXACT_ARCHIVE_FUNDING",
      mark: "HISTORICAL_EXACT_ARCHIVE_MARK",
      liquidation: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
    },
  };
}

function accountAuditRaw() {
  return {
    schema_version: "replay.account-audit.v1",
    status: "PASS",
    proof_hash: replayDigest("2"),
    differences: [],
    snapshot: {
      schema_version: "replay.account-audit.v1",
      run_id: "run-16",
      account_data_mode: "HISTORICAL_EXACT",
    },
  };
}

function publicTime(sequence: number, relativeMs: number) {
  return {
    policy: "HIDE_ALL",
    timeline_ms: START_MS + relativeMs,
    relative_ms: relativeMs,
    sequence,
    label: `T+${relativeMs}`,
  };
}

test("Phase 16 launcher pins the exact plan ref and rejects every implicit proxy fallback", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = visibleCatalog();
  const draft = {
    ...createTrainingRunDraft(catalog),
    startMode: "MANUAL" as const,
    requestedStartMs: START_MS,
    accountDataMode: "HISTORICAL_EXACT" as const,
    fundingMode: "HISTORICAL_EXACT" as const,
  };
  const withoutPlan = evaluateTrainingRunDraft(draft, capabilities, catalog);
  assert.equal(withoutPlan.canSubmit, false);
  assert.match(withoutPlan.errors.join("\n"), /尚未.*精确账户历史/);

  const plan = parseReplaySegmentPreparePlan(exactPlan());
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog, plan);
  assert.equal(evaluation.canSubmit, true);
  const payload = buildTrainingRunCreateRequest(draft, evaluation, catalog);
  assert.equal(payload.account_data_mode, "HISTORICAL_EXACT");
  assert.equal(payload.funding_mode, "HISTORICAL_EXACT");
  assert.deepEqual(payload.account_history_ref, plan.account_history.account_history_ref);
  assert.equal(plan.account_history.public_kline_proxy_accepted, false);

  assert.throws(() => parseReplaySegmentPreparePlan(exactPlan({
    account_history: {
      ...exactPlan().account_history,
      public_kline_proxy_accepted: true,
    },
  })), /unsupported/);
  assert.throws(() => parseReplaySegmentPreparePlan(exactPlan({
    account_history: {
      ...exactPlan().account_history,
      account_history_ref: null,
    },
  })), /inconsistent/);
});

test("Phase 16 portfolio parser keeps exact account liquidation separate from market liquidation", () => {
  const parsed = parseReplayTrainingPortfolio(exactPortfolioRaw());
  assert.equal(parsed.schema_version, "replay.training.portfolio.v2");
  if (parsed.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("exact contract portfolio did not survive parsing");
  }
  assert.equal(parsed.account_history.mode, "HISTORICAL_EXACT");
  assert.equal(parsed.account_history.auditor.status, "PASS");
  assert.equal(
    parsed.liquidation_channels.simulated_account.fidelity,
    "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
  );
  assert.equal(
    parsed.liquidation_channels.historical_market.fidelity,
    "UNSUPPORTED_NO_HISTORY",
  );
  assert.throws(() => parseReplayTrainingPortfolio({
    ...exactPortfolioRaw(),
    liquidation_channels: {
      ...exactPortfolioRaw().liquidation_channels,
      historical_market: exactPortfolioRaw().liquidation_channels.simulated_account,
    },
  }), /conflated|inconsistent/);
});

test("Phase 16 account audit API is run-scoped, POST-only, and strictly parsed", async () => {
  const calls: { url: string; method: string }[] = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
      });
      return new Response(JSON.stringify(accountAuditRaw()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const audit = await client.auditAccount("run-16");
  assert.equal(audit.status, "PASS");
  assert.deepEqual(calls, [{
    url: "/api/v1/replay/runs/run-16/account-audit",
    method: "POST",
  }]);
  assert.throws(() => parseReplayAccountAuditResponse({
    ...accountAuditRaw(),
    status: "FAIL",
  }), /inconsistent/);
});

test("Phase 16 report and CSV retain archive/auditor proof and both liquidation domains", () => {
  const response = parseReplayTrainingReportResponse({
    protocol: "replay.v2",
    run_id: "run-16",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
    integrity: {
      protocol: "replay.v2",
      run_id: "run-16",
      integrity_mode: "CHALLENGE",
      configured_time_disclosure_policy: "HIDE_ALL",
      effective_time_disclosure_policy: "HIDE_ALL",
      strict_eligible: false,
      start_time_known: true,
      revealed: false,
      allowed_mutations: [],
      result_label: "MANUAL_START_CHALLENGE",
      active_rule_revision: 1,
      active_rule_hash: replayDigest("4"),
      active_rule: {},
      start_selection: {
        schema_version: "replay.start-selection.v1",
        start_mode: "MANUAL",
        seed_source: "MANUAL",
        seed_disclosed: false,
        random_seed: null,
        dataset_epoch: replayDigest("5"),
        parent_selection_hash: null,
        selection_hash: replayDigest("6"),
        public_start: publicTime(0, 0),
        public_end: publicTime(1, 86_400_000),
      },
      public_time: publicTime(0, 0),
      mutations: [],
    },
    public_time_index: {
      protocol: "replay.v2",
      run_id: "run-16",
      policy: "HIDE_ALL",
      items: [],
    },
    modelled_account: exactPortfolioRaw(),
    account_audit: accountAuditRaw(),
    liquidation_channel_contract: {
      simulated_account: "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED",
      historical_market: "INDEPENDENT_FEED_OR_UNSUPPORTED",
    },
  });
  const exported = buildReplayTrainingReportExport(response);
  assert.equal(
    (exported.account_audit as { status: string }).status,
    "PASS",
  );
  const csv = replayTrainingReportToCsv(response);
  assert.match(csv, /account_data_mode.*HISTORICAL_EXACT/s);
  assert.match(csv, /account_history_binding.*account-btc-202403/s);
  assert.match(csv, /simulated_account_liquidation/);
  assert.match(csv, /historical_market_liquidation.*UNSUPPORTED_NO_HISTORY/s);
});

test("Phase 16 Hub visibly discloses the exact archive contract before create", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = visibleCatalog();
  const plan = parseReplaySegmentPreparePlan(exactPlan());
  const draft = {
    ...createTrainingRunDraft(catalog),
    startMode: "MANUAL" as const,
    requestedStartMs: START_MS,
    accountDataMode: "HISTORICAL_EXACT" as const,
    fundingMode: "HISTORICAL_EXACT" as const,
  };
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog, plan);
  const runtime = {
    phase: "READY",
    items: [],
    nextCursor: null,
    filters: { state: null, sourceKind: null, compatibility: null },
    operation: null,
    error: null,
    createOpen: true,
    capabilities,
    catalog,
    draft,
    evaluation,
    segmentPlan: plan,
    storageOpen: false,
    storageInventory: null,
    storagePlan: null,
    storagePlanConfirmed: false,
    storageResult: null,
    actions: {
      refresh() {},
      loadNext() {},
      setFilters() {},
      openCreate() {},
      closeCreate() {},
      openStorage() {},
      closeStorage() {},
      refreshStorage() {},
      planStorageGc() {},
      confirmStoragePlan() {},
      runStorageGc() {},
      rehydrateStorageObject() {},
      setDraft() {},
      refreshCreatePlan() {},
      createRun() {},
      deleteRun() {},
      continueRun() {},
    },
  } satisfies TrainingHubRuntime;
  const html = renderToStaticMarkup(<TrainingHubDialog runtime={runtime} />);
  assert.match(html, /data-account-history-capability="AVAILABLE_EXACT"/);
  assert.match(html, /account-btc-202403/);
  assert.match(html, /公开 K 线代理.*拒绝/);
  assert.match(html, /HISTORICAL_EXACT · 归档结算/);
});
