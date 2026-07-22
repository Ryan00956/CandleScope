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

function marketTracksResponse() {
  return {
    protocol: "replay.v2",
    run_id: "run-1",
    ordering_version: "replay.global-order.v1",
    global_clock: {
      mode: "ORDERED",
      state: "PAUSED",
      speed: 1,
      reason: null,
      generation: 0,
      tick: 0,
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
  assert.match(watchlist, /selectTrack|addAndSelectTrack/);
  assert.match(watchlist, /forced_full_reasons/);
  assert.doesNotMatch(watchlist, /updateSubscriptionTier|useWatchlistRuntime|livePrice/);
  const paper = readFileSync(
    resolve(testDirectory, "../components/ReplayRightRail.tsx"),
    "utf8",
  );
  assert.match(paper, /viewer\.actions\.submitTrade/);
  assert.match(paper, /portfolioPositions|marketTracks\?\.portfolio/);
  const controls = readFileSync(
    resolve(testDirectory, "../components/ReplayControlBar.tsx"),
    "utf8",
  );
  assert.match(controls, /phase3Command\("acquire_controller", \{ takeover: false \}\)/);
});
