import assert from "node:assert/strict";
import test from "node:test";

import { epochSeconds } from "../../../test/testHelpers.js";
import {
  canStartIndicatorInitialHydration,
  canStartIndicatorProgressiveHydration,
} from "../../indicators/indicatorWindowDeltaRuntime.js";
import {
  resolveInitialHostedRange,
  selectProgressiveHostedIndicators,
} from "../../indicators/indicatorRangePlanning.js";
import { createIndicatorInitialHydrationGate } from "../../indicators/indicatorRangeRequestDedupe.js";
import type { IndicatorDefinition } from "../../indicators/indicatorTypes.js";
import { IndicatorWindowCommitBuffer } from "../indicatorWindowCommitBuffer.js";
import type {
  CommitChartData,
  FeedCommitMeta,
  PendingInitialSeries,
} from "../klineContracts.js";
import type { KlineBar } from "../marketDataTypes.js";
import { releasePendingInitialIndicatorWindow } from "../useChartInitialLoad.js";

test("partial page stages every phase and settled page publishes their union once", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  assert.equal(buffer.record("btc-89m", [
    { start: epochSeconds(600), end: epochSeconds(900), type: "prepend" },
  ], { ownerToken: "page", pending: true }).publish, false);
  assert.equal(buffer.record("btc-89m", [
    { start: epochSeconds(800), end: epochSeconds(1_200), type: "mid-merge" },
  ], { ownerToken: "page", pending: true }).publish, false);

  const settled = buffer.record("btc-89m", [
    { start: epochSeconds(1_100), end: epochSeconds(1_500), type: "mid-merge" },
  ], { ownerToken: "page", pending: false });
  assert.equal(settled.publish, true);
  assert.deepEqual(settled.ranges, [
    { start: 800, end: 1_500, type: "mid-merge" },
    { start: 600, end: 900, type: "prepend" },
  ]);
  assert.equal(buffer.hasPending("btc-89m"), false);
  assert.equal(buffer.record("btc-89m", [], {
    ownerToken: "page",
    pending: false,
  }).publish, false, "settlement is emitted only once");
});

test("terminal failure can release retained partial coverage once", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  buffer.record("btc-89m", [
    { start: epochSeconds(600), end: epochSeconds(900), type: "prepend" },
  ], { ownerToken: "repair", pending: true });
  const terminal = buffer.record("btc-89m", [], {
    ownerToken: "repair",
    pending: false,
  });
  assert.deepEqual(terminal.ranges, [
    { start: 600, end: 900, type: "prepend" },
  ]);
  assert.equal(terminal.publish, true);
  assert.equal(buffer.hasPending("btc-89m"), false);
});

test("empty partial ownership survives until a settled probe clears it", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  buffer.record("btc-89m", [], { ownerToken: "page", pending: true });
  assert.equal(buffer.hasPending("btc-89m"), true);
  const settled = buffer.record("btc-89m", [], { ownerToken: "page", pending: false });
  assert.equal(settled.lifecycleChanged, true);
  assert.equal(settled.publish, false);
  assert.equal(buffer.hasPending("btc-89m"), false);
});

test("range bounding keeps a conservative envelope instead of dropping old coverage", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  const staged = buffer.record("btc-89m", Array.from({ length: 513 }, (_, index) => ({
    start: epochSeconds(1 + index * 2),
    end: epochSeconds(1 + index * 2),
    type: "mid-merge" as const,
  })), { ownerToken: "page", pending: true });
  assert.equal(staged.ranges.length, 512);
  assert.deepEqual(staged.ranges[0], {
    start: 1,
    end: 3,
    type: "mid-merge",
  });
  assert.deepEqual(staged.ranges.at(-1), {
    start: 1_025,
    end: 1_025,
    type: "mid-merge",
  });
});

test("parent page and child repair owners publish only after the final owner settles", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  buffer.record("btc-89m", [
    { start: epochSeconds(600), end: epochSeconds(700), type: "prepend" },
  ], { ownerToken: "parent-page", pending: true });
  buffer.record("btc-89m", [
    { start: epochSeconds(800), end: epochSeconds(800), type: "mid-merge" },
  ], { ownerToken: "child-repair", pending: true });

  const parentSettled = buffer.record("btc-89m", [], {
    ownerToken: "parent-page",
    pending: false,
  });
  assert.equal(parentSettled.deferred, true);
  assert.equal(parentSettled.publish, false);
  assert.equal(buffer.hasOwner("btc-89m", "child-repair"), true);

  const wsCorrection = buffer.record("btc-89m", [
    { start: epochSeconds(900), end: epochSeconds(900), type: "mid-merge" },
  ]);
  assert.equal(wsCorrection.deferred, true);
  const childSettled = buffer.record("btc-89m", [], {
    ownerToken: "child-repair",
    pending: false,
  });
  assert.equal(childSettled.deferred, false);
  assert.equal(childSettled.publish, true);
  assert.deepEqual(childSettled.ranges, [
    { start: 800, end: 800, type: "mid-merge" },
    { start: 900, end: 900, type: "mid-merge" },
    { start: 600, end: 700, type: "prepend" },
  ]);
});

test("cancel and interval switch discard old ownership without crossing series", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  buffer.record("btc-89m", [
    { start: epochSeconds(600), end: epochSeconds(900), type: "prepend" },
  ], { ownerToken: "old-page", pending: true });
  buffer.record("btc-1h", [
    { start: epochSeconds(1_200), end: epochSeconds(1_500), type: "prepend" },
  ], { ownerToken: "new-page", pending: true });

  buffer.discard("btc-89m");
  assert.equal(buffer.hasPending("btc-89m"), false);
  const current = buffer.record("btc-1h", [], {
    ownerToken: "new-page",
    pending: false,
  });
  assert.deepEqual(current.ranges, [
    { start: 1_200, end: 1_500, type: "prepend" },
  ]);
  assert.equal(buffer.record("btc-89m", [
    { start: epochSeconds(2_000), end: epochSeconds(2_100), type: "prepend" },
  ]).ranges[0]?.start, 2_000);
});

test("89m initial 89→126→214→222 previews once, then publishes the final window once", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  const seriesKey = "binance:futures:BTCUSDT:89m";
  const parentOwner = "history-parent";
  const childOwner = "pending-gap-poll";
  const step = 89 * 60;
  const allBars: KlineBar[] = Array.from({ length: 222 }, (_, index) => ({
    time: epochSeconds(1_000_000 + index * step),
    close: index + 1,
  }));
  const hostedIndicators: IndicatorDefinition[] = [
    { id: "ma", engineName: "MA", params: { period: 20 } },
    { id: "ema", engineName: "EMA", params: { period: 20 } },
    { id: "boll", engineName: "BOLL", params: { period: 20 } },
    { id: "rsi", engineName: "RSI", params: { period: 14 } },
    { id: "macd", engineName: "MACD", params: { slow: 26, signal: 9 } },
    { id: "atr", engineName: "ATR", params: { period: 14 } },
    { id: "vol", engineName: "VOL" },
  ];
  const pendingInitial: PendingInitialSeries = {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "89m",
    indicatorWindowOwner: parentOwner,
    range: null,
  };
  const hydrationGate = createIndicatorInitialHydrationGate();
  const progressiveHydrationGate = createIndicatorInitialHydrationGate();
  const hydrationBatches: Array<{
    ids: string[];
    start: number;
    end: number;
    points: number;
    stage: "progressive" | "authoritative";
  }> = [];
  let chartData: KlineBar[] = [];
  let publishedUnions = 0;

  const maybeHydrate = (deferred: boolean) => {
    const range = resolveInitialHostedRange(
      chartData,
      hostedIndicators,
      { logical: { from: 132, to: 221 }, time: null },
    );
    assert.ok(range);
    const signature = "btc-89m|generation-2|seven-indicators";
    if (canStartIndicatorProgressiveHydration({
      chartDataLength: chartData.length,
      chartDataReady: chartData.length > 0,
      initialHistoryPending: deferred,
    })) {
      const progressiveIndicators = selectProgressiveHostedIndicators(hostedIndicators, range)
        .filter((indicator) => progressiveHydrationGate.begin(`${signature}|${indicator.id}`));
      if (progressiveIndicators.length === 0) return;
      hydrationBatches.push({
        ids: progressiveIndicators.map((indicator) => indicator.id),
        start: range.start,
        end: range.end,
        points: range.endIndex - range.startIndex + 1,
        stage: "progressive",
      });
      progressiveIndicators.forEach((indicator) => {
        progressiveHydrationGate.complete(`${signature}|${indicator.id}`);
      });
      return;
    }
    if (!canStartIndicatorInitialHydration({
      chartDataLength: chartData.length,
      chartDataReady: chartData.length > 0,
      historyWindowPending: deferred,
    }) || !hydrationGate.begin(signature)) return;
    hydrationBatches.push({
      ids: hostedIndicators.map((indicator) => indicator.id),
      start: range.start,
      end: range.end,
      points: range.endIndex - range.startIndex + 1,
      stage: "authoritative",
    });
    hydrationGate.complete(signature);
  };

  const publishCommit = (
    ownerToken: string,
    pending: boolean,
    previousBars: number,
    nextBars: number,
  ) => {
    chartData = allBars.slice(0, nextBars);
    const result = buffer.record(seriesKey, [{
      start: allBars[previousBars]?.time ?? allBars[0]!.time,
      end: allBars[nextBars - 1]!.time,
      type: "mid-merge",
    }], { ownerToken, pending });
    if (result.publish) publishedUnions += 1;
    maybeHydrate(result.deferred);
    return result;
  };

  const commitMergedChartData: CommitChartData = (
    _symbol,
    _interval,
    incoming,
    meta: FeedCommitMeta,
  ) => {
    assert.deepEqual(incoming, []);
    const result = buffer.record(seriesKey, [], {
      ownerToken: meta.indicatorWindowOwner ?? null,
      pending: meta.deferIndicatorWindow === true,
    });
    // Mirrors commitMergedChartData's empty-commit branch: React metadata is
    // updated only for an owner lifecycle change or a newly published union.
    if (result.lifecycleChanged || result.publish) {
      if (result.publish) publishedUnions += 1;
      maybeHydrate(result.deferred);
    }
  };

  assert.equal(publishCommit(parentOwner, true, 0, 89).deferred, true);
  assert.equal(publishCommit(childOwner, true, 89, 126).deferred, true);
  assert.equal(publishCommit(childOwner, true, 126, 214).deferred, true);
  assert.equal(
    publishCommit(childOwner, false, 214, 222).deferred,
    true,
    "the child repair cannot release the still-owned initial request",
  );
  assert.deepEqual(hydrationBatches, [
    {
      ids: ["ma", "boll", "rsi", "atr", "vol"],
      start: allBars[0]!.time,
      end: allBars[88]!.time,
      points: 89,
      stage: "progressive",
    },
    {
      ids: ["ema"],
      start: allBars[0]!.time,
      end: allBars[125]!.time,
      points: 126,
      stage: "progressive",
    },
    {
      ids: ["macd"],
      start: allBars[0]!.time,
      end: allBars[213]!.time,
      points: 214,
      stage: "progressive",
    },
  ], "each indicator previews once, as soon as its real backend warmup fits");

  assert.equal(releasePendingInitialIndicatorWindow(
    commitMergedChartData,
    pendingInitial,
    "initial-history-settled",
  ), true);
  assert.deepEqual(hydrationBatches.at(-1), {
    ids: ["ma", "ema", "boll", "rsi", "macd", "atr", "vol"],
    start: allBars[0]!.time,
    end: allBars[221]!.time,
    points: 222,
    stage: "authoritative",
  });
  assert.equal(hydrationBatches.length, 4);
  assert.equal(publishedUnions, 1);
  assert.equal(buffer.hasPending(seriesKey), false);

  releasePendingInitialIndicatorWindow(
    commitMergedChartData,
    pendingInitial,
    "initial-history-settled",
  );
  assert.equal(hydrationBatches.length, 4, "final release and hydration are idempotent");
  assert.equal(publishedUnions, 1, "the staged union is published exactly once");
});

test("stale initial settlement cannot republish after session cancellation", () => {
  const buffer = new IndicatorWindowCommitBuffer();
  const oldSeriesKey = "binance:futures:BTCUSDT:89m";
  const commits: FeedCommitMeta[] = [];
  buffer.record(oldSeriesKey, [{
    start: epochSeconds(1_000),
    end: epochSeconds(2_000),
    type: "mid-merge",
  }], { ownerToken: "old-owner", pending: true });
  buffer.discard(oldSeriesKey);

  releasePendingInitialIndicatorWindow(
    (_symbol, _interval, _rows, meta) => {
      const result = buffer.record(oldSeriesKey, [], {
        ownerToken: meta.indicatorWindowOwner ?? null,
        pending: meta.deferIndicatorWindow === true,
      });
      if (result.lifecycleChanged || result.publish) commits.push(meta);
    },
    {
      exchange: "binance",
      marketType: "futures",
      symbol: "BTCUSDT",
      interval: "89m",
      indicatorWindowOwner: "old-owner",
      range: null,
    },
    "initial-history-settled",
  );

  assert.deepEqual(commits, []);
  assert.equal(buffer.hasPending(oldSeriesKey), false);
});
