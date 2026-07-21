import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import {
  ReplayViewerProjectionError,
  aggregateReplayBaseBars,
  rebuildReplayViewerSeries,
} from "../replayViewerProjection.js";


const HOUR_START = 1_800_000_000 - (1_800_000_000 % 3_600);

function baseBar(index: number, closed = true): KlineBar {
  const price = 100 + index;
  return {
    time: (HOUR_START + index * 60) as KlineBar["time"],
    open: price,
    high: price + 2,
    low: price - 1,
    close: price + 1,
    volume: 10,
    quoteVolume: 1_000,
    trades: 5,
    takerBuyBase: 4,
    takerBuyQuote: 400,
    replayCloseTimeMs: (HOUR_START + (index + 1) * 60) * 1_000 - 1,
    replayLastBaseOpenMs: (HOUR_START + index * 60) * 1_000,
    replayComponentCount: 1,
    replayExpectedComponents: 1,
    replayClosed: closed,
    replaySynthetic: false,
  };
}

test("base 1m projects the complete 1m/5m/15m/1h close matrix", () => {
  const prefix = Array.from({ length: 60 }, (_, index) => baseBar(index));
  for (const [interval, expectedCount, expectedComponents] of [
    ["1m", 60, 1],
    ["5m", 12, 5],
    ["15m", 4, 15],
    ["1h", 1, 60],
  ] as const) {
    const rows = aggregateReplayBaseBars(prefix, "1m", interval);
    assert.equal(rows.length, expectedCount);
    assert.ok(rows.every((row) => row.replayClosed === true));
    assert.ok(rows.every((row) => row.replayComponentCount === expectedComponents));
    assert.ok(rows.every((row) => row.replayExpectedComponents === expectedComponents));
  }
});

test("a single revealed base bar remains a forming 15m bar until bucket close", () => {
  const forming = aggregateReplayBaseBars([baseBar(0)], "1m", "15m");
  assert.equal(forming.length, 1);
  assert.equal(forming[0]?.replayComponentCount, 1);
  assert.equal(forming[0]?.replayExpectedComponents, 15);
  assert.equal(forming[0]?.replayClosed, false);

  const closed = aggregateReplayBaseBars(
    Array.from({ length: 15 }, (_, index) => baseBar(index)),
    "1m",
    "15m",
  );
  assert.equal(closed[0]?.replayComponentCount, 15);
  assert.equal(closed[0]?.replayClosed, true);
});

test("AGG_TRADE component counts do not masquerade as display bar completeness", () => {
  const tradeBuiltBase = Array.from({ length: 15 }, (_, index) => ({
    ...baseBar(index),
    replayComponentCount: 10 + index,
    replayExpectedComponents: null,
  }));
  const display = aggregateReplayBaseBars(tradeBuiltBase, "1m", "15m");
  assert.equal(display[0]?.replayComponentCount, 15);
  assert.equal(display[0]?.replayExpectedComponents, 15);
  assert.equal(display[0]?.replayClosed, true);
});

test("viewer interval round-trip rebuilds from the base prefix without mutating it", () => {
  const source = new SeriesWindowStore({ intervalSeconds: 60, seriesKey: "replay-base" });
  source.replace(Array.from({ length: 60 }, (_, index) => baseBar(index)));
  const original = structuredClone(source.snapshot());
  const derived = new SeriesWindowStore();

  rebuildReplayViewerSeries(derived, source, "1m", "15m");
  assert.equal(derived.barCount, 4);
  rebuildReplayViewerSeries(derived, source, "1m", "1h");
  assert.equal(derived.barCount, 1);
  rebuildReplayViewerSeries(derived, source, "1m", "1m");
  assert.deepEqual(derived.snapshot(), original);
  assert.deepEqual(source.snapshot(), original);
});

test("calendar and inexact viewer intervals fail closed", () => {
  assert.throws(
    () => aggregateReplayBaseBars([baseBar(0)], "1m", "1M"),
    ReplayViewerProjectionError,
  );
  assert.throws(
    () => aggregateReplayBaseBars([baseBar(0)], "5m", "7m"),
    ReplayViewerProjectionError,
  );
});

test("misaligned base rows fail closed instead of completing a display bucket", () => {
  const misaligned = {
    ...baseBar(0),
    time: (HOUR_START + 30) as KlineBar["time"],
  };
  assert.throws(
    () => aggregateReplayBaseBars([misaligned], "1m", "15m"),
    /not aligned/,
  );
});
