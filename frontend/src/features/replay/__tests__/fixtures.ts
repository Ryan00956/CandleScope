import { REPLAY_PROTOCOL } from "../replayTypes.js";
import type { ReplayDigest } from "../replayTypes.js";

export const BASE_TIME_MS = 1_700_000_000_000;

export function replayDigest(character = "a"): ReplayDigest {
  return `sha256:${character.repeat(64)}` as ReplayDigest;
}

export function replayBar(openTimeMs = BASE_TIME_MS, close = "100") {
  return {
    open_time_ms: openTimeMs,
    close_time_ms: openTimeMs + 59_999,
    open: "100",
    high: "101",
    low: "99",
    close,
    volume: "10",
    quote_volume: "1000",
    trades: 5,
    taker_buy_base: "4",
    taker_buy_quote: "400",
    first_base_open_ms: openTimeMs,
    last_base_open_ms: openTimeMs,
    component_count: 1,
    expected_components: 1,
    is_closed: true,
    synthetic: false,
  };
}

export function replaySourceBar(openTimeMs = BASE_TIME_MS, close = "100") {
  return {
    open_time_ms: openTimeMs,
    close_time_ms: openTimeMs + 59_999,
    open: "100",
    high: "101",
    low: "99",
    close,
    volume: "10",
    quote_volume: "1000",
    trades: 5,
    taker_buy_base: "4",
    taker_buy_quote: "400",
    source: "fixture",
  };
}

export function replayConfig() {
  return {
    protocol: REPLAY_PROTOCOL,
    source_kind: "bar",
    exchange: "binance",
    market_type: "spot",
    symbol: "BTCUSDT",
    base_interval: "1m",
    display_interval: "1m",
    start_policy: "random_eligible",
    requested_start_ms: null,
    warmup_bars: 1,
    horizon_ms: 3_600_000,
    random_seed: 42,
    quality_mode: "exact",
    blind_mode: false,
    initial_equity: "10000",
    quote_asset: "USDT",
    execution_model: "paper_linear_v1",
    fee_model: { maker_bps: "2", taker_bps: "5" },
    slippage_model: { kind: "fixed_bps", market_bps: "1" },
    max_leverage: "3",
    pause_on_controller_loss: true,
  };
}

export function flatPosition(markPrice = "100") {
  return {
    quantity: "0",
    entry_price: null,
    mark_price: markPrice,
    notional: "0",
    realized_pnl: "0",
    unrealized_pnl: "0",
  };
}

export function replayAccount() {
  return {
    cash_balance: "10000",
    equity: "10000",
    available_equity: "10000",
    margin_used: "0",
    reserved_margin: "0",
    realized_pnl: "0",
    unrealized_pnl: "0",
    fees_paid: "0",
    quote_asset: "USDT",
  };
}

export function replayFill(eventTimeMs: number, fillId = "fill-0001") {
  return {
    fill_id: fillId,
    order_id: "order-0001",
    side: "BUY",
    quantity: "1",
    price: "100",
    notional: "100",
    fee: "0.05",
    fee_asset: "USDT",
    liquidity: "TAKER",
    reason: "MARKET_NEXT_OPEN",
    source_sequence: 1,
    event_time_ms: eventTimeMs,
    synthetic: false,
    historical_execution: false,
    model_version: "paper-linear.v1",
  };
}

export function replayProjection({
  barUpdate = null,
  fills = [],
}: {
  barUpdate?: unknown;
  fills?: unknown[];
} = {}) {
  return {
    bar_update: barUpdate,
    orders: [],
    fills,
    warnings: [],
    position: flatPosition(),
    account: replayAccount(),
  };
}

export function replaySnapshot({
  sessionId = "session-0001",
  sequence = 0,
  sourceSequence = 0,
  dataEpoch = replayDigest("c"),
  virtualTimeMs = BASE_TIME_MS + 59_999,
}: {
  sessionId?: string;
  sequence?: number;
  sourceSequence?: number;
  dataEpoch?: string;
  virtualTimeMs?: number;
} = {}) {
  const bar = replayBar();
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: sessionId,
    state: "PAUSED",
    revision: 0,
    sequence,
    cursor: {
      virtual_time_ms: virtualTimeMs,
      source_sequence: sourceSequence,
      last_base_bar_open_ms: BASE_TIME_MS,
      last_trade_time_ms: null,
      last_agg_trade_id: null,
      at_end: false,
    },
    state_hash: replayDigest("b"),
    data_epoch: dataEpoch,
    controller_client_id: null,
    speed: 1,
    checkpoint_count: 1,
    status_reason: "created",
    config: replayConfig(),
    components: {
      schema_version: "replay-broker-state.v1",
      model_version: "paper-linear.v1",
      config_hash: replayDigest("d"),
      bar_builder: {
        schema_version: "replay-bar-builder-state.v1",
        base_interval: "1m",
        display_interval: "1m",
        base_interval_ms: 60_000,
        display_interval_ms: 60_000,
        replay_start_ms: BASE_TIME_MS + 60_000,
        max_closed_bars: 20_000,
        warmup_count: 1,
        warmup_fingerprint: replayDigest("e"),
        gap_policy: "reject",
        synthetic_policy: "reject",
        replay_events_applied: sourceSequence,
        last_base_open_ms: BASE_TIME_MS,
        active_bar: null,
        closed_bars: [bar],
        closed_count: 1,
        closed_prefix_count: 0,
        closed_prefix_hash: replayDigest("f"),
        closed_chain_hash: replayDigest("1"),
        state_hash: replayDigest("2"),
      },
      orders: [],
      client_order_ids: [],
      fills: [],
      closed_trades: [],
      warnings: [],
      ledger: { schema_version: "replay-ledger.v1", entries: [] },
      position: flatPosition(),
      account: replayAccount(),
      next_order: 1,
      next_fill: 1,
      next_trade: 1,
      next_warning: 1,
      has_trading_activity: false,
      ended: false,
      equity_peak: "10000",
      max_drawdown: "0",
      state_hash: replayDigest("3"),
    },
    journal: [],
    revealed: false,
    degraded_reason: null,
  };
}

export function replaySessionResponse(options: Parameters<typeof replaySnapshot>[0] = {}) {
  const snapshot = replaySnapshot(options);
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: snapshot.session_id,
    snapshot,
  };
}

export function replaySnapshotEvent(options: Parameters<typeof replaySnapshot>[0] = {}) {
  const snapshot = replaySnapshot(options);
  return {
    type: "replay.snapshot",
    protocol: REPLAY_PROTOCOL,
    session_id: snapshot.session_id,
    sequence: snapshot.sequence,
    revision: snapshot.revision,
    virtual_time_ms: snapshot.cursor.virtual_time_ms,
    state_hash: snapshot.state_hash,
    data_epoch: snapshot.data_epoch,
    data: { reset: true, snapshot },
  };
}

export function replayDeltaEvent({
  sessionId = "session-0001",
  sequence = 1,
  sourceSequence = 1,
  openTimeMs = BASE_TIME_MS + 60_000,
  dataEpoch = replayDigest("c"),
  close = "101",
  fills = [],
}: {
  sessionId?: string;
  sequence?: number;
  sourceSequence?: number;
  openTimeMs?: number;
  dataEpoch?: string;
  close?: string;
  fills?: unknown[];
} = {}) {
  const bar = replayBar(openTimeMs, close);
  const projection = replayProjection({
    barUpdate: {
      action: "append",
      bar,
      source_sequence: sourceSequence,
      base_open_time_ms: openTimeMs,
      gap_policy: "reject",
      synthetic_policy: "reject",
    },
    fills,
  });
  return {
    type: "replay.delta",
    protocol: REPLAY_PROTOCOL,
    session_id: sessionId,
    sequence,
    revision: 0,
    virtual_time_ms: openTimeMs + 59_999,
    state_hash: replayDigest("4"),
    data_epoch: dataEpoch,
    data: {
      source_sequence: sourceSequence,
      source_event: replaySourceBar(openTimeMs, close),
      projection,
    },
  };
}

export function replayStatusEvent({
  sequence = 1,
  state = "PAUSED",
}: { sequence?: number; state?: string } = {}) {
  return {
    type: "replay.status",
    protocol: REPLAY_PROTOCOL,
    session_id: "session-0001",
    sequence,
    revision: 1,
    virtual_time_ms: BASE_TIME_MS + 59_999,
    state_hash: replayDigest("5"),
    data_epoch: replayDigest("c"),
    data: {
      state,
      reason: "paused",
      speed: 1,
      controller_client_id: null,
    },
  };
}

export function enabledCapabilities() {
  return {
    protocol: REPLAY_PROTOCOL,
    enabled: true,
    available: true,
    sources: {
      bar: { enabled: true, fidelity: "EXACT_BAR_COVERAGE" },
      agg_trade: { enabled: false, reason: "ARCHIVE_DISABLED" },
    },
    execution_models: ["paper_linear_v1"],
    limits: {
      max_active_sessions: 8,
      max_warmup_bars: 5_000,
      max_bar_dataset_rows: 100_000,
      max_horizon_days: 30,
      event_buffer_size: 10_000,
      subscriber_queue: 1_000,
    },
    persistence: {
      schema_version: 1,
      degraded: false,
      degraded_reason: null,
    },
  };
}

export function disabledCapabilities() {
  return {
    protocol: REPLAY_PROTOCOL,
    enabled: false,
    available: false,
    reason: "REPLAY_DISABLED",
    sources: {
      bar: { enabled: false, reason: "REPLAY_DISABLED" },
      agg_trade: { enabled: false, reason: "REPLAY_DISABLED" },
    },
    execution_models: [],
    limits: enabledCapabilities().limits,
    persistence: {
      opened: false,
      schema_version: null,
      degraded: false,
      degraded_reason: null,
    },
  };
}
