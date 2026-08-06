import assert from "node:assert/strict";
import test from "node:test";

import {
  addReplayTradeFlowDecimals,
  parseReplayTradeFlowPage,
} from "../replayTradeFlow.js";
import { ReplayV2ApiClient } from "../replayV2Api.js";


function tradeFlowPage() {
  return {
    protocol: "replay.v3",
    schema_version: "replay.trade-flow.v1",
    run_id: "run-1",
    track_id: "track-1",
    source_kind: "AGG_TRADE",
    capabilities: { tape: "AVAILABLE_EXACT", order_flow: "AVAILABLE_APPROX" },
    fidelity: "AGGREGATE_TRADE_NOT_RAW_TRADE",
    continuity: {
      state: "CONTIGUOUS",
      data_epoch: `sha256:${"a".repeat(64)}`,
      after_sequence: 0,
      next_sequence: 2,
      revealed_sequence: 3,
      resync_token: `sha256:${"b".repeat(64)}`,
    },
    tape: [
      {
        source_sequence: 1,
        agg_trade_id: 101,
        trade_time_ms: 1_710_000_000_001,
        price: "65000.1",
        quantity: "0.00000001",
        quote_quantity: "0.000650001",
        raw_trade_count: 1,
        aggressor_side: "BUY",
        cvd_delta: "0.00000001",
        fidelity: "AGGREGATE_TRADE_NOT_RAW_TRADE",
      },
      {
        source_sequence: 2,
        agg_trade_id: 102,
        trade_time_ms: 1_710_000_000_002,
        price: "65000",
        quantity: "0.1",
        quote_quantity: "6500",
        raw_trade_count: 3,
        aggressor_side: "SELL",
        cvd_delta: "-0.1",
        fidelity: "AGGREGATE_TRADE_NOT_RAW_TRADE",
      },
    ],
    page_flow: {
      buy_quantity: "0.00000001",
      sell_quantity: "0.1",
      delta: "-0.09999999",
      quote_quantity: "6500.000650001",
      trade_count: 2,
      cvd_contract: "CLIENT_PREFIX_SUM_OF_CONTIGUOUS_PAGE_DELTAS",
    },
    next_cursor: {
      source_sequence: 2,
      data_epoch: `sha256:${"a".repeat(64)}`,
    },
    has_more: true,
    streaming: {
      page_bounded: true,
      resident_pages: 1,
      prefetch_pages: 1,
      full_history_materialization: false,
    },
  };
}

test("Phase 8 trade-flow parser preserves aggregate fidelity and exact Decimal CVD", () => {
  const parsed = parseReplayTradeFlowPage(tradeFlowPage());
  assert.equal(parsed.tape[0]?.aggressor_side, "BUY");
  assert.equal(parsed.page_flow.delta, "-0.09999999");
  assert.equal(addReplayTradeFlowDecimals("0.00000001", "-0.1"), "-0.09999999");
  assert.equal(addReplayTradeFlowDecimals("999999999999999999.9", "0.1"), "1000000000000000000");
});

test("Phase 8 trade-flow parser fails closed on gaps, unknown fields, and noncanonical Decimal values", () => {
  const gap = tradeFlowPage();
  gap.tape[1]!.agg_trade_id = 103;
  assert.throws(() => parseReplayTradeFlowPage(gap), /aggregate-trade gap/);

  const unknown = { ...tradeFlowPage(), future_book: [] };
  assert.throws(() => parseReplayTradeFlowPage(unknown), /fields are incompatible/);

  const imprecise = tradeFlowPage();
  imprecise.tape[0]!.quantity = "0.1000";
  assert.throws(() => parseReplayTradeFlowPage(imprecise), /canonical Decimal/);

  const inconsistent = tradeFlowPage();
  inconsistent.page_flow.delta = "0";
  assert.throws(() => parseReplayTradeFlowPage(inconsistent), /summary does not match/);

  const wrongSide = tradeFlowPage();
  wrongSide.tape[0]!.cvd_delta = "-0.00000001";
  assert.throws(() => parseReplayTradeFlowPage(wrongSide), /cvd_delta is incompatible/);
});

test("Phase 8 API requests only a bounded run-scoped revealed trade-flow page", async () => {
  const requests: string[] = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(tradeFlowPage()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const response = await client.tradeFlowRun("run-1", {
    trackId: "track-1",
    afterSequence: 0,
    limit: 200,
  });
  assert.equal(response.next_cursor.source_sequence, 2);
  assert.deepEqual(requests, [
    "/api/v1/replay/runs/run-1/trade-flow?track_id=track-1&after_sequence=0&limit=200",
  ]);
});
