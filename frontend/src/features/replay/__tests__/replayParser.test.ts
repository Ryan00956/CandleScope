import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReplayEventCausality,
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
  replayDeltaEvent,
  replayDigest,
  replayFinalStateEvent,
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
    fidelity: "VERIFIED_AGG_TRADE_APPROXIMATE_BARS",
    execution_fidelity: "AGG_TRADE_TAPE",
    requires_exact_dataset: true,
    bar_parity_required: false,
    reader: "paged",
  });

  const response = parseReplaySessionResponse(replayTradeSessionResponse());
  assert.equal(response.data_fidelity, "VERIFIED_AGG_TRADE_APPROXIMATE_BARS");
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

test("bar source events reject reversed and future public times", () => {
  const reversed = structuredClone(replayDeltaEvent());
  reversed.data.source_event.close_time_ms = reversed.data.source_event.open_time_ms - 1;
  assert.throws(() => parseReplayEvent(reversed), /source bar close precedes open/);

  const future = structuredClone(replayDeltaEvent());
  future.data.source_event.open_time_ms = future.virtual_time_ms + 1;
  future.data.source_event.close_time_ms = future.virtual_time_ms + 60_000;
  assert.throws(() => parseReplayEvent(future), /unrevealed source event/);
});

test("order events cannot smuggle a source bar update", () => {
  const projection = structuredClone(replayDeltaEvent().data.projection);
  const forged: Record<string, unknown> = {
    ...replayDeltaEvent(),
    type: "replay.order",
    data: { command_type: "place_order", projection },
  };
  assert.throws(() => parseReplayEvent(forged), /order event cannot carry a bar update/);

  Object.assign(projection, { bar_update: null });
  assert.equal(parseReplayEvent(forged).type, "replay.order");
});

test("session and atomic snapshot parsers bind protocol, session, counters, hashes, and epoch", () => {
  const response = parseReplaySessionResponse(replaySessionResponse());
  const event = parseReplayEvent(replaySnapshotEvent());
  assert.equal(response.snapshot.session_id, "session-0001");
  assert.equal(event.type, "replay.snapshot");
  assert.equal(event.data_epoch, response.snapshot.data_epoch);
  assert.equal(event.sequence, response.snapshot.sequence);
});

test("compact final-state bars decode exactly and cover old and mid-scan subscriber floors", () => {
  const event = parseReplayEvent(replayFinalStateEvent());
  assert.equal(event.type, "replay.final_state");
  assertReplayEventCausality(event, 0);
  assertReplayEventCausality(event, 1);
  if (event.type !== "replay.final_state" || !("source_sequence_to" in event.data)) {
    assert.fail("expected final-state event");
  }
  assert.equal(event.data.source_sequence_to, 2);
  assert.deepEqual(event.data.projection.series.bars.map((bar) => bar.close), ["100", "101", "102"]);
  assert.equal(event.data.projection.series.retained_count, 3);
  assert.equal(event.data.projection.series.bars.at(-1)?.open_time_ms, BASE_TIME_MS + 120_000);
});

test("compact final-state decoder matches the backend decimal/base36 golden vector", () => {
  const event = structuredClone(replayFinalStateEvent());
  const firstOpen = 1_710_000_000_000;
  const secondOpen = firstOpen + 60_000;
  Object.assign(event.data.projection.series, {
    replace_from_open_ms: firstOpen,
    retained_start_open_ms: firstOpen,
    retained_end_open_ms: secondOpen,
    retained_count: 2,
    bar_count: 2,
    first_open_ms: firstOpen,
    decimal_scales: {
      price: 8,
      volume: 8,
      quote_volume: 7,
      taker_buy_base: 8,
      taker_buy_quote: 8,
    },
    packed_bars: ",,24kd8fnm6,24keome4g,24kd131mn,24kduupvk,kf12oi,2miy2fvdh,8x,a4koy6,d0ug7ihji,0,0,1,1,1;1aao,,-44ud8g,evu4g,-gy9b28,-8w0hnk,1,~,~,~,~,0,0,1,1,1",
  });
  event.virtual_time_ms = secondOpen + 59_999;
  event.data.cursor.virtual_time_ms = event.virtual_time_ms;
  event.data.cursor.last_base_bar_open_ms = secondOpen;
  const parsed = parseReplayEvent(event);
  if (parsed.type !== "replay.final_state" || !("source_sequence_to" in parsed.data)) assert.fail("expected final-state event");
  assert.deepEqual(parsed.data.projection.series.bars.map((bar) => ({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    quoteVolume: bar.quote_volume,
    trades: bar.trades,
  })), [
    {
      open: "60000.12345678",
      high: "60001",
      low: "59999.99999999",
      close: "60000.5",
      volume: "12.3456789",
      quoteVolume: "740747.3456789",
      trades: 321,
    },
    {
      open: "59998",
      high: "60000.75",
      low: "59990.25",
      close: "59995.125",
      volume: "0.00000001",
      quoteVolume: null,
      trades: null,
    },
  ]);
});

test("compact final-state parser rejects corrupt counts, future bars, and uncovered source gaps", () => {
  const corruptCount = structuredClone(replayFinalStateEvent());
  corruptCount.data.projection.series.bar_count += 1;
  assert.throws(() => parseReplayEvent(corruptCount), /packed bar count/);

  const future = structuredClone(replayFinalStateEvent());
  future.virtual_time_ms -= 60_000;
  future.data.cursor.virtual_time_ms = future.virtual_time_ms;
  assert.throws(() => parseReplayEvent(future), /unrevealed bar time/);

  const gap = parseReplayEvent(replayFinalStateEvent({ sourceFrom: 2, sourceTo: 3 }));
  assert.throws(() => assertReplayEventCausality(gap, 0), /does not cover/);
});

test("ENDED compact final-state synchronizes terminal cursor, controller, and final bar", () => {
  const event = parseReplayEvent(replayFinalStateEvent({ state: "ENDED" }));
  assert.equal(event.type, "replay.final_state");
  if (event.type !== "replay.final_state" || !("cursor" in event.data)) {
    assert.fail("expected final-state event");
  }
  assert.equal(event.data.state, "ENDED");
  assert.equal(event.data.cursor.at_end, true);
  assert.equal(event.data.controller_client_id, null);
  assert.equal(
    event.data.projection.series.bars.at(-1)?.open_time_ms,
    event.data.projection.series.retained_end_open_ms,
  );
});

test("strict parser rejects retired session fields, fidelity values, and mismatched atomic counters", () => {
  const response = structuredClone(replaySessionResponse());
  Object.assign(response, { unexpected: true });
  assert.throws(() => parseReplaySessionResponse(response), ReplayPayloadParseError);

  const legacyFork = structuredClone(replaySessionResponse());
  Object.assign(legacyFork, { forked: true, forked_from_session_id: "session-0000" });
  assert.throws(() => parseReplaySessionResponse(legacyFork), /unknown field/);

  const legacySessionFidelity = structuredClone(replayTradeSessionResponse());
  Object.assign(legacySessionFidelity, { data_fidelity: "EXACT_AGG_TRADE_COVERAGE" });
  assert.throws(() => parseReplaySessionResponse(legacySessionFidelity), ReplayPayloadParseError);

  const legacyCapabilityFidelity = structuredClone(enabledAggTradeCapabilities());
  Object.assign(legacyCapabilityFidelity.sources.agg_trade, { fidelity: "EXACT_AGG_TRADE_COVERAGE" });
  assert.throws(() => parseReplayCapabilities(legacyCapabilityFidelity), ReplayPayloadParseError);

  const event = structuredClone(replaySnapshotEvent());
  event.sequence = 7;
  assert.throws(
    () => parseReplayEvent(event),
    /snapshot counters do not match envelope/,
  );
});

test("coalesced replay event ranges are complete and bound to the outer sequence", () => {
  const ranged = replayDeltaEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(ranged, { sequence_from: 1, sequence_to: 3 });
  const parsed = parseReplayEvent(ranged);
  assert.equal(parsed.sequence_from, 1);
  assert.equal(parsed.sequence_to, 3);

  const partial = replayDeltaEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(partial, { sequence_from: 1 });
  assert.throws(() => parseReplayEvent(partial), /sequence range is partial/);

  const mismatched = replayDeltaEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(mismatched, { sequence_from: 1, sequence_to: 2 });
  assert.throws(() => parseReplayEvent(mismatched), /does not end at envelope sequence/);

  const mandatory = replaySnapshotEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(mandatory, { sequence_from: 1, sequence_to: 3 });
  assert.throws(() => parseReplayEvent(mandatory), /only replay.delta/);
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
  const withBounds = structuredClone(blind);
  Object.assign(withBounds.entries[0]!, { bounds: { earliest_open_ms: BASE_TIME_MS } });
  assert.throws(() => parseReplayCatalog(withBounds), /blind catalog bounds must be null/);
  const withRanges = structuredClone(blind);
  Object.assign(withRanges.entries[0]!, { eligible_ranges: [{ start_ms: BASE_TIME_MS }] });
  assert.throws(() => parseReplayCatalog(withRanges), /blind catalog ranges must be empty/);
  const entry = blind.entries[0];
  assert.ok(entry);
  Object.assign(entry, { source_fingerprint: replayDigest("a") });
  assert.throws(() => parseReplayCatalog(blind), /unknown field/);
});

test("run market catalog preserves immutable T0 proof without leaking a hidden random start", () => {
  const parsed = parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: replayDigest("b"),
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: true,
    time_commitment: {
      schema_version: "replay.time-commitment.v1",
      start_mode: "RANDOM",
      committed: true,
      committed_start_ms: null,
      random_range_start_ms: null,
      random_range_end_ms: null,
      commitment_hash: replayDigest("c"),
    },
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 10,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: replayDigest("b"),
      bounds: null,
      eligible_ranges: [],
      start_compatibility: {
        state: "UNSUPPORTED",
        code: "MARKET_NOT_LISTED_AT_START",
        message: "本局开始时该商品尚未上市。",
      },
    }],
  });
  assert.equal(parsed.time_commitment?.committed, true);
  assert.equal(parsed.time_commitment?.committed_start_ms, null);
  assert.equal(
    parsed.entries[0]?.start_compatibility?.code,
    "MARKET_NOT_LISTED_AT_START",
  );
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
