import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayDisplayProjection } from "../replayDisplayProjection.js";


const DIGEST = `sha256:${"a".repeat(64)}`;
const OPEN_MS = Date.UTC(2000, 0, 3);
const CLOSE_MS = OPEN_MS + 7 * 86_400_000 - 1;

function response() {
  return {
    protocol: "replay.v2",
    schema_version: "replay.display-projection.v1",
    run_id: "run-1",
    session_id: "session-1",
    track_id: "track-1",
    identity: {
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      source_kind: "BAR",
      base_interval: "1m",
      display_interval: "1w",
    },
    data_epoch: DIGEST,
    projection_epoch: DIGEST,
    display_interval: "1w",
    revealed_boundary_ms: CLOSE_MS,
    bars: [{
      open_time_ms: OPEN_MS,
      close_time_ms: CLOSE_MS,
      open: "5309.81",
      high: "5900",
      low: "5178.8",
      close: "5775.62",
      volume: "191971.589975",
      quote_volume: null,
      trades: null,
      taker_buy_base: null,
      taker_buy_quote: null,
      first_base_open_ms: OPEN_MS,
      last_base_open_ms: CLOSE_MS - 59_999,
      component_count: 10_080,
      expected_components: 10_080,
      is_closed: true,
      synthetic: false,
    }],
    has_more: false,
  };
}

test("source-bucket projection parser accepts public-only weekly candles", () => {
  const parsed = parseReplayDisplayProjection(response());
  assert.equal(parsed.bars[0]?.open, "5309.81");
  assert.equal(parsed.bars[0]?.close, "5775.62");
  assert.equal(JSON.stringify(parsed).includes("2024"), false);
});

test("source-bucket projection parser rejects a bar beyond the public cursor", () => {
  const forged = response();
  forged.bars[0]!.last_base_open_ms = CLOSE_MS + 1;
  assert.throws(
    () => parseReplayDisplayProjection(forged),
    /exceeds the public cursor/,
  );
});
