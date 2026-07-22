import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayCapabilities, parseReplayCatalog, parseReplaySessionResponse } from "../replayParser.js";
import {
  buildReplayReportExport,
  buildReplayTrainingReportExport,
  replayReportToCsv,
  replayTrainingReportToCsv,
} from "../replayReportExport.js";
import type { ReplayTrainingReportResponse } from "../replayIntegrityModel.js";
import {
  buildReplaySessionConfig,
  createReplaySessionDraft,
  evaluateReplaySessionDraft,
  formatReplaySyntheticTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayCatalogIdentity,
  replayEffectiveTrainingState,
} from "../replayUiModel.js";
import { buildReplaySmaLine } from "../useReplayIndicatorRuntime.js";
import {
  BASE_TIME_MS,
  enabledAggTradeCapabilities,
  enabledCapabilities,
  replayDigest,
  replayReport,
  replaySessionResponse,
} from "./fixtures.js";
import type { EpochSeconds, KlineBar } from "../../market-data/marketDataTypes.js";

function catalog() {
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: replayDigest("9"),
    warmup_bars: 500,
    horizon_ms: 604_800_000,
    quality_mode: "exact",
    blind_mode: true,
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      bounds: null,
      eligible_ranges: [],
      eligible_window_count: 12,
      quality: "EXACT_BAR_COVERAGE",
      catalog_epoch: replayDigest("9"),
      limitations: [],
    }],
  });
}

test("session dialog model is capability-driven and emits an immutable exact BAR config", () => {
  const parsedCatalog = catalog();
  const draft = createReplaySessionDraft(parsedCatalog);
  assert.equal(draft.catalogIdentity, replayCatalogIdentity(parsedCatalog.entries[0]!));
  const evaluation = evaluateReplaySessionDraft(draft, parseReplayCapabilities(enabledCapabilities()), parsedCatalog);
  assert.equal(evaluation.canSubmit, true);
  assert.equal(evaluation.dataFidelity, "EXACT_BAR_COVERAGE");
  const config = buildReplaySessionConfig({ ...draft, initialEquity: "010000.00" }, evaluation);
  assert.equal(config.source_kind, "bar");
  assert.equal(config.quality_mode, "exact");
  assert.equal(config.execution_model, "paper_linear_v1");
  assert.equal(config.initial_equity, "10000");
  assert.equal(config.requested_start_ms, null);
});

test("session dialog emits aggregate-trade config only behind the exact archive capability", () => {
  const parsedCatalog = catalog();
  const draft = { ...createReplaySessionDraft(parsedCatalog), sourceKind: "agg_trade" as const };
  const unavailable = evaluateReplaySessionDraft(
    draft,
    parseReplayCapabilities(enabledCapabilities()),
    parsedCatalog,
  );
  assert.equal(unavailable.canSubmit, false);
  assert.equal(unavailable.disabledReason, "ARCHIVE_DISABLED");

  const evaluation = evaluateReplaySessionDraft(
    draft,
    parseReplayCapabilities(enabledAggTradeCapabilities()),
    parsedCatalog,
  );
  assert.equal(evaluation.canSubmit, true);
  assert.equal(evaluation.dataFidelity, "EXACT_AGG_TRADE_COVERAGE");
  assert.equal(evaluation.executionFidelity, "AGG_TRADE_TAPE");
  const config = buildReplaySessionConfig(draft, evaluation);
  assert.equal(config.source_kind, "agg_trade");
  assert.equal(config.quality_mode, "exact");
});

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
  assert.equal(replayEffectiveTrainingState(null, "PAUSED", null), "PAUSED");
});

test("replay local indicator drops every source row after the public cursor", () => {
  const rows: KlineBar[] = Array.from({ length: 25 }, (_, index) => ({
    time: ((BASE_TIME_MS / 1_000) + index * 60) as EpochSeconds,
    close: 100 + index,
  }));
  const cursorMs = BASE_TIME_MS + 21 * 60_000;
  const line = buildReplaySmaLine(rows, cursorMs, 3);
  assert.ok((line.data?.length ?? 0) > 0);
  assert.ok((line.data ?? []).every((point) => point.time * 1_000 <= cursorMs));
  assert.equal(line.data?.at(-1)?.time, (BASE_TIME_MS / 1_000) + 21 * 60);
});

test("report exports bind fidelity, warnings and hashes without actual history before reveal", () => {
  const response = {
    protocol: "replay.v1" as const,
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE" as const,
    execution_fidelity: "BAR_CONSERVATIVE" as const,
    revealed: false,
    report: replayReport(),
  };
  const input = {
    sessionId: "session-0001",
    config: parseReplaySessionResponse(replaySessionResponse()).snapshot.config,
    response,
    commandTimeline: [],
    journal: [],
  };
  const exported = buildReplayReportExport(input);
  assert.equal(Object.hasOwn(exported, "actual_history"), false);
  assert.deepEqual(exported.integrity, {
    state_hash: replayDigest("3"),
    ledger_tail_hash: replayDigest("6"),
    report_hash: replayDigest("7"),
    config_hash: replayDigest("d"),
  });
  const csv = replayReportToCsv(input);
  assert.match(csv, /EXACT_BAR_COVERAGE/);
  assert.match(csv, /report_hash/);
});

test("v2 training exports preserve integrity policy and hide actual history until reveal", () => {
  const response = {
    protocol: "replay.v2",
    run_id: "run-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
    integrity: {
      protocol: "replay.v2",
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
      public_time: {
        policy: "HIDE_ALL",
        timeline_ms: 86_400_000,
        relative_ms: 0,
        sequence: 0,
        label: "D+1 T+00:00:00",
      },
      mutations: [],
    },
  } satisfies ReplayTrainingReportResponse;
  const exported = buildReplayTrainingReportExport(response);
  assert.equal(exported.protocol, "replay.v2");
  assert.equal(Object.hasOwn(exported, "actual_history"), false);
  assert.equal((exported.integrity as ReplayTrainingReportResponse["integrity"]).result_label, "STRICT_CHALLENGE");
  const csv = replayTrainingReportToCsv(response);
  assert.match(csv, /STRICT_CHALLENGE/);
  assert.match(csv, /report_hash/);
  assert.doesNotMatch(csv, /actual_history/);
});
