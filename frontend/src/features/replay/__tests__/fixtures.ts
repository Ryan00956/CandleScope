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

export function replaySourceTrade(
  tradeTimeMs = BASE_TIME_MS + 60_500,
  aggTradeId = 100,
  price = "101",
) {
  return {
    exchange: "binance",
    market_type: "usd_m_futures",
    symbol: "BTCUSDT",
    agg_trade_id: aggTradeId,
    first_trade_id: aggTradeId * 2,
    last_trade_id: aggTradeId * 2,
    price,
    quantity: "0.5",
    quote_quantity: String(Number(price) * 0.5),
    trade_time_ms: tradeTimeMs,
    is_buyer_maker: false,
    source: "binance_public",
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

export function replayReport() {
  return {
    schema_version: "replay-broker-report.v1",
    config_hash: replayDigest("d"),
    model_version: "BAR_CONSERVATIVE_V1",
    initial_equity: "10000",
    final_equity: "10000",
    realized_pnl: "0",
    fees_paid: "0",
    max_drawdown: "0",
    trade_count: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate: "0",
    average_win: "0",
    average_loss: "0",
    profit_factor: null,
    ambiguous_bar_count: 0,
    order_count: 0,
    fill_count: 0,
    ledger_entry_count: 1,
    ledger_tail_hash: replayDigest("6"),
    state_hash: replayDigest("3"),
    ended: true,
    orders: [],
    fills: [],
    closed_trades: [],
    warnings: [],
    report_hash: replayDigest("7"),
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
  controllerClientId = null,
  state = "PAUSED",
  revision = 0,
  revealed = false,
}: {
  sessionId?: string;
  sequence?: number;
  sourceSequence?: number;
  dataEpoch?: string;
  virtualTimeMs?: number;
  controllerClientId?: string | null;
  state?: string;
  revision?: number;
  revealed?: boolean;
} = {}) {
  const bar = replayBar();
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: sessionId,
    state,
    revision,
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
    controller_client_id: controllerClientId,
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
    revealed,
    degraded_reason: null,
  };
}

export function replaySessionResponse(options: Parameters<typeof replaySnapshot>[0] = {}) {
  const snapshot = replaySnapshot(options);
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: snapshot.session_id,
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    snapshot,
  };
}

export function replayTradeSessionResponse() {
  const response = replaySessionResponse({
    sourceSequence: 1,
    virtualTimeMs: BASE_TIME_MS + 60_500,
  });
  const snapshot = response.snapshot;
  const nestedBuilder = snapshot.components.bar_builder;
  const forming = {
    open_time_ms: BASE_TIME_MS + 60_000,
    close_time_ms: BASE_TIME_MS + 119_999,
    open: "101",
    high: "101",
    low: "101",
    close: "101",
    volume: "0.5",
    quote_volume: "50.5",
    trades: 1,
    taker_buy_base: "0.5",
    taker_buy_quote: "50.5",
  };
  const preview = {
    ...replayBar(BASE_TIME_MS + 60_000, "101"),
    open: "101",
    high: "101",
    low: "101",
    volume: "0.5",
    quote_volume: "50.5",
    trades: 1,
    taker_buy_base: "0.5",
    taker_buy_quote: "50.5",
    is_closed: false,
  };
  return {
    ...response,
    data_fidelity: "VERIFIED_AGG_TRADE_APPROXIMATE_BARS",
    execution_fidelity: "AGG_TRADE_TAPE",
    snapshot: {
      ...snapshot,
      cursor: {
        ...snapshot.cursor,
        last_base_bar_open_ms: null,
        last_trade_time_ms: BASE_TIME_MS + 60_500,
        last_agg_trade_id: 100,
      },
      config: {
        ...snapshot.config,
        source_kind: "agg_trade",
        market_type: "usd_m_futures",
      },
      components: {
        ...snapshot.components,
        model_version: "AGG_TRADE_TAPE_V1",
        bar_builder: {
          schema_version: "replay-trade-bar-builder-state.v1",
          base_interval: "1m",
          display_interval: "1m",
          replay_start_ms: BASE_TIME_MS + 60_000,
          replay_end_time_ms: BASE_TIME_MS + 3_659_999,
          max_closed_bars: 20_000,
          synthetic_policy: "previous_close_zero_volume",
          bar_builder: {
            ...nestedBuilder,
            synthetic_policy: "previous_close_zero_volume",
            replay_events_applied: 0,
          },
          public_projection: {
            action: "replace",
            bars: [replayBar(), preview],
            closed_count: 1,
            closed_prefix_count: 0,
            replay_events_applied: 1,
            gap_policy: "reject",
            synthetic_policy: "previous_close_zero_volume",
            source_kind: "AGG_TRADE",
          },
          forming,
          next_base_open_ms: BASE_TIME_MS + 60_000,
          replay_events_applied: 1,
          last_trade_time_ms: BASE_TIME_MS + 60_500,
          last_agg_trade_id: 100,
          identity: ["binance", "usd_m_futures", "BTCUSDT"],
          previous_close: "100",
          last_projected_open_ms: BASE_TIME_MS + 60_000,
          finalized: false,
          state_hash: replayDigest("8"),
        },
      },
    },
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

function packFixtureFinalBars(bars: ReturnType<typeof replayBar>[]): string {
  let previousOpen: number | null = null;
  let previousClose = 0;
  return bars.map((bar) => {
    const fields = [
      previousOpen === null ? "" : (bar.open_time_ms - previousOpen).toString(36),
      "",
      (Number(bar.open) - previousClose).toString(36),
      (Number(bar.high) - previousClose).toString(36),
      (Number(bar.low) - previousClose).toString(36),
      (Number(bar.close) - previousClose).toString(36),
      Number(bar.volume).toString(36),
      Number(bar.quote_volume).toString(36),
      Number(bar.trades).toString(36),
      Number(bar.taker_buy_base).toString(36),
      Number(bar.taker_buy_quote).toString(36),
      "0",
      "0",
      "1",
      "1",
      "1",
    ];
    previousOpen = bar.open_time_ms;
    previousClose = Number(bar.close);
    return fields.join(",");
  }).join(";");
}

export function replayFinalStateEvent({
  sequence = 1,
  sourceFrom = 1,
  sourceTo = 2,
  state = "PAUSED",
}: {
  sequence?: number;
  sourceFrom?: number;
  sourceTo?: number;
  state?: "PAUSED" | "ENDED";
} = {}) {
  const bars = [
    replayBar(BASE_TIME_MS, "100"),
    replayBar(BASE_TIME_MS + 60_000, "101"),
    replayBar(BASE_TIME_MS + 120_000, "102"),
  ];
  const virtualTimeMs = bars.at(-1)!.close_time_ms;
  return {
    type: "replay.final_state",
    protocol: REPLAY_PROTOCOL,
    session_id: "session-0001",
    sequence,
    revision: 1,
    virtual_time_ms: virtualTimeMs,
    state_hash: replayDigest("9"),
    data_epoch: replayDigest("c"),
    data: {
      source_sequence_from: sourceFrom,
      source_sequence_to: sourceTo,
      cursor: {
        virtual_time_ms: virtualTimeMs,
        source_sequence: sourceTo,
        last_base_bar_open_ms: bars.at(-1)!.open_time_ms,
        last_trade_time_ms: null,
        last_agg_trade_id: null,
        at_end: state === "ENDED",
      },
      state,
      status_reason: "fast_forward_final_state_complete",
      speed: 1,
      controller_client_id: null,
      projection: {
        schema_version: "replay-final-state-projection.v1",
        series: {
          schema_version: "replay-series-tail-patch.v1",
          encoding: "delta-base36-decimal-columns.v1",
          replace_from_open_ms: bars[0]!.open_time_ms,
          retained_start_open_ms: bars[0]!.open_time_ms,
          retained_end_open_ms: bars.at(-1)!.open_time_ms,
          retained_count: bars.length,
          bar_count: bars.length,
          first_open_ms: bars[0]!.open_time_ms,
          default_close_span_ms: 60_000,
          decimal_scales: {
            price: 0,
            volume: 0,
            quote_volume: 0,
            taker_buy_base: 0,
            taker_buy_quote: 0,
          },
          packed_bars: packFixtureFinalBars(bars),
        },
        orders: [],
        fills: [],
        closed_trades: [],
        warnings: [],
        position: flatPosition("102"),
        account: replayAccount(),
      },
    },
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

export function replayTradeDeltaEvent({
  sequence = 1,
  sourceSequence = sequence + 1,
  tradeTimeMs = BASE_TIME_MS + 60_500 + sequence,
}: {
  sequence?: number;
  sourceSequence?: number;
  tradeTimeMs?: number;
} = {}) {
  const price = `101.${String(sequence).padStart(3, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
  const preview = {
    ...replayBar(BASE_TIME_MS + 60_000, price),
    open: "101",
    high: price,
    low: "101",
    volume: "0.5",
    quote_volume: "50.5",
    trades: 1,
    taker_buy_base: "0.5",
    taker_buy_quote: "50.5",
    is_closed: false,
  };
  return {
    type: "replay.delta",
    protocol: REPLAY_PROTOCOL,
    session_id: "session-0001",
    sequence,
    revision: 0,
    virtual_time_ms: tradeTimeMs,
    state_hash: replayDigest("4"),
    data_epoch: replayDigest("c"),
    data: {
      source_sequence: sourceSequence,
      source_event: replaySourceTrade(tradeTimeMs, 99 + sourceSequence, price),
      projection: replayProjection({
        barUpdate: {
          action: "tick",
          bar: preview,
          source_sequence: sourceSequence,
          base_open_time_ms: BASE_TIME_MS + 60_000,
          gap_policy: "reject",
          synthetic_policy: "previous_close_zero_volume",
        },
      }),
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

export function replayEndedEvent({ sequence = 1 }: { sequence?: number } = {}) {
  return {
    type: "replay.ended",
    protocol: REPLAY_PROTOCOL,
    session_id: "session-0001",
    sequence,
    revision: 1,
    virtual_time_ms: BASE_TIME_MS + 59_999,
    state_hash: replayDigest("5"),
    data_epoch: replayDigest("c"),
    data: {
      reason: "command",
      projection: replayProjection(),
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

export function enabledAggTradeCapabilities() {
  const capabilities = enabledCapabilities();
  return {
    ...capabilities,
    sources: {
      ...capabilities.sources,
      agg_trade: {
        enabled: true,
        fidelity: "VERIFIED_AGG_TRADE_APPROXIMATE_BARS",
        execution_fidelity: "AGG_TRADE_TAPE",
        requires_exact_dataset: true,
        bar_parity_required: false,
        reader: "paged",
      },
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
