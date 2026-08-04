import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReplayOrderPreview,
  parseReplayTrainingResultsResponse,
} from "../replayV2Types.js";


function plannedPreview() {
  return {
    protocol: "replay.v2",
    schema_version: "replay.order-preview.v2",
    run_id: "run-1",
    track_id: "track-1",
    accepted: true,
    position_intent: "OPEN",
    revision: 6,
    cursor: {
      virtual_time_ms: 1_710_000_059_999,
      source_sequence: 1,
      revision: 6,
    },
    state_hash: `sha256:${"b".repeat(64)}`,
    execution_fidelity: "BAR_CONSERVATIVE",
    order: {
      client_order_id: "planned-order-1",
      side: "BUY",
      order_type: "MARKET",
      quantity: "0.99",
      reduce_only: false,
      limit_price: null,
      stop_price: null,
    },
    reference_price: "100",
    estimated_fill_price: "100.1",
    estimated_notional: "99.099",
    reserved_margin: "19.8198",
    estimated_fee: "0.0396396",
    fee_basis: "TAKER_WORST_CASE",
    available_equity_after: "980.1405604",
    max_quantity: "10",
    quote_asset: "USDT",
    max_leverage: "5",
    trade_plan: {
      schema_version: "replay.trade-plan.snapshot.v1",
      track_id: "track-1",
      client_order_id: "planned-order-1",
      side: "BUY",
      order_type: "MARKET",
      sizing_mode: "ACCOUNT_RISK_PERCENT",
      risk_amount: "10",
      risk_percent: "1",
      account_equity: "1000",
      entry_price: "100.1",
      invalidation_price: "90.1",
      target_price: "120.1",
      risk_per_unit: "10",
      reward_risk_ratio: "2",
      quantity: "0.99",
      reason: "retest held above the invalidation level",
    },
  };
}

function trainingResults() {
  return {
    protocol: "replay.v2",
    schema_version: "replay.training-results.v1",
    run_id: "run-1",
    summary: {
      trade_count: 1,
      win_count: 1,
      loss_count: 0,
      win_rate: "1",
      gross_realized_pnl: "20",
      net_realized_pnl: "19.92",
      fees_paid: "0.08",
      average_win: "20",
      average_loss: "0",
      payoff_ratio: null,
      profit_factor: null,
      max_drawdown: "3",
      average_mae: "-2",
      average_mfe: "23",
      average_r_multiple: "2.020202020202020202",
      average_holding_duration_ms: 120_000,
      planned_trade_count: 1,
    },
    items: [{
      trade_id: "trade-1",
      episode_id: "trade-episode-1",
      track_id: "track-1",
      symbol: "BTCUSDT",
      settlement_asset: "USDT",
      fill_id: "fill-2",
      position_side: "BUY",
      quantity: "0.99",
      entry_price: "100.1",
      exit_price: "120.302020202020202",
      gross_realized_pnl: "20",
      mae: "-2",
      mfe: "23",
      initial_risk_amount: "9.9",
      r_multiple: "2.020202020202020202",
      holding_duration_ms: 120_000,
      entry_source_sequence: 1,
      exit_source_sequence: 3,
      entry_public_time: { label: "T+0" },
      exit_public_time: { label: "T+2m" },
      plans: [{
        plan_id: "trade-plan-1",
        plan_hash: `sha256:${"c".repeat(64)}`,
        sizing_mode: "ACCOUNT_RISK_PERCENT",
        risk_amount: "10",
        risk_percent: "1",
        entry_price: "100.1",
        invalidation_price: "90.1",
        target_price: "120.1",
        reward_risk_ratio: "2",
        quantity: "0.99",
        reason: "retest held above the invalidation level",
      }],
      review_event_id: "review-fill-2",
      excursion_fidelity: "REVEALED_MARK_PATH_CONSERVATIVE",
      pnl_basis: "REALIZED_GROSS_EX_FEES",
    }],
    returned_count: 1,
    truncated: false,
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
  };
}

test("planned order preview keeps the authoritative sized quantity and immutable snapshot", () => {
  const parsed = parseReplayOrderPreview(plannedPreview());
  assert.equal(parsed.schema_version, "replay.order-preview.v2");
  assert.equal(parsed.trade_plan?.quantity, "0.99");
  assert.equal(parsed.trade_plan?.risk_percent, "1");
  assert.throws(() => parseReplayOrderPreview({
    ...plannedPreview(),
    trade_plan: { ...plannedPreview().trade_plan, quantity: 0.99 },
  }), /Decimal string/);
});

test("training results parser keeps MAE MFE R duration and review linkage strict", () => {
  const parsed = parseReplayTrainingResultsResponse(trainingResults());
  assert.equal(parsed.items[0]?.mae, "-2");
  assert.equal(parsed.items[0]?.mfe, "23");
  assert.equal(parsed.items[0]?.r_multiple, "2.020202020202020202");
  assert.equal(parsed.items[0]?.holding_duration_ms, 120_000);
  assert.equal(parsed.items[0]?.review_event_id, "review-fill-2");
  assert.throws(() => parseReplayTrainingResultsResponse({
    ...trainingResults(),
    items: [{ ...trainingResults().items[0], settlement_asset: "USDT", mae: -2 }],
  }), /canonical Decimal string/);
  assert.throws(() => parseReplayTrainingResultsResponse({
    ...trainingResults(),
    summary: { ...trainingResults().summary, planned_trade_count: 2 },
  }), /counters are inconsistent/);
});
