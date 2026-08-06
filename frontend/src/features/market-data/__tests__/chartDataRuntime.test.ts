import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredWarmChartPublicationStillOwnsTarget,
  detectGaps,
  inheritChartHistoryProof,
  klineRowsEqual,
  pendingWarmPublicationMatchesCommit,
  resolvePatchedChartDataStatus,
  seriesCommitOwnsActiveChart,
  shouldAdoptSharedSeriesSnapshot,
  shouldDeferWarmChartPublication,
} from "../chartDataRuntime.js";
import { epochSeconds } from "../../../test/testHelpers.js";
import { shouldStartActiveHistoryHydration } from "../useActiveChartHistoryHydration.js";

test("realtime commits inherit monotonic history proof from the series registry", () => {
  const viewportProof = inheritChartHistoryProof({
    historyComplete: true,
    historyRepairPending: false,
    historyValidatedCountBack: 500,
    lastValidatedMs: 100,
  });
  assert.deepEqual(viewportProof, {
    historyComplete: true,
    historyRepairPending: false,
    historyValidatedCountBack: 500,
    lastValidatedMs: 100,
  });

  const hydrationProof = inheritChartHistoryProof(viewportProof, {
    historyValidatedCountBack: 1_500,
    lastValidatedMs: 200,
  });
  assert.deepEqual(hydrationProof, {
    historyComplete: true,
    historyRepairPending: false,
    historyValidatedCountBack: 1_500,
    lastValidatedMs: 200,
  });
  const shouldStart = (meta: Record<string, unknown>) => shouldStartActiveHistoryHydration({
    enabled: true,
    historyComplete: meta.historyComplete === true,
    historyRepairPending: meta.historyRepairPending === true,
    viewportCountBack: 500,
    targetCountBack: 1_500,
    validatedCountBack: Number(meta.historyValidatedCountBack),
  });
  assert.equal(shouldStart(viewportProof), true, "an append must not abort pending hydration");
  assert.equal(shouldStart(hydrationProof), false, "an append must not restart completed hydration");

  assert.deepEqual(inheritChartHistoryProof({
    historyComplete: "yes",
    historyRepairPending: false,
    historyValidatedCountBack: "damaged",
    lastValidatedMs: -1,
  }), {
    historyComplete: false,
    historyRepairPending: false,
    historyValidatedCountBack: null,
    lastValidatedMs: null,
  });
});

test("detectGaps reports internal K-line gaps", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1240) },
  ], 60);

  assert.deepEqual(gaps, [{
    from: 1060,
    to: 1240,
    missingBars: 2,
  }]);
});

test("detectGaps does not infer tail gaps from Date.now by default", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1120) },
  ], 60);

  assert.deepEqual(gaps, []);
});

test("detectGaps can report an explicit tail gap when a current time is supplied", () => {
  const gaps = detectGaps([
    { time: epochSeconds(1000) },
    { time: epochSeconds(1060) },
    { time: epochSeconds(1120) },
  ], 60, { includeTailGap: true, nowSecs: 1600 });

  assert.deepEqual(gaps, [{
    from: 1120,
    to: 1600,
    missingBars: 8,
    isTailGap: true,
  }]);
});

test("klineRowsEqual compares rows by value instead of array identity", () => {
  assert.equal(
    klineRowsEqual(
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    ),
    true,
  );

  assert.equal(
    klineRowsEqual(
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.6, volume: 10 }],
    ),
    false,
  );

  assert.equal(klineRowsEqual({ length: 0 }, { length: 0 }), false);
  assert.equal(klineRowsEqual([{}], [null]), false);
});

test("a logical chart adopts rows committed first by another shared-store consumer", () => {
  const sharedRows = [{
    time: epochSeconds(1000),
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  }];
  assert.equal(shouldAdoptSharedSeriesSnapshot({
    currentRows: [],
    ownsActiveSeries: true,
    sharedRows,
  }), true);
  assert.equal(shouldAdoptSharedSeriesSnapshot({
    currentRows: sharedRows,
    ownsActiveSeries: true,
    sharedRows,
  }), false, "the owning consumer must not republish an identical snapshot");
  assert.equal(shouldAdoptSharedSeriesSnapshot({
    currentRows: [],
    ownsActiveSeries: false,
    sharedRows,
  }), false, "a stale series may never adopt the shared active snapshot");
});

test("latest and history response order always settles at ready", () => {
  const latestFirst = resolvePatchedChartDataStatus("initial-latest", undefined);
  assert.equal(latestFirst, "provisional");
  assert.equal("ready", "ready", "history promotes a provisional latest seed to ready");

  const historyFirst = "ready";
  assert.equal(
    resolvePatchedChartDataStatus("initial-latest", historyFirst),
    "ready",
    "a later forming-bar patch must not downgrade completed history",
  );
});

test("only the exact current series may publish an async cache commit to the chart", () => {
  const active = "binance:futures:ETHUSDT:3m";
  assert.equal(seriesCommitOwnsActiveChart(active, active), true);
  assert.equal(
    seriesCommitOwnsActiveChart("binance:futures:BTCUSDT:3m", active),
    false,
  );
  assert.equal(seriesCommitOwnsActiveChart(null, active), false);
  assert.equal(seriesCommitOwnsActiveChart(active, null), false);
});

test("only a complete same-product warm interval transition defers chart publication", () => {
  const targetSeriesKey = "binance-futures-BTCUSDT-3m";
  const expectedPreviousSeriesKey = "binance-futures-BTCUSDT-1m";
  const currentMeta = {
    version: 7,
    optimistic: true,
    seriesKey: expectedPreviousSeriesKey,
    symbol: "BTCUSDT",
    interval: "1m",
    targetSeriesKey,
    targetSymbol: "BTCUSDT",
    targetInterval: "3m",
  };
  const base = {
    currentMeta,
    expectedPreviousSeriesKey,
    historyComplete: true,
    historyRepairPending: false,
    source: "memory-cache-hit",
    targetInterval: "3m",
    targetSeriesKey,
    targetSymbol: "BTCUSDT",
  };

  assert.equal(shouldDeferWarmChartPublication(base), true);
  assert.equal(shouldDeferWarmChartPublication({
    ...base,
    targetSymbol: "ETHUSDT",
  }), false, "cross-symbol publication stays synchronous");
  assert.equal(shouldDeferWarmChartPublication({
    ...base,
    expectedPreviousSeriesKey: "binance-spot-BTCUSDT-1m",
  }), false, "cross-market publication stays synchronous");
  assert.equal(shouldDeferWarmChartPublication({
    ...base,
    currentMeta: { ...currentMeta, interval: "3m" },
  }), false, "same-interval publication stays synchronous");
  assert.equal(shouldDeferWarmChartPublication({
    ...base,
    historyRepairPending: true,
  }), false, "repair-pending data stays synchronous and loading");
  assert.equal(shouldDeferWarmChartPublication({
    ...base,
    source: "watchlist-cache-hit",
  }), false, "other cache sources keep their existing publication semantics");
});

test("deferred warm publication rejects a stale A-to-B task after B-to-A", () => {
  const storeB = {};
  const storeA = {};
  const targetB = "binance-futures-BTCUSDT-3m";
  const targetA = "binance-futures-BTCUSDT-1m";

  assert.equal(deferredWarmChartPublicationStillOwnsTarget({
    activeSeriesKey: targetB,
    currentMeta: {
      version: 8,
      optimistic: true,
      targetSeriesKey: targetB,
    },
    registeredStore: storeB,
    targetSeriesKey: targetB,
    targetStore: storeB,
    transitionVersion: 8,
  }), true);

  const returnedToA = {
    version: 9,
    optimistic: true,
    targetSeriesKey: targetA,
  };
  assert.equal(deferredWarmChartPublicationStillOwnsTarget({
    activeSeriesKey: targetA,
    currentMeta: returnedToA,
    registeredStore: storeB,
    targetSeriesKey: targetB,
    targetStore: storeB,
    transitionVersion: 8,
  }), false);
  assert.equal(deferredWarmChartPublicationStillOwnsTarget({
    activeSeriesKey: targetA,
    currentMeta: returnedToA,
    registeredStore: storeA,
    targetSeriesKey: targetA,
    targetStore: storeA,
    transitionVersion: 9,
  }), true);
});

test("a terminal commit consumes only its exact pending warm publication", () => {
  const target = "binance-futures-BTCUSDT-3m";
  const stale = "binance-futures-BTCUSDT-1m";
  const targetStore = {};
  const staleStore = {};

  assert.equal(pendingWarmPublicationMatchesCommit({
    activeSeriesKey: target,
    pendingSeriesKey: target,
    pendingStore: targetStore,
    targetSeriesKey: target,
    targetStore,
  }), true);
  assert.equal(pendingWarmPublicationMatchesCommit({
    activeSeriesKey: stale,
    pendingSeriesKey: target,
    pendingStore: targetStore,
    targetSeriesKey: target,
    targetStore,
  }), false, "a B-to-A return cannot flush the stale B task");
  assert.equal(pendingWarmPublicationMatchesCommit({
    activeSeriesKey: target,
    pendingSeriesKey: target,
    pendingStore: staleStore,
    targetSeriesKey: target,
    targetStore,
  }), false, "a replaced store cannot be published by an older task");

  let pending: { key: string; store: object } | null = { key: target, store: targetStore };
  let publications = 0;
  const flushBeforeCommit = () => {
    if (!pendingWarmPublicationMatchesCommit({
      activeSeriesKey: target,
      pendingSeriesKey: pending?.key ?? null,
      pendingStore: pending?.store,
      targetSeriesKey: target,
      targetStore,
    })) return;
    pending = null;
    publications += 1;
  };
  flushBeforeCommit();
  flushBeforeCommit();
  assert.equal(publications, 1, "empty/NOOP proof publishes the target store exactly once");
});
