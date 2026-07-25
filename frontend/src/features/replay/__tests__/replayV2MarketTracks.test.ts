import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReplayV2ApiClient } from "../replayV2Api.js";
import { parseReplayMarketTracksResponse } from "../replayV2Types.js";


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
    protocol: "replay.v2",
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
        capabilities: { OHLCV: "AVAILABLE_EXACT" },
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

test("Phase 13 global clock parser freezes basis, rate, limits, and display binding", () => {
  const parsed = parseReplayMarketTracksResponse(marketTracksResponse());
  assert.equal(parsed.global_clock.contract, "replay.playback.v1");
  assert.equal(parsed.global_clock.basis, "BASE_BAR");
  assert.equal(parsed.global_clock.rate, 1);
  assert.deepEqual(parsed.global_clock.playback_bases, [
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
  const parsed = parseReplayMarketTracksResponse({
    ...payload,
    portfolio: {
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
        maintenance_margin: "5",
        isolated_margin: "1000",
        margin_equity: "1000.5",
        risk_ratio: "200.1",
        rule_revision: 1,
        rule_hash: `sha256:${"a".repeat(64)}`,
        mark_fidelity: "REVEALED_BAR_CLOSE_PROXY",
      }],
      orders: [{ order_id: "ord-1", track_id: "track-2", status: "OPEN" }],
      fills: [{ fill_id: "fill-1", track_id: "track-2", configured_fee: "1" }],
      active_fee_policy: { revision: 1, maker_fee_bps: "2", taker_fee_bps: "5" },
      instrument_rules: [{ track_id: "track-2", revision: 1 }],
      isolated_allocations: { "track-2": "1000" },
      next_funding_time_ms: 1_710_000_300_000,
      liquidations: [{
        liquidation_id: "liq-track-2-0000000001",
        track_id: "track-2",
        state: "COMPLETED",
        fidelity: "REVEALED_BAR_CLOSE_PROXY",
      }],
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
    },
  });
  assert.equal(parsed.portfolio.schema_version, "replay.training.portfolio.v2");
  if (parsed.portfolio.schema_version !== "replay.training.portfolio.v2") {
    assert.fail("contract portfolio did not survive parsing");
  }
  assert.equal(parsed.portfolio.margin_mode, "ISOLATED");
  assert.equal(parsed.portfolio.ledger.reconciliation_delta, "0");
  assert.equal(parsed.portfolio.liquidations.length, 1);
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

test("Phase 5 replay watchlist is backed only by replay.v2 track commands", () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const watchlist = readFileSync(
    resolve(testDirectory, "../components/ReplayWatchlistPanel.tsx"),
    "utf8",
  );
  assert.match(watchlist, /viewer\.marketTracks/);
  assert.match(watchlist, /launch_context\.watchlist_snapshot\.groups/);
  assert.match(watchlist, /data-replay-watchlist-source="run-archive"/);
  assert.match(watchlist, /selectTrack|addAndSelectTrack/);
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
  assert.match(paper, /portfolioPositions|marketTracks\?\.portfolio/);
  assert.match(paper, /模拟账户强平/);
  assert.match(paper, /历史市场爆仓/);
  assert.match(paper, /simulated-account-liquidation/);
  assert.match(paper, /reconciliation_delta/);
  assert.match(paper, /不含盘口排队/);
  assert.match(paper, /data-replay-rail-tab/);
  assert.doesNotMatch(paper, /BAR v1 不支持/);
  const integrity = readFileSync(
    resolve(testDirectory, "../components/ReplayIntegrityReviewPanel.tsx"),
    "utf8",
  );
  assert.match(integrity, /SERVER-AUTHORITATIVE · PHASE 6/);
  assert.match(integrity, /版本化 Run command/);
  assert.doesNotMatch(integrity, /REPLAY_POLICY_UNSUPPORTED/);
  const controls = readFileSync(
    resolve(testDirectory, "../components/ReplayControlBar.tsx"),
    "utf8",
  );
  assert.match(controls, /phase3Command\("acquire_controller", \{ takeover: false \}\)/);
});
