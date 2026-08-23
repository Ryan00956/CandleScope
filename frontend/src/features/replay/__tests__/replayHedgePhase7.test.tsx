import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getLocale, setLocale } from "../../../i18n/index.js";
import ReplayLiquidationTimeline from "../components/ReplayLiquidationTimeline.js";
import { parseReplayLiquidationCases } from "../replayV2Types.js";

const digest = `sha256:${"a".repeat(64)}`;

function liquidationCase() {
  return {
    run_id: "run-phase7",
    case_id: "case-phase7",
    case_sequence: 1,
    state: "COMPLETED",
    trigger_snapshot_id: "snapshot-trigger",
    final_snapshot_id: "snapshot-complete",
    trigger_virtual_time_ms: 1_710_000_000_000,
    trigger_source_sequence: 42,
    reason: "MAINTENANCE_MARGIN_BREACH",
    fidelity: "ACCOUNT_CROSS_MULTI_TRACK_DETERMINISTIC",
    component_hash: digest,
    legs: [{
      liquidation_leg_id: "leg-long",
      leg_sequence: 1,
      track_id: "track-btc",
      position_side: "LONG",
      trigger_quantity: "2.4",
      trigger_notional: "120",
      maintenance_margin: "0.6",
      liquidation_price: "53.7",
      bankruptcy_price: "53.4",
      takeover_price: "53.4",
      liquidation_fee: "0.3",
      target_quantity: "2.4",
      completed_quantity: "2.4",
      state: "TRANSFERRED",
      component_hash: digest,
    }],
    book_snapshots: [{
      case_id: "case-phase7",
      track_id: "track-btc",
      as_of_virtual_time_ms: 1_710_000_000_000,
      last_update_id: 100,
      book_hash: digest,
      execution_fidelity: "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1",
      queue_exact: false,
      snapshot_hash: digest,
    }],
    steps: [{
      step_sequence: 1,
      step_type: "FULL_LIQUIDATION",
      state: "APPLIED",
      before_snapshot_id: "snapshot-trigger",
      after_snapshot_id: "snapshot-executed",
      reason: "VISIBLE_L2_CONSERVATIVE_EXECUTION",
      step_hash: digest,
      book_execution: {
        case_id: "case-phase7",
        step_sequence: 1,
        track_id: "track-btc",
        as_of_virtual_time_ms: 1_710_000_000_000,
        last_update_id: 100,
        side: "SELL",
        requested_quantity: "2.4",
        visible_quantity: "30",
        levels: [{ book_level: 1, price: "49", quantity: "2.4" }],
        book_hash: digest,
        execution_fidelity: "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1",
        queue_exact: false,
        execution_plan_hash: digest,
      },
      orders: [{
        order_id: "order-liquidation",
        liquidation_leg_id: "leg-long",
        order_sequence: 1,
        side: "SELL",
        order_type: "MARKET",
        requested_quantity: "2.4",
        filled_quantity: "2.4",
        remaining_quantity: "0",
        average_price: "49",
        state: "FILLED",
        order_hash: digest,
        fills: [{
          fill_id: "fill-liquidation",
          fill_sequence: 1,
          price: "49",
          quantity: "2.4",
          notional: "117.6",
          trading_fee: "0.06",
          liquidation_fee: "0.3",
          book_level: 1,
          virtual_time_ms: 1_710_000_000_000,
          source_sequence: 42,
          fill_hash: digest,
        }],
      }],
      insurance_postings: [{
        asset: "USDT",
        posting_sequence: 1,
        posting_id: "insurance-posting",
        cash_delta: "-10",
        balance_after: "0",
        reason: "BANKRUPTCY_DEFICIT_DEBIT",
        posting_hash: digest,
      }],
      adl_events: [{
        adl_event_id: "adl-event",
        snapshot_id: "adl-snapshot",
        required_notional: "10",
        completed_notional: "10",
        state: "COMPLETED",
        event_hash: digest,
        selections: [{
          selection_sequence: 1,
          candidate_id: "candidate-short",
          snapshot_id: "adl-snapshot",
          quantity: "0.2",
          price: "50",
          notional: "10",
          cash_delta: "10",
          selection_hash: digest,
        }],
        counterparty_ledger: [{
          ledger_sequence: 1,
          candidate_id: "candidate-short",
          snapshot_id: "adl-snapshot",
          position_side: "SHORT",
          quantity_before: "1",
          quantity_delta: "-0.2",
          quantity_after: "0.8",
          takeover_price: "50",
          cash_delta: "10",
          entry_hash: digest,
        }],
      }],
    }],
  };
}

test("Phase 7 parses and renders the complete liquidation, insurance and ADL timeline", () => {
  const parsed = parseReplayLiquidationCases([liquidationCase()]);
  const previousLocale = getLocale();
  let html = "";
  try {
    setLocale("en");
    html = renderToStaticMarkup(<ReplayLiquidationTimeline cases={parsed} />);
  } finally {
    setLocale(previousLocale);
  }

  assert.match(html, /Case #1/);
  assert.match(html, /FULL_LIQUIDATION/);
  assert.match(html, /queue exact: false/);
  assert.match(html, /Insurance/);
  assert.match(html, /ADL · COMPLETED/);
  assert.match(html, /deterministic simulation, not a historical exchange private queue/);
  assert.doesNotMatch(html, /actual_time|archive_path|private_queue_position/);
});

test("Phase 7 timeline parser rejects queue-exact claims and unknown private fields", () => {
  const queueExact = structuredClone(liquidationCase());
  queueExact.book_snapshots[0]!.queue_exact = true;
  assert.throws(() => parseReplayLiquidationCases([queueExact]), /queue_exact must remain false/);

  const privateLeak = { ...liquidationCase(), archive_path: "D:\\private\\book.sqlite" };
  assert.throws(() => parseReplayLiquidationCases([privateLeak]), /unknown archive_path/);
});

test("Phase 7 entry and narrow-rail layout have no gray gate or horizontal overflow trap", () => {
  const entrySource = readFileSync(new URL("../useReplayEntryCapability.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../../index.css", import.meta.url), "utf8");

  assert.doesNotMatch(entrySource, /VITE_REPLAY_ENTRY_ENABLED/);
  assert.doesNotMatch(entrySource, /hidden/);
  assert.match(css, /\.replay-liquidation-case-body,[\s\S]*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(css, /\.replay-liquidation-steps\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.replay-right-rail[\s\S]*\.replay-liquidation-legs\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});
