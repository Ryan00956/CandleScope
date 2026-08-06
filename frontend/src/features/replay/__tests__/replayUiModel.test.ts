import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayTrainingReportExport,
  replayTrainingReportToCsv,
} from "../replayReportExport.js";
import type { ReplayTrainingReportResponse } from "../replayIntegrityModel.js";
import {
  formatReplaySyntheticTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayEffectiveTrainingState,
} from "../replayUiModel.js";
import {
  BASE_TIME_MS,
  replayDigest,
  replayReport,
} from "./fixtures.js";

test("blind public time is synthetic D+N and never renders a calendar date", () => {
  const value = formatReplaySyntheticTime(BASE_TIME_MS + 86_400_000 + 3_661_000, BASE_TIME_MS);
  assert.equal(value, "D+1 01:01:01");
  assert.doesNotMatch(value, /20\d\d|\/|-\d{2}-/);
});

test("activity views keep a newest-first bounded window without mutating authority history", () => {
  const authority = Array.from({ length: 100 }, (_, index) => index + 1);
  const visible = recentReplayActivity(authority);
  assert.equal(visible.length, REPLAY_ACTIVITY_VIEW_LIMIT);
  assert.deepEqual(visible, Array.from({ length: REPLAY_ACTIVITY_VIEW_LIMIT }, (_, index) => 100 - index));
  assert.deepEqual(authority.slice(0, 3), [1, 2, 3]);
  assert.equal(authority.length, 100);
});

test("training state fails closed when the global clock outlives its controller lease", () => {
  assert.equal(replayEffectiveTrainingState("PLAYING", "PAUSED", null), "PAUSED");
  assert.equal(replayEffectiveTrainingState("PLAYING", "PLAYING", null), "PAUSED");
  assert.equal(replayEffectiveTrainingState("ADVANCING", "PAUSED", null), "PAUSED");
  assert.equal(replayEffectiveTrainingState("PLAYING", "PAUSED", "other-browser"), "PLAYING");
  assert.equal(replayEffectiveTrainingState("ERROR", "PAUSED", null), "ERROR");
  assert.equal(replayEffectiveTrainingState("ENDED", "PAUSED", null), "ENDED");
  assert.equal(replayEffectiveTrainingState("PAUSED", "ENDED", null), "ENDED");
  assert.equal(replayEffectiveTrainingState(null, "PAUSED", null), "PAUSED");
});

test("v2 training exports preserve integrity policy and hide actual history until reveal", () => {
  const response = {
    protocol: "replay.v3",
    run_id: "run-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
    integrity: {
      protocol: "replay.v3",
      run_id: "run-0001",
      integrity_mode: "CHALLENGE",
      configured_time_disclosure_policy: "HIDE_ALL",
      effective_time_disclosure_policy: "HIDE_ALL",
      strict_eligible: true,
      start_time_known: false,
      revealed: false,
      allowed_mutations: [],
      result_label: "STRICT_CHALLENGE",
      active_rule_revision: 1,
      active_rule_hash: replayDigest("e"),
      active_rule: {},
      start_selection: {
        schema_version: "replay.start-selection.v1",
        start_mode: "RANDOM",
        seed_source: "SERVER",
        seed_disclosed: false,
        random_seed: null,
        dataset_epoch: replayDigest("1"),
        parent_selection_hash: null,
        selection_hash: replayDigest("2"),
        public_start: {
          policy: "HIDE_ALL",
          timeline_ms: 86_400_000,
          relative_ms: 0,
          sequence: 0,
          label: "D+1 T+00:00:00",
        },
        public_end: {
          policy: "HIDE_ALL",
          timeline_ms: 172_800_000,
          relative_ms: 86_400_000,
          sequence: 1,
          label: "D+2 T+00:00:00",
        },
      },
      public_time: {
        policy: "HIDE_ALL",
        timeline_ms: 86_400_000,
        relative_ms: 0,
        sequence: 0,
        label: "D+1 T+00:00:00",
      },
      mutations: [],
    },
    public_time_index: {
      protocol: "replay.v3",
      run_id: "run-0001",
      policy: "HIDE_ALL",
      items: [],
    },
    modelled_account: {
      schema_version: "replay.training.portfolio.v1",
      fidelity: "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER",
      position_mode: "ONE_WAY",
      settlement_account_shared: true,
      initial_equity: "10000",
      equity: "10000",
      cash_balance: "10000",
      available_equity: "10000",
      reserved_margin: "0",
      margin_used: "0",
      realized_pnl: "0",
      unrealized_pnl: "0",
      fees_paid: "0",
      positions: [],
    },
    account_audit: null,
    liquidation_channel_contract: {
      simulated_account: "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED",
      historical_market: "INDEPENDENT_FEED_OR_UNSUPPORTED",
    },
  } satisfies ReplayTrainingReportResponse;
  const exported = buildReplayTrainingReportExport(response);
  assert.equal(exported.protocol, "replay.v3");
  assert.equal(Object.hasOwn(exported, "actual_history"), false);
  assert.equal((exported.integrity as ReplayTrainingReportResponse["integrity"]).result_label, "STRICT_CHALLENGE");
  const csv = replayTrainingReportToCsv(response);
  assert.match(csv, /STRICT_CHALLENGE/);
  assert.match(csv, /report_hash/);
  assert.doesNotMatch(csv, /actual_history/);
});
