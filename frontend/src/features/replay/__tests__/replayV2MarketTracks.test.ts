import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReplayV2ApiClient } from "../replayV2Api.js";
import { parseReplayMarketTracksResponse } from "../replayV2Types.js";
import {
  applyReplayTrainingRunStreamMessage,
  buildReplayTrainingRunStreamUrl,
  ReplayTrainingRunStream,
  type ReplayTrainingRunStreamSocket,
} from "../replayTrainingRunStream.js";


function viewerState() {
  return {
    run_id: "run-1",
    selected_track_id: "track-2",
    display_interval: "1m",
    chart_type: "candles",
    visible_range: null,
    pane_layout: {},
    rail_layout: {},
    semantic_view_revision: 1,
  };
}

function bookOff() {
  return {
    mode: "OFF",
    capability_state: "UNSUPPORTED_NO_HISTORY",
    status: "OFF",
    execution_fidelity: "NO_BOOK_TOUCH_OR_TAPE_APPROX",
    queue_exact: false,
    as_of_virtual_time_ms: null,
    last_update_id: null,
    bids: [],
    asks: [],
    book_hash: null,
    message: "历史盘口模式未启用",
  };
}

function marketTracksResponse() {
  return {
    protocol: "replay.v3",
    run_id: "run-1",
    ordering_version: "replay.global-order.v1",
    launch_context: {
      schema_version: "replay.launch-context.v1",
      source: "LIVE_PAGE",
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      display_interval: "1m",
      watchlist_snapshot: {
        schema_version: "replay.watchlist-snapshot.v1",
        groups: [
          {
            id: "default",
            name: "Watchlist",
            color: "#3b82f6",
            items: [
              { exchange: "binance", market_type: "spot", symbol: "ETHUSDT" },
            ],
          },
        ],
      },
    },
    global_clock: {
      contract: "replay.playback.v1",
      mode: "ORDERED",
      state: "PAUSED",
      basis: "BASE_BAR",
      rate: 1,
      speed: 1,
      display_interval: null,
      viewer_revision: null,
      profile_revision: 0,
      reason: null,
      generation: 0,
      tick: 0,
      supported_bases: ["DISPLAY_BAR", "BASE_BAR", "SOURCE_EVENT", "VIRTUAL_TIME"],
      playback_bases: ["DISPLAY_BAR", "BASE_BAR", "SOURCE_EVENT"],
      max_count: 100_000,
      virtual_time_quantum_ms: 60_000,
    },
    viewer_state: viewerState(),
    tracks: [
      {
        run_id: "run-1",
        track_id: "track-1",
        stable_ordinal: 1,
        adapter_session_id: "adapter-1",
        exchange: "binance",
        market_type: "spot",
        symbol: "BTCUSDT",
        settlement_asset: "USDT",
        state: "READY",
        source_kind: "BAR",
        subscription_tier: "WARM",
        cursor: { virtual_time_ms: 1_710_000_239_999, source_sequence: 4, revision: 5 },
        forced_full_reasons: [],
        capabilities: {
          OHLCV: "AVAILABLE_EXACT",
          HISTORICAL_MARK_INDEX: "AVAILABLE_EXACT",
          HISTORICAL_INSTRUMENT_RULE: "AVAILABLE_EXACT",
          SIMULATED_LIQUIDATION: "AVAILABLE_EXACT_INPUTS_MODELLED_ACCOUNT",
        },
        public_price: "104.5",
        position: { quantity: "0" },
        open_order_count: 0,
        degraded_reason: null,
        account: { equity: "10000" },
        historical_book: bookOff(),
      },
      {
        run_id: "run-1",
        track_id: "track-2",
        stable_ordinal: 2,
        adapter_session_id: "adapter-2",
        exchange: "binance",
        market_type: "spot",
        symbol: "ETHUSDT",
        settlement_asset: "USDT",
        state: "READY",
        source_kind: "BAR",
        subscription_tier: "FULL",
        cursor: { virtual_time_ms: 1_710_000_239_999, source_sequence: 4, revision: 6 },
        forced_full_reasons: ["VIEWED"],
        capabilities: { OHLCV: "AVAILABLE_EXACT" },
        public_price: "204.5",
        position: { quantity: "0" },
        open_order_count: 0,
        degraded_reason: null,
        account: { equity: "10000" },
        historical_book: bookOff(),
      },
    ],
    portfolio: {
      schema_version: "replay.training.portfolio.v1",
      fidelity: "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER",
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
  };
}

test("Phase 5 market-track parser keeps tier, public price, and force reasons strict", () => {
  const parsed = parseReplayMarketTracksResponse(marketTracksResponse());
  assert.ok(parsed.global_clock);
  assert.equal(parsed.tracks[1]?.symbol, "ETHUSDT");
  assert.equal(parsed.tracks[1]?.subscription_tier, "FULL");
  assert.deepEqual(parsed.tracks[1]?.forced_full_reasons, ["VIEWED"]);
  assert.equal(parsed.portfolio.equity, "10000");
  assert.throws(() => parseReplayMarketTracksResponse({
    ...marketTracksResponse(),
    tracks: [{ ...marketTracksResponse().tracks[0], live_price: "999" }],
  }), /unknown/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...marketTracksResponse(),
    tracks: [{ ...marketTracksResponse().tracks[0], cursor: null, subscription_tier: "FULL" }],
  }), /FULL.*cursor|cursor.*FULL/);
});

test("HEDGE track parser accepts pinned, materialized, and explicitly disabled capabilities", () => {
  const payload = marketTracksResponse();
  const parsed = parseReplayMarketTracksResponse({
    ...payload,
    tracks: payload.tracks.map((track, index) => index === 0 ? {
      ...track,
      capabilities: {
        HISTORICAL_MARK_INDEX: "AVAILABLE_PINNED",
        HISTORICAL_INSTRUMENT_RULE: "AVAILABLE_PINNED",
        HISTORICAL_FEE_POLICY: "AVAILABLE_PINNED_ACCOUNT_WIDE",
        HISTORICAL_FUNDING: "OFF_NOT_REQUESTED",
        HISTORICAL_L2: "OFF_NOT_REQUESTED",
        SIMULATED_INSURANCE_FUND: "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
        SIMULATED_ADL_COHORT: "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
      },
    } : track),
  });
  assert.equal(
    parsed.tracks[0]?.capabilities.HISTORICAL_L2,
    "OFF_NOT_REQUESTED",
  );
  assert.equal(
    parsed.tracks[0]?.capabilities.HISTORICAL_FUNDING,
    "OFF_NOT_REQUESTED",
  );
  assert.equal(
    parsed.tracks[0]?.capabilities.SIMULATED_ADL_COHORT,
    "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
  );
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    tracks: [{
      ...payload.tracks[0],
      capabilities: { PRIVATE_EXCHANGE_QUEUE: "AVAILABLE_PINNED" },
    }],
  }), /capability kind is unsupported/);
});

test("Phase 13 global clock parser freezes basis, rate, limits, and display binding", () => {
  const parsed = parseReplayMarketTracksResponse(marketTracksResponse());
  assert.ok(parsed.global_clock);
  const globalClock = parsed.global_clock;
  assert.equal(globalClock.contract, "replay.playback.v1");
  assert.equal(globalClock.basis, "BASE_BAR");
  assert.equal(globalClock.rate, 1);
  assert.deepEqual(globalClock.playback_bases, [
    "DISPLAY_BAR",
    "BASE_BAR",
    "SOURCE_EVENT",
  ]);

  const payload = marketTracksResponse();
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    global_clock: { ...payload.global_clock, speed: 5 },
  }), /rate\/speed/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    global_clock: {
      ...payload.global_clock,
      basis: "DISPLAY_BAR",
      display_interval: null,
      viewer_revision: null,
    },
  }), /display binding/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    global_clock: {
      ...payload.global_clock,
      playback_bases: ["DISPLAY_BAR", "BASE_BAR", "SOURCE_EVENT", "VIRTUAL_TIME"],
      supported_bases: ["DISPLAY_BAR", "BASE_BAR", "SOURCE_EVENT"],
    },
  }), /capabilities/);
});

test("Phase 6 contract portfolio parser keeps account, ledger, and liquidation domains strict", () => {
  const payload = marketTracksResponse();
  const contractPortfolio = {
      schema_version: "replay.training.portfolio.v2",
      account_model: "TOUCH_OR_TAPE_V2",
      execution_model: "TOUCH_OR_TAPE_V2",
      execution_fidelity: "NO_BOOK_TOUCH_OR_TAPE_APPROX",
      settlement_account_shared: false,
      margin_mode: "ISOLATED",
      funding_mode: "SANDBOX_FIXED",
      status: "ACTIVE",
      initial_equity: "10000",
      equity: "9999.5",
      cash_balance: "9999",
      available_equity: "8999.5",
      reserved_margin: "0",
      margin_used: "100",
      maintenance_margin: "5",
      realized_pnl: "0",
      unrealized_pnl: "0.5",
      fees_paid: "1",
      funding_cashflow: "-0.1",
      liquidation_fees_paid: "0",
      risk_ratio: "1999.9",
      positions: [{
        track_id: "track-2",
        symbol: "ETHUSDT",
        position: { quantity: "1", mark_price: "204.5" },
        leverage: "3",
        initial_margin: "68.16666667",
        account_notional: "204.5",
        maintenance_margin: "5",
        isolated_margin: "1000",
        isolated_allocation_key: "track-2",
        risk_tier: 1,
        margin_equity: "1000.5",
        risk_ratio: "200.1",
        rule_revision: 1,
        rule_hash: `sha256:${"a".repeat(64)}`,
        mark_fidelity: "REVEALED_BAR_CLOSE_PROXY",
        maintenance_margin_proof: {
          schema_version: "replay.maintenance-margin-proof.v1",
          rule_revision: 1,
          rule_hash: `sha256:${"a".repeat(64)}`,
          rule_fidelity: "AVAILABLE_APPROX_SIMULATION_RULES",
          risk_tier: 1,
          last_tier_notional_cap: "1000000",
          position_notional: "204.5",
          position_tier_extrapolated: false,
          liquidation_price_notional: "197.2",
          liquidation_tier_extrapolated: false,
          fidelity: "VERSIONED_MAINTENANCE_TIER_APPLIED",
          explanation: null,
          proof_hash: `sha256:${"f".repeat(64)}`,
        },
      }],
      orders: [{ order_id: "ord-1", track_id: "track-2", status: "OPEN" }],
      fills: [],
      history: {
        orders_total: 1,
        active_orders: 1,
        historical_orders: 0,
        fills_total: 1,
        ledger_entries_total: 3,
        page_limit_max: 200,
      },
      active_fee_policy: { revision: 1, maker_fee_bps: "2", taker_fee_bps: "5" },
      instrument_rules: [{ track_id: "track-2", revision: 1 }],
      isolated_allocations: { "track-2": "1000" },
      next_funding_time_ms: 1_710_000_300_000,
      liquidations: [{
        run_id: "run-1",
        case_id: "liq-track-2-0000000001",
        case_sequence: 1,
        state: "COMPLETED",
        trigger_snapshot_id: "risk-1",
        final_snapshot_id: "risk-2",
        trigger_virtual_time_ms: 1_710_000_000_000,
        trigger_source_sequence: 1,
        reason: "MAINTENANCE_MARGIN_BREACH",
        fidelity: "REVEALED_BAR_CLOSE_PROXY",
        component_hash: `sha256:${"e".repeat(64)}`,
        legs: [],
        book_snapshots: [],
        steps: [],
      }],
      liquidation_recoveries: [],
      hedge_state: {
        schema_version: "replay.hedge-relational-state.v1",
        state_hash: `sha256:${"d".repeat(64)}`,
      },
      hedge_inputs: null,
      account_history: {
        mode: "APPROX_PROXY",
        status: "ACTIVE",
        fidelity: "REVEALED_PRICE_PROXY_MODELLED_ACCOUNT",
        archive_proof_hash: null,
        bindings: [],
        auditor: {
          status: "NOT_RUN",
          proof_hash: null,
          differences: [],
        },
      },
      liquidation_channels: {
        simulated_account: {
          label: "模拟账户强平",
          source: "MODELLED_ACCOUNT",
          fidelity: "AVAILABLE_APPROX_SIMULATED_ACCOUNT",
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
        tail_hash: `sha256:${"b".repeat(64)}`,
        cash_total: "9999",
        reconciliation_delta: "0",
        entries: [],
      },
      fidelity: {
        mark: "REVEALED_PRICE_PROXY_NOT_HISTORICAL_MARK",
        liquidation: "AVAILABLE_APPROX_SIMULATED_ACCOUNT",
      },
  };
  const parsed = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: contractPortfolio,
  });
  assert.equal(parsed.portfolio.schema_version, "replay.training.portfolio.v2");
  if (parsed.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("contract portfolio did not survive parsing");
  }
  assert.equal(parsed.portfolio.margin_mode, "ISOLATED");
  assert.equal(parsed.portfolio.ledger.reconciliation_delta, "0");
  assert.equal(parsed.portfolio.liquidations.length, 1);
  assert.equal(
    parsed.portfolio.positions[0]?.maintenance_margin_proof?.fidelity,
    "VERSIONED_MAINTENANCE_TIER_APPLIED",
  );
  const liveParsed = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      hedge_state: {
        schema_version: "replay.hedge-relational-live.v1",
        detail: "LIVE_HEADS",
        audit_history: "AUTHORITATIVE_REST_FULL",
        position_legs: [],
        leg_accounting: [],
        margin_buckets: [],
        insurance_funds: [],
        history_heads: {
          latest_risk_snapshot: null,
        },
        liquidation_case_hashes: [],
        state_hash: `sha256:${"c".repeat(64)}`,
      },
    },
  });
  if (liveParsed.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("live contract portfolio did not survive parsing");
  }
  assert.equal(
    liveParsed.portfolio.hedge_state.schema_version,
    "replay.hedge-relational-live.v1",
  );
  assert.equal(liveParsed.portfolio.hedge_state.detail, "LIVE_HEADS");
  const extrapolated = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      positions: [{
        ...contractPortfolio.positions[0],
        maintenance_margin_proof: {
          ...contractPortfolio.positions[0]?.maintenance_margin_proof,
          position_notional: "1000000.1",
          position_tier_extrapolated: true,
          fidelity: "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED",
          explanation: "POSITION_NOTIONAL_ABOVE_LAST_VERSIONED_TIER_CAP",
        },
      }],
    },
  });
  if (extrapolated.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("extrapolated maintenance proof did not survive parsing");
  }
  assert.equal(
    extrapolated.portfolio.positions[0]?.maintenance_margin_proof
      ?.position_tier_extrapolated,
    true,
  );
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      positions: [{
        ...contractPortfolio.positions[0],
        maintenance_margin_proof: {
          ...contractPortfolio.positions[0]?.maintenance_margin_proof,
          fidelity: "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED",
        },
      }],
    },
  }), /fidelity is inconsistent/);
  const failedClosed = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: { ...contractPortfolio, status: "FAILED_CLOSED" },
  });
  if (failedClosed.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("fail-closed contract portfolio did not survive parsing");
  }
  assert.equal(failedClosed.portfolio.status, "FAILED_CLOSED");
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: { ...contractPortfolio, status: "UNKNOWN" },
  }), /unsupported/);
  const hedgeProof = `sha256:${"9".repeat(64)}`;
  const parsedHedge = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        schema_version: "replay.hedge-input-view.v2",
        status: "ACTIVE",
        degraded_reason: null,
        input_proof_hash: hedgeProof,
        time_domain: "ACTUAL",
        bound_range_start_ms: 1_710_000_000_000,
        bound_range_end_ms: 1_710_000_600_000,
        public: {
          archive_id: "hedge-public-1",
          generation: 1,
          dataset_epoch: `sha256:${"1".repeat(64)}`,
          checksum_sha256: `sha256:${"2".repeat(64)}`,
          event_chain_tail: `sha256:${"3".repeat(64)}`,
          proof_hash: `sha256:${"4".repeat(64)}`,
          health: "READY",
        },
        simulation: {
          manifest_id: "hedge-simulation-1",
          generation: 1,
          dataset_epoch: `sha256:${"5".repeat(64)}`,
          checksum_sha256: `sha256:${"6".repeat(64)}`,
          contract_hash: `sha256:${"7".repeat(64)}`,
          model_version: "HEDGE_MODEL_V1",
          proof_hash: `sha256:${"8".repeat(64)}`,
          health: "READY",
        },
        projections: ["PUBLIC", "SIMULATION"].map((sourceKind, index) => ({
          schema_version: "replay.hedge-input-public-projection.v1",
          source_kind: sourceKind,
          last_event_sequence: index + 1,
          as_of_time_ms: 1_710_000_000_000,
          time_domain: "ACTUAL",
          state_hash: `sha256:${String(index + 2).repeat(64)}`,
          input_chain_hash: `sha256:${String(index + 1).repeat(64)}`,
          source_component_hash: `sha256:${String(index + 3).repeat(64)}`,
        })),
        track_public: [{
          track_id: "track-1",
          archive_id: "hedge-public-1",
          generation: 1,
          dataset_epoch: `sha256:${"1".repeat(64)}`,
          checksum_sha256: `sha256:${"2".repeat(64)}`,
          event_chain_tail: `sha256:${"3".repeat(64)}`,
          input_proof_hash: `sha256:${"b".repeat(64)}`,
          status: "ACTIVE",
          degraded_reason: null,
          projection: {
            schema_version: "replay.hedge-track-public-projection.v2",
            run_id: "run-1",
            track_id: "track-1",
            last_event_sequence: 1,
            as_of_time_ms: 1_710_000_000_000,
            time_domain: "ACTUAL",
            state_hash: `sha256:${"e".repeat(64)}`,
            input_chain_hash: `sha256:${"c".repeat(64)}`,
            source_component_hash: `sha256:${"d".repeat(64)}`,
          },
        }],
        auditor: {
          status: "PASS",
          proof_hash: `sha256:${"a".repeat(64)}`,
          difference_count: 0,
          difference_hashes: [],
        },
      },
    },
  });
  assert.equal(parsedHedge.portfolio.position_mode, "HEDGE");
  if (parsedHedge.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("HEDGE contract portfolio did not survive parsing");
  }
  const parsedHedgeInputs = parsedHedge.portfolio.hedge_inputs;
  assert.ok(parsedHedgeInputs);
  assert.equal(parsedHedgeInputs.input_proof_hash, hedgeProof);
  assert.equal(parsedHedgeInputs.track_public[0]?.track_id, "track-1");
  const publicOrigin = 946_684_800_000;
  const publicHedge = {
    ...parsedHedgeInputs,
    time_domain: "PUBLIC",
    bound_range_start_ms: publicOrigin,
    bound_range_end_ms: publicOrigin + 600_000,
    projections: parsedHedgeInputs.projections.map((projection) => ({
      ...projection,
      time_domain: "PUBLIC",
      as_of_time_ms: publicOrigin,
    })),
    track_public: parsedHedgeInputs.track_public.map((binding) => ({
      ...binding,
      projection: {
        ...(binding.projection as Readonly<Record<string, unknown>>),
        time_domain: "PUBLIC",
        as_of_time_ms: publicOrigin,
      },
    })),
  };
  const parsedPublicHedge = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: publicHedge,
    },
  });
  if (parsedPublicHedge.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("public-domain HEDGE portfolio did not survive parsing");
  }
  assert.equal(parsedPublicHedge.portfolio.hedge_inputs?.time_domain, "PUBLIC");
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        ...publicHedge,
        projections: publicHedge.projections.map((projection, index) => (
          index === 0
            ? { ...projection, as_of_actual_time_ms: 1_710_000_000_000 }
            : projection
        )),
      },
    },
  }), /unknown as_of_actual_time_ms/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        ...publicHedge,
        track_public: publicHedge.track_public.map((binding, index) => (
          index === 0
            ? {
                ...binding,
                projection: { ...binding.projection, state: { effective_time_ms: 1 } },
              }
            : binding
        )),
      },
    },
  }), /unknown state/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        ...publicHedge,
        projections: publicHedge.projections.map((projection, index) => (
          index === 0 ? { ...projection, time_domain: "ACTUAL" } : projection
        )),
      },
    },
  }), /time_domain is inconsistent/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        ...parsedHedgeInputs,
        input_proof_hash: "not-a-proof",
      },
    },
  }), /SHA-256/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
      ...contractPortfolio,
      position_mode: "HEDGE",
      hedge_inputs: {
        ...parsedHedgeInputs,
        track_public: [
          parsedHedgeInputs.track_public[0],
          parsedHedgeInputs.track_public[0],
        ],
      },
    },
  }), /unique and canonical/);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    portfolio: { ...payload.portfolio, account_model: "TOUCH_OR_TAPE_V2" },
  }), /unknown|unsupported/);
});

test("Phase 9 historical book parser accepts only exact visible or visibly cleared states", () => {
  const payload = marketTracksResponse();
  const ready = {
    mode: "BOOK_ASSISTED_REQUIRED",
    capability_state: "AVAILABLE_EXACT",
    status: "READY",
    execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
    queue_exact: false,
    as_of_virtual_time_ms: 1_710_000_239_999,
    last_update_id: 42,
    bids: [["104", "3"]],
    asks: [["105", "2"]],
    book_hash: `sha256:${"c".repeat(64)}`,
    message: "连续历史 L2 已验证；成交仍不声明真实排队位置",
  };
  const parsed = parseReplayMarketTracksResponse({
    ...payload,
    tracks: payload.tracks.map((track, index) => ({
      ...track,
      historical_book: index === 1 ? ready : bookOff(),
    })),
  });
  assert.equal(parsed.tracks[1]?.historical_book.status, "READY");
  assert.equal(parsed.tracks[1]?.historical_book.queue_exact, false);
  assert.throws(() => parseReplayMarketTracksResponse({
    ...payload,
    tracks: payload.tracks.map((track, index) => ({
      ...track,
      historical_book: index === 1
        ? { ...ready, status: "CLEARED", bids: [["104", "3"]], book_hash: null }
        : bookOff(),
    })),
  }), /visibly cleared|non-ready/);
});

test("Phase 5 API reads tracks by replay session without touching live subscription routes", async () => {
  const requests: string[] = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(marketTracksResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.tracksBySession("adapter-2");
  assert.equal(result.viewer_state.selected_track_id, "track-2");
  assert.deepEqual(requests, ["/api/v1/replay/runs/session/adapter-2/tracks"]);
});

test("market track planning sends identity only and accepts server-owned settlement", async () => {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify({
        schema_version: "replay.market-track-plan.v1",
        plan_id: "track-plan-1",
        run_id: "run-1",
        identity: {
          exchange: "binance",
          market_type: "spot",
          symbol: "ETHUSDT",
          base_asset: "ETH",
          settlement_asset: "USDT",
        },
        subscription_tier: "NONE",
        compatibility: {
          state: "READY",
          code: "MARKET_TRACK_PLAN_READY",
          message: "ready",
        },
        expires_at_ms: 1_800_000_000_000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.planMarketTrack("run-1", {
    exchange: "binance",
    marketType: "spot",
    symbol: "ETHUSDT",
  });
  assert.equal(result.identity.settlement_asset, "USDT");
  assert.deepEqual(requests, [{
    url: "/api/v1/replay/runs/run-1/tracks/plan",
    body: {
      exchange: "binance",
      market_type: "spot",
      symbol: "ETHUSDT",
      subscription_tier: "NONE",
    },
  }]);
});

test("replay watchlist searches the Run catalog and adds products through track commands", () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const watchlist = readFileSync(
    resolve(testDirectory, "../components/ReplayWatchlistPanel.tsx"),
    "utf8",
  );
  assert.match(watchlist, /viewer\.marketTracks/);
  assert.match(watchlist, /launch_context\?\.watchlist_snapshot\.groups/);
  assert.match(watchlist, /data-replay-watchlist-source="run-archive"/);
  assert.match(watchlist, /marketCatalog\(runId/);
  assert.match(watchlist, /start_compatibility\?\.state === "READY"/);
  assert.match(watchlist, /replay\.watchlist\.search/);
  assert.match(watchlist, /replay\.watchlist\.hint/);
  assert.match(watchlist, /selectTrack|addAndSelectTrack/);
  const runtime = readFileSync(
    resolve(testDirectory, "../useReplayViewerRuntime.ts"),
    "utf8",
  );
  assert.match(runtime, /planMarketTrack\(viewer\.run_id/);
  assert.match(runtime, /\{ plan_id: plan\.plan_id \}/);
  assert.doesNotMatch(runtime, /settlement_asset: identity\.settlementAsset/);
  assert.match(runtime, /onSelectedSessionChange\?\.\(result\.session_id\)/);
  assert.doesNotMatch(runtime, /location\.assign/);
  assert.match(runtime, /new ReplayTrainingRunStream/);
  assert.doesNotMatch(runtime, /setInterval\(.*pollMarketTracks/s);
  const app = readFileSync(resolve(testDirectory, "../ReplayApp.tsx"), "utf8");
  assert.match(app, /selectedSessionId \?\? run\.adapter_session_id/);
  assert.match(app, /onSelectedSessionChange=\{setSelectedSessionId\}/);
  assert.match(
    watchlist,
    /const pending = viewer\.viewerPending \|\| viewer\.controlPending !== null/,
  );
  assert.match(watchlist, /forced_full_reasons/);
  assert.doesNotMatch(
    watchlist,
    /updateSubscriptionTier|useWatchlistRuntime|livePrice|localStorage|candlescope-watchlists/,
  );
  const paper = readFileSync(
    resolve(testDirectory, "../components/ReplayRightRail.tsx"),
    "utf8",
  );
  assert.match(paper, /viewer\.actions\.submitTrade/);
  assert.match(paper, /readonly viewer: ReplayViewerRuntime/);
  assert.doesNotMatch(paper, /viewer === undefined|viewer !== undefined|runtime\.actions\.submitCommand/);
  assert.match(paper, /portfolioPositions|marketTracks\?\.portfolio/);
  assert.match(paper, /replay\.wb\.simLiq/);
  assert.match(paper, /replay\.wb\.mktLiq/);
  assert.match(paper, /simulated-account-liquidation/);
  assert.match(paper, /reconciliation_delta/);
  assert.match(paper, /replay\.wb\.modelNoQueue|replay\.dock\.bookOffHint|不含盘口排队/);
  assert.match(paper, /data-replay-rail-tab/);
  assert.doesNotMatch(paper, /BAR v1 不支持/);
  const integrity = readFileSync(
    resolve(testDirectory, "../components/ReplayIntegrityReviewPanel.tsx"),
    "utf8",
  );
  assert.match(integrity, /replay\.integrity\.kicker/);
  assert.match(integrity, /replay\.integrity\.rules/);
  assert.match(integrity, /replay\.integrity\.review/);
  assert.doesNotMatch(integrity, /REPLAY_POLICY_UNSUPPORTED/);
  const controls = readFileSync(
    resolve(testDirectory, "../components/ReplayControlBar.tsx"),
    "utf8",
  );
  assert.match(controls, /phase3Command\("acquire_controller", \{ takeover: false \}\)/);
  assert.match(controls, /readonly viewer: ReplayViewerRuntime/);
  assert.doesNotMatch(controls, /viewer === undefined|viewer !== undefined|runtime\.actions\.submitCommand/);
});

test("Run stream uses replay.v3 and publishes strict account projections", () => {
  assert.equal(
    buildReplayTrainingRunStreamUrl({
      runId: "run-1",
      baseUrl: "wss://example.test/",
    }),
    "wss://example.test/api/v1/stream/replay/runs/run-1?protocol=replay.v3&projection=delta.v1",
  );
  let socket: ReplayTrainingRunStreamSocket | null = null;
  let projectionCount = 0;
  const stream = new ReplayTrainingRunStream({
    runId: "run-1",
    baseUrl: "ws://example.test",
    socketFactory: () => {
      socket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: () => undefined,
      };
      return socket;
    },
    onProjection: (projection) => {
      assert.equal(projection.run_id, "run-1");
      projectionCount += 1;
    },
  });
  stream.start();
  assert.notEqual(socket, null);
  socket!.onmessage?.({
    data: JSON.stringify(marketTracksResponse()),
  } as MessageEvent<string>);
  assert.equal(projectionCount, 1);
  stream.stop();
});

test("Run stream delta applies only on a continuous authoritative sequence", () => {
  const snapshot = applyReplayTrainingRunStreamMessage({
    protocol: "replay.v3",
    schema_version: "replay.training.market-tracks-stream.v1",
    type: "SNAPSHOT",
    run_id: "run-1",
    sequence: 7,
    projection: marketTracksResponse(),
  }, null);
  const delta = applyReplayTrainingRunStreamMessage({
    protocol: "replay.v3",
    schema_version: "replay.training.market-tracks-stream.v1",
    type: "DELTA",
    run_id: "run-1",
    base_sequence: 7,
    sequence: 8,
    operations: [{
      op: "SET",
      path: ["global_clock", "tick"],
      value: 2,
    }],
  }, snapshot);
  assert.equal(delta.sequence, 8);
  assert.equal(delta.projection.global_clock?.tick, 2);

  assert.throws(() => applyReplayTrainingRunStreamMessage({
    protocol: "replay.v3",
    schema_version: "replay.training.market-tracks-stream.v1",
    type: "DELTA",
    run_id: "run-1",
    base_sequence: 6,
    sequence: 9,
    operations: [],
  }, delta), /sequence has a gap/);
  assert.throws(() => applyReplayTrainingRunStreamMessage({
    protocol: "replay.v3",
    schema_version: "replay.training.market-tracks-stream.v1",
    type: "DELTA",
    run_id: "run-1",
    base_sequence: 8,
    sequence: 9,
    operations: [{
      op: "SET",
      path: ["__proto__", "polluted"],
      value: true,
    }],
  }, delta), /is invalid/);
  assert.throws(() => applyReplayTrainingRunStreamMessage({
    protocol: "replay.v3",
    schema_version: "replay.training.market-tracks-stream.v1",
    type: "DELTA",
    run_id: "run-1",
    base_sequence: 8,
    sequence: 9,
    operations: [],
  }, delta), /operation count is invalid/);
});

test("Run stream reconnects for an authoritative snapshot after a delta gap", async () => {
  const sockets: Array<ReplayTrainingRunStreamSocket & { closeCode: number | null }> = [];
  const errors: boolean[] = [];
  const stream = new ReplayTrainingRunStream({
    runId: "run-1",
    baseUrl: "ws://example.test",
    backoffMs: [1],
    socketFactory: () => {
      const socket: ReplayTrainingRunStreamSocket & { closeCode: number | null } = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        closeCode: null,
        close: (code) => { socket.closeCode = code ?? null; },
      };
      sockets.push(socket);
      return socket;
    },
    onProjection: () => undefined,
    onError: (_error, fatal) => errors.push(fatal),
  });
  stream.start();
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      protocol: "replay.v3",
      schema_version: "replay.training.market-tracks-stream.v1",
      type: "SNAPSHOT",
      run_id: "run-1",
      sequence: 0,
      projection: marketTracksResponse(),
    }),
  } as MessageEvent<string>);
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      protocol: "replay.v3",
      schema_version: "replay.training.market-tracks-stream.v1",
      type: "DELTA",
      run_id: "run-1",
      base_sequence: 2,
      sequence: 3,
      operations: [],
    }),
  } as MessageEvent<string>);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sockets[0]!.closeCode, 1012);
  assert.equal(sockets.length, 2);
  assert.deepEqual(errors, [false]);
  stream.stop();
});

test("account records API binds type, scope, cursor, and page limit", async () => {
  const requests: string[] = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        schema_version: "replay.training.account-record-page.v1",
        run_id: "run-1",
        record_type: "ORDERS",
        order_scope: "HISTORY",
        track_id: "track-2",
        items: [{ order_id: "ord-1", status: "FILLED" }],
        total_count: 1,
        next_cursor: "eyJjdXJzb3IiOjF9",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const page = await client.accountRecordsRun("run-1", {
    recordType: "ORDERS",
    orderScope: "HISTORY",
    trackId: "track-2",
    cursor: "cursor_1",
    limit: 25,
  });
  assert.equal(page.items[0]?.order_id, "ord-1");
  assert.match(requests[0] ?? "", /record_type=ORDERS/);
  assert.match(requests[0] ?? "", /order_scope=HISTORY/);
  assert.match(requests[0] ?? "", /track_id=track-2/);
  assert.match(requests[0] ?? "", /cursor=cursor_1/);
  assert.match(requests[0] ?? "", /limit=25/);
});
