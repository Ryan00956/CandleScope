import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import {
  applyReplayViewerSeriesDelta,
  ReplayViewerProjectionError,
  aggregateReplayBaseBars,
  rebuildReplayViewerSeries,
} from "../replayViewerProjection.js";
import {
  selectRevealedIndicatorBars,
} from "../useReplaySharedIndicatorRuntime.js";


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

function barAt(time: number, index: number, intervalSeconds: number): KlineBar {
  return {
    ...baseBar(index),
    time: time as KlineBar["time"],
    replayCloseTimeMs: (time + intervalSeconds) * 1_000 - 1,
    replayLastBaseOpenMs: time * 1_000,
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
  const hourly = aggregateReplayBaseBars(prefix, "1m", "1h")[0];
  assert.equal(hourly?.taker_buy_base, 240);
  assert.equal(hourly?.takerBuyBase, 240);
  assert.equal(hourly?.volume, 600);
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

test("weekly and calendar-month viewer intervals preserve real UTC boundaries", () => {
  const daySeconds = 86_400;
  const januaryStart = Date.UTC(2024, 0, 1) / 1_000;
  const daily = Array.from({ length: 60 }, (_, index) => (
    barAt(januaryStart + index * daySeconds, index, daySeconds)
  ));

  const weekly = aggregateReplayBaseBars(daily.slice(0, 14), "1d", "1w");
  assert.deepEqual(weekly.map((row) => Number(row.time)), [
    Date.UTC(2024, 0, 1) / 1_000,
    Date.UTC(2024, 0, 8) / 1_000,
  ]);
  assert.ok(weekly.every((row) => row.replayExpectedComponents === 7));
  assert.ok(weekly.every((row) => row.replayClosed === true));

  const monthly = aggregateReplayBaseBars(daily, "1d", "1M");
  assert.deepEqual(monthly.map((row) => Number(row.time)), [
    Date.UTC(2024, 0, 1) / 1_000,
    Date.UTC(2024, 1, 1) / 1_000,
  ]);
  assert.deepEqual(monthly.map((row) => row.replayExpectedComponents), [31, 29]);
  assert.ok(monthly.every((row) => row.replayClosed === true));
  assert.equal(monthly[1]?.replayCloseTimeMs, Date.UTC(2024, 2, 1) - 1);
});

test("custom fixed intervals project while inexact intervals fail closed", () => {
  const intervalSeconds = 89 * 60;
  const alignedStart = Math.floor(HOUR_START / intervalSeconds) * intervalSeconds;
  const rows = Array.from({ length: 178 }, (_, index) => (
    barAt(alignedStart + index * 60, index, 60)
  ));
  assert.equal(aggregateReplayBaseBars(rows, "1m", "89m").length, 2);
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

test("history pages stay prepend deltas instead of replacing the viewer dataset", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    maxBars: 100,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 10 }, (_, index) => baseBar(index + 10)));
  const viewer = new SeriesWindowStore();
  rebuildReplayViewerSeries(viewer, source, "1m", "1m");
  const emitted: string[] = [];
  const unsubscribe = viewer.subscribe((delta) => { emitted.push(delta.type); });

  const sourceDelta = source.applyRange(
    Array.from({ length: 10 }, (_, index) => baseBar(index)),
  );
  applyReplayViewerSeriesDelta(viewer, source, "1m", "1m", sourceDelta);
  unsubscribe();

  assert.deepEqual(viewer.snapshot(), source.snapshot());
  assert.deepEqual(emitted, ["prepend"]);
  assert.doesNotMatch(emitted.join(","), /replace|clear/);
});

test("derived history prepend corrects its boundary bucket without a viewer replace", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    maxBars: 6,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 6 }, (_, index) => baseBar(index + 6)));
  const viewer = new SeriesWindowStore();
  rebuildReplayViewerSeries(viewer, source, "1m", "5m");
  const emitted: string[] = [];
  const unsubscribe = viewer.subscribe((delta) => { emitted.push(delta.type); });

  const sourceDelta = source.applyRange(
    Array.from({ length: 6 }, (_, index) => baseBar(index)),
  );
  applyReplayViewerSeriesDelta(viewer, source, "1m", "5m", sourceDelta);
  unsubscribe();

  assert.equal(source.rightTruncated, true);
  assert.deepEqual(
    viewer.snapshot(),
    aggregateReplayBaseBars(source.snapshot(), "1m", "5m"),
  );
  assert.equal(emitted[0], "prepend");
  assert.ok(emitted.includes("mid-merge"));
  assert.doesNotMatch(emitted.join(","), /replace|clear/);
});

test("tail projection publishes tick then append semantics like the live chart path", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 14 }, (_, index) => baseBar(index)));
  const viewer = new SeriesWindowStore();
  rebuildReplayViewerSeries(viewer, source, "1m", "15m");
  const emitted: string[] = [];
  const unsubscribe = viewer.subscribe((delta) => { emitted.push(delta.type); });

  const closeBucket = source.applyRange([baseBar(14)]);
  applyReplayViewerSeriesDelta(viewer, source, "1m", "15m", closeBucket);
  const openNextBucket = source.applyRange([baseBar(15)]);
  applyReplayViewerSeriesDelta(viewer, source, "1m", "15m", openNextBucket);
  unsubscribe();

  assert.deepEqual(emitted, ["tick", "append"]);
  assert.deepEqual(
    viewer.snapshot(),
    aggregateReplayBaseBars(source.snapshot(), "1m", "15m"),
  );
});

test("display-only context survives execution ticks and explicit restore drops it", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 3 }, (_, index) => baseBar(index + 10)));
  const viewer = new SeriesWindowStore({ maxBars: 20 });
  rebuildReplayViewerSeries(viewer, source, "1m", "1m");
  viewer.applyRange(Array.from({ length: 3 }, (_, index) => ({
    ...baseBar(index + 7),
    replayContextHistory: true,
  })));

  const sourceDelta = source.applyRange([baseBar(13)]);
  applyReplayViewerSeriesDelta(viewer, source, "1m", "1m", sourceDelta);
  assert.deepEqual(
    viewer.snapshot().slice(0, 3).map((row) => row.replayContextHistory),
    [true, true, true],
  );
  assert.deepEqual(
    viewer.snapshot().slice(3).map((row) => Number(row.time)),
    source.snapshot().map((row) => Number(row.time)),
  );

  rebuildReplayViewerSeries(viewer, source, "1m", "1m");
  assert.ok(viewer.snapshot().every((row) => row.replayContextHistory !== true));
  assert.deepEqual(viewer.snapshot(), source.snapshot());
});

test("native pre-replay context replaces a partial warmup bucket and keeps latest indicators continuous", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 140 }, (_, index) => baseBar(index + 40)));
  const viewer = new SeriesWindowStore({ maxBars: 200 });
  rebuildReplayViewerSeries(viewer, source, "1m", "1h");
  assert.equal(viewer.first()?.replayClosed, false);

  const nativeContext = {
    ...barAt(HOUR_START, -1, 3_600),
    close: 777,
    replayContextHistory: true,
  };
  viewer.applyRange([nativeContext]);
  assert.equal(viewer.first()?.close, 777);

  const sourceDelta = source.applyRange([baseBar(180)]);
  applyReplayViewerSeriesDelta(viewer, source, "1m", "1h", sourceDelta);
  const rows = viewer.snapshot();
  assert.equal(rows[0]?.close, 777);
  assert.equal(rows[0]?.replayContextHistory, true);
  assert.equal(rows.at(-1)?.replayClosed, false);

  const cursorMs = (HOUR_START + 181 * 60) * 1_000 - 1;
  const indicatorBars = selectRevealedIndicatorBars(rows, cursorMs);
  assert.deepEqual(
    indicatorBars.map((row) => Number(row.time)),
    [
      HOUR_START,
      HOUR_START + 3_600,
      HOUR_START + 7_200,
      HOUR_START + 10_800,
    ],
  );
  assert.equal(indicatorBars.at(-1)?.replayClosed, false);
});

test("a right-truncated context window stops following execution until restore", () => {
  const source = new SeriesWindowStore({
    intervalSeconds: 60,
    seriesKey: "replay-base",
  });
  source.replace(Array.from({ length: 3 }, (_, index) => baseBar(index + 10)));
  const viewer = new SeriesWindowStore({ maxBars: 5 });
  rebuildReplayViewerSeries(viewer, source, "1m", "1m");
  viewer.applyRange(Array.from({ length: 5 }, (_, index) => ({
    ...baseBar(index + 5),
    replayContextHistory: true,
  })));
  assert.equal(viewer.rightTruncated, true);
  const historicalWindow = structuredClone(viewer.snapshot());

  const sourceDelta = source.applyRange([baseBar(13)]);
  const ignored = applyReplayViewerSeriesDelta(
    viewer,
    source,
    "1m",
    "1m",
    sourceDelta,
  );
  assert.equal(ignored.type, "noop");
  assert.deepEqual(viewer.snapshot(), historicalWindow);

  rebuildReplayViewerSeries(viewer, source, "1m", "1m");
  assert.equal(viewer.rightTruncated, false);
  assert.deepEqual(viewer.snapshot(), source.snapshot());
});
