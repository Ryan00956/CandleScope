import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReplayCapabilities,
  parseReplayCatalog,
  parseReplayCommandResult,
  parseReplayDecimal,
  parseReplayErrorEnvelope,
  parseReplayEvent,
  parseReplayJournalResponse,
  parseReplayReportResponse,
  parseReplaySessionResponse,
  ReplayPayloadParseError,
} from "../replayParser.js";
import {
  BASE_TIME_MS,
  disabledCapabilities,
  enabledAggTradeCapabilities,
  enabledCapabilities,
  replayBar,
  replayDigest,
  replayReport,
  replaySessionResponse,
  replaySnapshotEvent,
  replaySourceTrade,
  replayTradeDeltaEvent,
  replayTradeSessionResponse,
} from "./fixtures.js";

test("unknown-first parser accepts enabled and disabled capability variants", () => {
  const enabled = parseReplayCapabilities(enabledCapabilities());
  const disabled = parseReplayCapabilities(disabledCapabilities());
  assert.equal(enabled.sources.bar.fidelity, "EXACT_BAR_COVERAGE");
  assert.equal(disabled.reason, "REPLAY_DISABLED");
  assert.equal(disabled.persistence.opened, false);
});

test("aggregate-trade capability, snapshot, source event and batched bars cross the strict boundary", () => {
  const capabilities = parseReplayCapabilities(enabledAggTradeCapabilities());
  assert.deepEqual(capabilities.sources.agg_trade, {
    enabled: true,
    fidelity: "EXACT_AGG_TRADE_COVERAGE",
    execution_fidelity: "AGG_TRADE_TAPE",
    requires_exact_dataset: true,
    reader: "paged",
  });

  const response = parseReplaySessionResponse(replayTradeSessionResponse());
  assert.equal(response.data_fidelity, "EXACT_AGG_TRADE_COVERAGE");
  assert.equal(response.execution_fidelity, "AGG_TRADE_TAPE");
  assert.equal(response.snapshot.config.source_kind, "agg_trade");
  assert.ok("public_projection" in response.snapshot.components.bar_builder);

  const event = structuredClone(replayTradeDeltaEvent());
  event.data.projection.bar_update = {
    action: "batch",
    updates: [
      event.data.projection.bar_update,
      {
        action: "append",
        bar: {
          ...replayBar(BASE_TIME_MS + 60_000, "101"),
          is_closed: false,
        },
        source_sequence: 2,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "previous_close_zero_volume",
      },
    ],
  };
  const parsed = parseReplayEvent(event);
  assert.equal(parsed.type, "replay.delta");
  assert.ok("source_event" in parsed.data && "trade_time_ms" in parsed.data.source_event);
  assert.ok("projection" in parsed.data && parsed.data.projection.bar_update?.action === "batch");
});

test("aggregate-trade blind payloads reject archive paths and unrevealed actual times", () => {
  const leakedPath = structuredClone(replayTradeDeltaEvent());
  Object.assign(leakedPath.data.source_event, {
    object_id: "date=2026-06-01/part-000.parquet",
  });
  assert.throws(() => parseReplayEvent(leakedPath), /unknown field/);

  const future = structuredClone(replayTradeDeltaEvent());
  future.data.source_event = replaySourceTrade(future.virtual_time_ms + 1, 101);
  assert.throws(() => parseReplayEvent(future), /unrevealed source event/);
});

test("session and atomic snapshot parsers bind protocol, session, counters, hashes, and epoch", () => {
  const response = parseReplaySessionResponse(replaySessionResponse());
  const event = parseReplayEvent(replaySnapshotEvent());
  assert.equal(response.snapshot.session_id, "session-0001");
  assert.equal(event.type, "replay.snapshot");
  assert.equal(event.data_epoch, response.snapshot.data_epoch);
  assert.equal(event.sequence, response.snapshot.sequence);
});

test("strict parser rejects unknown fields and mismatched atomic envelope counters", () => {
  const response = structuredClone(replaySessionResponse());
  Object.assign(response, { unexpected: true });
  assert.throws(() => parseReplaySessionResponse(response), ReplayPayloadParseError);

  const event = structuredClone(replaySnapshotEvent());
  event.sequence = 7;
  assert.throws(
    () => parseReplayEvent(event),
    /snapshot counters do not match envelope/,
  );
});

test("Decimal parser only accepts canonical plain finite strings", () => {
  for (const value of ["0", "-12.5", "100.25"]) assert.equal(parseReplayDecimal(value), value);
  for (const value of ["01", "+1", "1.0", "-0", "1e3", "NaN", 1]) {
    assert.throws(() => parseReplayDecimal(value), ReplayPayloadParseError);
  }
});

test("all replay HTTP response families cross a strict parser boundary", () => {
  const catalog = parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: replayDigest("6"),
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: false,
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      bounds: { earliest_open_ms: BASE_TIME_MS, latest_source_open_ms: BASE_TIME_MS, latest_closed_open_ms: BASE_TIME_MS, total_count: 1 },
      gap_summary: { gaps: [], gap_count: 0, missing_bars: 0, scanned_bars: 1, scan_calls: 1, calendar_id: "utc" },
      eligible_ranges: [],
      eligible_window_count: 0,
      quality: "EXACT_BAR_COVERAGE",
      source_fingerprint: replayDigest("7"),
      limitations: [],
      catalog_epoch: replayDigest("6"),
    }],
  });
  assert.equal(catalog.entries[0]?.identity.symbol, "BTCUSDT");

  const error = parseReplayErrorEnvelope({
    protocol: "replay.v1",
    error: { code: "SESSION_NOT_FOUND", message: "missing", details: { session_id: "x" } },
  });
  assert.equal(error.error.code, "SESSION_NOT_FOUND");

  const command = parseReplayCommandResult({
    protocol: "replay.v1",
    session_id: "session-0001",
    command_id: "command-0001",
    revision: 1,
    sequence: 1,
    state: "PAUSED",
    state_hash: replayDigest("8"),
    cursor: {
      virtual_time_ms: BASE_TIME_MS,
      source_sequence: 0,
      last_base_bar_open_ms: BASE_TIME_MS,
      last_trade_time_ms: null,
      last_agg_trade_id: null,
      at_end: false,
    },
    data: {},
  });
  assert.equal(command.command_id, "command-0001");

  const journal = parseReplayJournalResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    entries: [{ entry_id: "command-0001", virtual_time_ms: BASE_TIME_MS, text: "note" }],
  });
  assert.equal(journal.entries.length, 1);

  const report = parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
  });
  assert.equal(report.revealed, false);
});

test("blind catalog entries cannot smuggle source fingerprint or bounds", () => {
  const blind = {
    protocol: "replay.v1",
    catalog_epoch: replayDigest("9"),
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
      catalog_epoch: replayDigest("9"),
      bounds: null,
      eligible_ranges: [],
    }],
  };
  assert.equal(parseReplayCatalog(blind).entries[0]?.bounds, null);
  const entry = blind.entries[0];
  assert.ok(entry);
  Object.assign(entry, { source_fingerprint: replayDigest("a") });
  assert.throws(() => parseReplayCatalog(blind), /unknown field/);
});

test("report actual history is accepted only at the explicit revealed boundary", () => {
  const base = {
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    report: replayReport(),
  };
  const actualHistory = {
    replay_start_ms: BASE_TIME_MS,
    replay_end_open_ms: BASE_TIME_MS + 60_000,
  };

  assert.throws(() => parseReplayReportResponse({
    ...base,
    revealed: false,
    actual_history: actualHistory,
  }), /unrevealed report cannot include actual_history/);
  assert.throws(() => parseReplayReportResponse({
    ...base,
    revealed: true,
  }), /revealed report must include actual_history/);
  assert.throws(() => parseReplayReportResponse({
    ...base,
    revealed: true,
    actual_history: {
      replay_start_ms: actualHistory.replay_end_open_ms,
      replay_end_open_ms: actualHistory.replay_start_ms,
    },
  }), /replay end cannot precede replay start/);
  assert.deepEqual(parseReplayReportResponse({
    ...base,
    revealed: true,
    actual_history: actualHistory,
  }).actual_history, actualHistory);
});
