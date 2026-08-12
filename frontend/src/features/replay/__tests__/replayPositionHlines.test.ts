import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayPositionHlines,
  replayMarkFidelityLabel,
  replayPositiveModelPrice,
} from "../replayPositionHlines.js";
import type { ReplayTrainingPortfolioPosition } from "../replayV2Types.js";


function position({
  quantity,
  positionSide,
  liquidationPrice,
  bankruptcyPrice,
  markPrice = "100",
  marginEquity = "20",
  maintenanceMargin = "5",
}: {
  readonly quantity: string;
  readonly positionSide?: "LONG" | "SHORT";
  readonly liquidationPrice?: string | null;
  readonly bankruptcyPrice?: string | null;
  readonly markPrice?: string;
  readonly marginEquity?: string;
  readonly maintenanceMargin?: string;
}): ReplayTrainingPortfolioPosition {
  return {
    track_id: "track-1",
    symbol: "BTCUSDT",
    ...(positionSide === undefined ? {} : { position_side: positionSide }),
    position: {
      quantity,
      entry_price: "100",
      mark_price: markPrice,
      unrealized_pnl: "0",
    },
    margin_equity: marginEquity,
    maintenance_margin: maintenanceMargin,
    ...(liquidationPrice === undefined ? {} : { liquidation_price: liquidationPrice }),
    ...(bankruptcyPrice === undefined ? {} : { bankruptcy_price: bankruptcyPrice }),
  };
}

test("HEDGE chart uses each server-owned liquidation and bankruptcy leg", () => {
  const lines = buildReplayPositionHlines({
    selectedTrackId: "track-1",
    positionMode: "HEDGE",
    positions: [
      position({
        quantity: "1",
        positionSide: "LONG",
        liquidationPrice: "73.25",
        bankruptcyPrice: "70",
      }),
      position({
        quantity: "-2",
        positionSide: "SHORT",
        liquidationPrice: "126.75",
        bankruptcyPrice: "130",
      }),
    ],
  });

  assert.deepEqual(lines.map((line) => line.id), [
    "replay-position-average-long",
    "replay-position-liquidation-long",
    "replay-position-bankruptcy-long",
    "replay-position-average-short",
    "replay-position-liquidation-short",
    "replay-position-bankruptcy-short",
  ]);
  assert.equal(lines.find((line) => line.id === "replay-position-liquidation-long")?.price, 73.25);
  assert.equal(lines.find((line) => line.id === "replay-position-liquidation-short")?.price, 126.75);
  assert.match(
    lines.find((line) => line.id === "replay-position-liquidation-long")?.title ?? "",
    /强平价≈.*服务端模型/,
  );
  assert.equal(lines.some((line) => line.id?.includes("risk-reference")), false);
});

test("HEDGE never invents a local liquidation price when a server leg omits it", () => {
  const lines = buildReplayPositionHlines({
    selectedTrackId: "track-1",
    positionMode: "HEDGE",
    positions: [position({
      quantity: "1",
      positionSide: "LONG",
      liquidationPrice: null,
      bankruptcyPrice: null,
    })],
  });

  assert.deepEqual(lines.map((line) => line.id), ["replay-position-average-long"]);
});

test("ONE_WAY prefers the server liquidation pair over the K-line proxy", () => {
  const lines = buildReplayPositionHlines({
    selectedTrackId: "track-1",
    positionMode: "ONE_WAY",
    positions: [position({
      quantity: "1",
      liquidationPrice: "84",
      bankruptcyPrice: "80",
    })],
  });

  assert.deepEqual(lines.map((line) => line.id), [
    "replay-position-average",
    "replay-position-liquidation",
    "replay-position-bankruptcy",
  ]);
  assert.equal(lines.some((line) => line.id === "replay-position-risk-reference"), false);
});

test("ONE_WAY falls back to the prior K-line mark proxy only without a server liquidation", () => {
  const lines = buildReplayPositionHlines({
    selectedTrackId: "track-1",
    positionMode: "ONE_WAY",
    positions: [position({
      quantity: "2",
      liquidationPrice: null,
      bankruptcyPrice: null,
      markPrice: "100",
      marginEquity: "30",
      maintenanceMargin: "10",
    })],
    instrumentRules: [{ track_id: "track-1", rule: { contract_size: "2" } }],
  });

  assert.equal(
    lines.find((line) => line.id === "replay-position-risk-reference")?.price,
    95,
  );
  assert.match(
    lines.find((line) => line.id === "replay-position-risk-reference")?.title ?? "",
    /K线标记代理/,
  );
});

test("risk price presentation exposes proxy fidelity and rejects non-positive model prices", () => {
  assert.equal(replayMarkFidelityLabel("REVEALED_BAR_OR_TAPE_PRICE_PROXY"), "K线/成交代理");
  assert.equal(replayMarkFidelityLabel("REVEALED_BAR_CLOSE_PROXY"), "K线代理");
  assert.equal(replayMarkFidelityLabel("HISTORICAL_EXACT_ARCHIVE_MARK"), "历史 Mark");
  assert.equal(replayMarkFidelityLabel(undefined), "模型代理");
  assert.equal(replayPositiveModelPrice("44770.25"), 44770.25);
  assert.equal(replayPositiveModelPrice("0"), null);
  assert.equal(replayPositiveModelPrice("-1"), null);
  assert.equal(replayPositiveModelPrice(null), null);
});
