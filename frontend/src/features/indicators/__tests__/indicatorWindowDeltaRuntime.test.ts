import assert from "node:assert/strict";
import test from "node:test";

import {
  canExecuteHostedHistoricalFallback,
  canFlushHostedSeedCoverageRefresh,
  canRunHostedIndicatorStream,
  canStartIndicatorAutoRightCatchup,
  canStartIndicatorInitialHydration,
  canStartIndicatorProgressiveHydration,
  canStartIndicatorWindowHydration,
  bridgeIndicatorWindowDeltaToComputedCoverage,
  clampIndicatorWindowRangeToContinuousSegment,
  createIndicatorRangeEventSettlementBarrier,
  groupIndicatorWindowDeltaRefreshes,
  indicatorWindowCorrectionCoalesceDelay,
  planIndicatorWindowDeltaRequest,
  planIndicatorWindowDeltaRefreshes,
  reconcileConsumedIndicatorRangeRequestIds,
  requiresIndicatorWindowDeltaRightCascade,
} from "../indicatorWindowDeltaRuntime.js";
import {
  buildIndicatorInitialHydrationSignature,
  buildIndicatorRangeRefreshSignature,
  createCompletedIndicatorRangeRequestLedger,
  createDeferredIndicatorRangeWaitRegistry,
  createIndicatorInitialHydrationGate,
  createKeyedIndicatorRetryTimers,
  mergePendingIndicatorCorrection,
} from "../indicatorRangeRequestDedupe.js";
import type { IndicatorRangeEvent } from "../../market-data/klineContracts.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import type { IndicatorDefinition } from "../indicatorTypes.js";
import { epochSeconds, mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

function rangeEvent(
  reason: string,
  start: number,
  end: number,
): IndicatorRangeEvent {
  return structuralMock<IndicatorRangeEvent>({
    id: 1,
    sessionKey: "session",
    interval: "91m",
    reason,
    start,
    end,
    createdAt: 1,
  });
}

function indicator(
  id: string,
  engineName?: string,
  params?: IndicatorDefinition["params"],
): IndicatorDefinition {
  return {
    id,
    ...(engineName ? { engineName } : {}),
    ...(params ? { params } : {}),
  };
}

test("prepend requests only the newly covered range without invalidating history", () => {
  assert.deepEqual(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-prepend", 600, 900),
      { start: 1_200, end: 2_400 },
    ),
    {
      cascadeRight: false,
      invalidateRange: null,
      requestRange: { start: 600, end: 900 },
    },
  );
});

test("new window deltas wait briefly so matching WS corrections can own the refresh", () => {
  const request = {
    ...rangeEvent("window-prepend", 600, 900),
    createdAt: 10_000,
  };
  assert.equal(indicatorWindowCorrectionCoalesceDelay(request, 10_100, 250), 150);
  assert.equal(indicatorWindowCorrectionCoalesceDelay(request, 10_250, 250), 0);
  assert.equal(indicatorWindowCorrectionCoalesceDelay(
    { ...request, reason: "manual-range" },
    10_100,
    250,
  ), 0);
  assert.equal(indicatorWindowCorrectionCoalesceDelay(
    { ...request, createdAt: Number.NaN },
    10_100,
    250,
  ), 0);
});

test("initial owner settlement bypasses event debounce so initial-visible can join its microtask", () => {
  const request = {
    ...rangeEvent("window-mid-merge", 600, 900),
    createdAt: 10_000,
    initialSettlementRelease: true,
  };

  assert.equal(indicatorWindowCorrectionCoalesceDelay(request, 10_001, 250), 0);
  assert.equal(
    indicatorWindowCorrectionCoalesceDelay(
      { ...request, initialSettlementRelease: false },
      10_001,
      250,
    ),
    249,
  );
});

test("mid-window refresh bridges a repaired prefix to progressive computed coverage", () => {
  assert.deepEqual(
    bridgeIndicatorWindowDeltaToComputedCoverage(
      { start: 100, end: 180 },
      { start: 100, end: 600 },
      [{ start: 400, end: 600 }],
    ),
    { start: 100, end: 400 },
  );
  assert.deepEqual(
    bridgeIndicatorWindowDeltaToComputedCoverage(
      { start: 500, end: 600 },
      { start: 100, end: 600 },
      [{ start: 100, end: 300 }],
    ),
    { start: 300, end: 600 },
  );
  assert.deepEqual(
    bridgeIndicatorWindowDeltaToComputedCoverage(
      { start: 100, end: 180 },
      { start: 100, end: 300 },
      [{ start: 400, end: 600 }],
    ),
    { start: 100, end: 180 },
  );
});

test("mid-merge invalidates the exact dirty range and refreshes only the visible suffix", () => {
  assert.deepEqual(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-mid-merge", 1_500, 1_800),
      { start: 1_200, end: 2_400 },
    ),
    {
      cascadeRight: true,
      invalidateRange: { start: 1_500, end: 1_800 },
      requestRange: { start: 1_500, end: 2_400 },
    },
  );
  assert.deepEqual(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-mid-merge", 600, 900),
      { start: 1_200, end: 2_400 },
    )?.requestRange,
    { start: 1_200, end: 2_400 },
  );
});

test("mid-merge outside the visible right edge is invalidated and deferred until pan", () => {
  assert.deepEqual(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-mid-merge", 3_000, 3_300),
      { start: 1_200, end: 2_400 },
    ),
    {
      cascadeRight: true,
      invalidateRange: { start: 3_000, end: 3_300 },
      requestRange: null,
    },
  );
});

test("mid-merge falls back to its exact dirty range before a visible range exists", () => {
  assert.deepEqual(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-mid-merge", 1_500, 1_800),
      null,
    )?.requestRange,
    { start: 1_500, end: 1_800 },
  );
});

test("pointwise VOL only invalidates and refreshes the intersecting dirty bars", () => {
  const dirty = rangeEvent("window-mid-merge", 1_500, 1_800);
  assert.equal(requiresIndicatorWindowDeltaRightCascade(indicator("vol", "VOL")), false);
  assert.equal(requiresIndicatorWindowDeltaRightCascade(indicator("boll", "BOLL")), false);
  assert.equal(requiresIndicatorWindowDeltaRightCascade(indicator("ema", "EMA")), true);
  assert.equal(requiresIndicatorWindowDeltaRightCascade(indicator("custom")), true);

  assert.deepEqual(
    planIndicatorWindowDeltaRequest(dirty, { start: 1_200, end: 2_400 }, {
      cascadeRight: false,
    }),
    {
      cascadeRight: false,
      invalidateRange: { start: 1_500, end: 1_800 },
      requestRange: { start: 1_500, end: 1_800 },
    },
  );
  assert.equal(
    planIndicatorWindowDeltaRequest(
      rangeEvent("window-mid-merge", 600, 900),
      { start: 1_200, end: 2_400 },
      { cascadeRight: false },
    )?.requestRange,
    null,
  );
});

test("89m mid-merge bounds MA and BOLL while recursive EMA cascades right", () => {
  const step = 89 * 60;
  const start = 1_700_000_000;
  const dirtyEnd = start + step * 9;
  const desiredEnd = dirtyEnd + step * 100;
  const refreshes = planIndicatorWindowDeltaRefreshes(
    rangeEvent("window-mid-merge", start, dirtyEnd),
    { start: start - step * 10, end: desiredEnd },
    [
      indicator("vol", "VOL"),
      indicator("boll", "BOLL", { period: 20 }),
      indicator("ma", "MA", { period: 20 }),
      indicator("ema", "EMA", { period: 20 }),
    ],
    "89m",
  );
  assert.deepEqual(
    refreshes.map(({ indicator: current, plan }) => ({
      id: current.id,
      cascadeRight: plan.cascadeRight,
      requestRange: plan.requestRange,
    })),
    [
      {
        id: "vol",
        cascadeRight: false,
        requestRange: { start, end: dirtyEnd },
      },
      {
        id: "boll",
        cascadeRight: false,
        requestRange: { start, end: dirtyEnd + step * 19 },
      },
      {
        id: "ma",
        cascadeRight: false,
        requestRange: { start, end: dirtyEnd + step * 19 },
      },
      {
        id: "ema",
        cascadeRight: true,
        requestRange: { start, end: desiredEnd },
      },
    ],
  );
  assert.deepEqual(
    groupIndicatorWindowDeltaRefreshes(refreshes),
    [
      {
        indicatorIds: ["vol"],
        range: { start, end: dirtyEnd },
      },
      {
        indicatorIds: ["boll", "ma"],
        range: { start, end: dirtyEnd + step * 19 },
      },
      {
        indicatorIds: ["ema"],
        range: { start, end: desiredEnd },
      },
    ],
  );
});

test("89m recursive refresh never bridges a retained K-line hole", () => {
  const step = 89 * 60;
  const start = 1_700_000_000;
  const chartData = [
    ...Array.from({ length: 4 }, (_, index) => start + index * step),
    ...Array.from({ length: 4 }, (_, index) => start + step * (20 + index)),
  ].map((time): KlineBar => ({
    time: epochSeconds(time),
    open: 1,
    high: 2,
    low: 0,
    close: 1,
    volume: 1,
  }));
  const dirty = rangeEvent("window-mid-merge", start + step, start + step * 2);
  const desired = { start, end: start + step * 23 };

  assert.deepEqual(
    clampIndicatorWindowRangeToContinuousSegment(dirty, desired, chartData, "89m"),
    { start, end: start + step * 3 },
  );
  assert.deepEqual(
    planIndicatorWindowDeltaRefreshes(
      dirty,
      desired,
      [indicator("ema", "EMA", { period: 20 })],
      "89m",
      chartData,
    )[0]?.plan.requestRange,
    { start: start + step, end: start + step * 3 },
  );
});

test("range event is consumed only after every hosted target settles successfully", () => {
  const events: string[] = [];
  const settle = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["boll", "vol"],
    onFailure: () => events.push("retry"),
    onSuccess: () => events.push("consume"),
  });

  settle(true, { indicatorId: "boll" });
  assert.deepEqual(events, []);
  settle(true, { indicatorId: "vol" });
  assert.deepEqual(events, ["consume"]);
  settle(true, { indicatorId: "vol" });
  assert.deepEqual(events, ["consume"]);
});

test("any failed hosted target retains the event for retry", () => {
  const events: string[] = [];
  const settle = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["boll", "vol"],
    onFailure: () => events.push("retry"),
    onSuccess: () => events.push("consume"),
  });

  settle(true, { indicatorId: "boll" });
  settle(false, { indicatorId: "vol" });
  settle(true, { indicatorId: "vol" });
  assert.deepEqual(events, ["retry"]);
});

test("initial owner waits for every target before releasing a terminal failure", () => {
  const events: string[] = [];
  const settle = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["bad-script", "ema", "vol"],
    onFailure: () => events.push("release-stream-and-retry"),
    onSuccess: () => events.push("complete"),
    waitForAllTargetsOnFailure: true,
  });

  settle(false, { indicatorId: "bad-script" });
  assert.deepEqual(events, [], "one fast failure must not overlap the remaining initial HTTP work");
  settle(true, { indicatorId: "ema" });
  assert.deepEqual(events, []);
  settle(true, { indicatorId: "vol" });
  assert.deepEqual(events, ["release-stream-and-retry"]);
});

test("a deferred target keeps ownership even when another initial target fails terminally", () => {
  const failures: Record<string, unknown>[] = [];
  const settle = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["bad-script", "ema"],
    onFailure: (detail) => { failures.push(detail); },
    onSuccess: () => assert.fail("mixed failure must not complete"),
    waitForAllTargetsOnFailure: true,
  });

  settle(false, { indicatorId: "bad-script" });
  settle(false, { indicatorId: "ema", deferred: true });
  assert.equal(failures[0]?.deferred, true);
});

test("failed target forwards deferred settlement detail without a timer fallback", () => {
  const failures: Record<string, unknown>[] = [];
  const settle = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["ema"],
    onFailure: (detail) => failures.push(detail),
    onSuccess: () => assert.fail("deferred target must not consume the event"),
  });
  settle(false, { indicatorId: "ema", deferred: true });
  assert.deepEqual(failures, [{ indicatorId: "ema", deferred: true }]);
});

test("NOT_READY wait releases only for a newer overlapping event or meaningful revision", () => {
  const waits = createDeferredIndicatorRangeWaitRegistry(2);
  const base = {
    seriesKey: "session|binance|spot|BTCUSDT|89m",
    targetKey: "ema-config",
    range: { start: 1_000, end: 2_000 },
    revision: { serverEpoch: "boot-1", correctionRevision: 3, closedThrough: 2_000 },
    afterEventId: 10,
  };
  assert.equal(waits.block(base), true);
  assert.equal(waits.blocks({
    ...base,
    range: { start: 1_500, end: 1_600 },
    revision: { ...base.revision, closedThrough: 3_000 },
  }), true);
  assert.equal(waits.releaseForEvents(base.seriesKey, [
    { id: 10, start: 1_000, end: 2_000 },
    { id: 11, start: 3_000, end: 4_000 },
  ]), 0);
  assert.equal(waits.size, 1);
  assert.equal(waits.releaseForEvents(base.seriesKey, [
    { id: 11, start: 1_500, end: 1_600 },
  ]), 1);
  assert.equal(waits.releaseForEvents(base.seriesKey, [
    { id: 12, start: 1_500, end: 1_600 },
  ]), 0);

  waits.block(base);
  assert.equal(waits.releaseForRevision(base.seriesKey, {
    ...base.revision,
    closedThrough: 9_999,
  }), 0);
  assert.equal(waits.releaseForRevision(base.seriesKey, {
    ...base.revision,
    correctionRevision: 4,
  }), 1);
  assert.equal(waits.size, 0);
});

test("NOT_READY wait registry remains bounded", () => {
  const waits = createDeferredIndicatorRangeWaitRegistry(2);
  for (const index of [1, 2, 3]) {
    waits.block({
      seriesKey: "btc-1m",
      targetKey: `indicator-${index}`,
      range: { start: index * 100, end: index * 100 + 60 },
      revision: { correctionRevision: 1 },
      afterEventId: index,
    });
  }
  assert.equal(waits.size, 2);
  assert.equal(waits.blocks({
    seriesKey: "btc-1m",
    targetKey: "indicator-1",
    range: { start: 100, end: 160 },
    revision: { correctionRevision: 1 },
  }), false);
});

test("range refresh signature ignores closed-through drift but tracks real corrections", () => {
  const base = {
    seriesKey: "session|binance|spot|BTCUSDT|89m",
    requestScope: "chart:1",
    requestGeneration: 7,
    targetKey: "ma-config-v1",
    requestRange: { start: 1_000, end: 2_000 },
    invalidateRange: { start: 900, end: 2_000 },
    cascadeRight: false,
  };
  const closed180 = buildIndicatorRangeRefreshSignature({
    ...base,
    revision: {
      serverEpoch: "boot-1",
      correctionRevision: 3,
      closedThrough: 180,
    },
  });
  const closed240 = buildIndicatorRangeRefreshSignature({
    ...base,
    revision: {
      serverEpoch: "boot-1",
      correctionRevision: 3,
      closedThrough: 240,
    },
  });
  assert.equal(closed180, closed240);
  assert.notEqual(closed180, buildIndicatorRangeRefreshSignature({
    ...base,
    revision: {
      serverEpoch: "boot-1",
      correctionRevision: 4,
      closedThrough: 240,
    },
  }));
  assert.notEqual(closed180, buildIndicatorRangeRefreshSignature({
    ...base,
    revision: {
      serverEpoch: "boot-2",
      correctionRevision: 3,
      closedThrough: 240,
    },
  }));
  assert.notEqual(closed180, buildIndicatorRangeRefreshSignature({
    ...base,
    revision: {
      serverEpoch: "boot-1",
      correctionRevision: 3,
      token: "real-correction-token",
      closedThrough: 240,
    },
  }));
});

test("range refresh signature isolates demand, config, range, and invalidation semantics", () => {
  const base = {
    seriesKey: "session|binance|spot|BTCUSDT|89m",
    requestScope: "chart:1",
    requestGeneration: 7,
    targetKey: "ma-config-v1",
    requestRange: { start: 1_000, end: 2_000 },
    revision: { correctionRevision: 3 },
  };
  const signature = buildIndicatorRangeRefreshSignature(base);
  assert.notEqual(signature, buildIndicatorRangeRefreshSignature({
    ...base,
    requestGeneration: 8,
  }));
  assert.notEqual(signature, buildIndicatorRangeRefreshSignature({
    ...base,
    requestScope: "chart:2",
  }));
  assert.notEqual(signature, buildIndicatorRangeRefreshSignature({
    ...base,
    targetKey: "ma-config-v2",
  }));
  assert.notEqual(signature, buildIndicatorRangeRefreshSignature({
    ...base,
    requestRange: { start: 911, end: 2_000 },
  }));
  assert.notEqual(signature, buildIndicatorRangeRefreshSignature({
    ...base,
    invalidateRange: { start: 1_000, end: 1_100 },
    cascadeRight: true,
  }));
});

test("completed request ledger suppresses only successes and remains bounded", () => {
  const ledger = createCompletedIndicatorRangeRequestLedger(2);
  assert.equal(ledger.has("failed"), false);
  // A failed/aborted request never calls remember, so it remains retryable.
  assert.equal(ledger.has("failed"), false);
  ledger.remember("one");
  ledger.remember("two");
  assert.equal(ledger.has("one"), true);
  ledger.remember("three");
  assert.equal(ledger.has("one"), false);
  assert.equal(ledger.has("two"), true);
  ledger.forget("two");
  assert.equal(ledger.has("two"), false);
  ledger.clear();
  assert.equal(ledger.size, 0);
});

test("initial hydration signature is stable across prepend range growth", () => {
  const base = {
    seriesKey: "session|binance|spot|BTCUSDT|1h",
    requestScope: "chart:1",
    requestGeneration: 11,
    targetKeys: ["ema-config", "ma-config"],
  };
  const beforePrepend = buildIndicatorInitialHydrationSignature(base);
  const afterPrepend = buildIndicatorInitialHydrationSignature({
    ...base,
    targetKeys: ["ma-config", "ema-config"],
  });
  assert.equal(beforePrepend, afterPrepend);
  assert.notEqual(beforePrepend, buildIndicatorInitialHydrationSignature({
    ...base,
    requestGeneration: 12,
  }));
  assert.notEqual(beforePrepend, buildIndicatorInitialHydrationSignature({
    ...base,
    targetKeys: ["ema-config", "ma-config-v2"],
  }));
});

test("initial hydration completes only after every target succeeds and failures reopen", () => {
  const gate = createIndicatorInitialHydrationGate();
  assert.equal(gate.begin("initial"), true);
  assert.equal(gate.begin("initial"), false);
  const successful = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["ma", "ema"],
    onFailure: () => gate.release("initial"),
    onSuccess: () => gate.complete("initial"),
  });
  successful(true, { indicatorId: "ma" });
  assert.equal(gate.isPending("initial"), true);
  assert.equal(gate.isCompleted("initial"), false);
  successful(true, { indicatorId: "ema" });
  assert.equal(gate.isPending("initial"), false);
  assert.equal(gate.isCompleted("initial"), true);

  assert.equal(gate.begin("retryable"), true);
  const failed = createIndicatorRangeEventSettlementBarrier({
    indicatorIds: ["ma", "ema"],
    onFailure: () => gate.release("retryable"),
    onSuccess: () => gate.complete("retryable"),
  });
  failed(true, { indicatorId: "ma" });
  failed(false, { indicatorId: "ema", stale: true });
  assert.equal(gate.isPending("retryable"), false);
  assert.equal(gate.isCompleted("retryable"), false);
  assert.equal(gate.begin("retryable"), true);
});

test("initial hydration cannot NOT_READY on a partial window and terminal-empty wakes it once", () => {
  const gate = createIndicatorInitialHydrationGate();
  const attempt = (historyWindowPending: boolean, signature = "btc-89m") => (
    canStartIndicatorInitialHydration({
      chartDataLength: 7,
      chartDataReady: true,
      historyWindowPending,
    }) && gate.begin(signature)
  );

  assert.equal(attempt(true), false, "partial REPLACE must not start the all-indicator request");
  assert.equal(gate.isPending("btc-89m"), false, "there is no partial request to become NOT_READY");
  assert.equal(attempt(false), true, "an empty settled/terminal commit changes only pending state");
  assert.equal(attempt(false), false, "the final request is owned exactly once");
  gate.complete("btc-89m");
  assert.equal(attempt(false), false);

  gate.clear();
  assert.equal(attempt(true, "eth-1h"), false, "cancelled old history cannot arm the new session");
  assert.equal(attempt(false, "eth-1h"), true);
});

test("progressive hydration starts only for a ready partial window", () => {
  assert.equal(canStartIndicatorProgressiveHydration({
    chartDataLength: 89,
    chartDataReady: true,
    initialHistoryPending: true,
  }), true);
  assert.equal(canStartIndicatorProgressiveHydration({
    chartDataLength: 0,
    chartDataReady: true,
    initialHistoryPending: true,
  }), false);
  assert.equal(canStartIndicatorProgressiveHydration({
    chartDataLength: 89,
    chartDataReady: false,
    initialHistoryPending: true,
  }), false);
  assert.equal(canStartIndicatorProgressiveHydration({
    chartDataLength: 222,
    chartDataReady: true,
    initialHistoryPending: false,
  }), false, "the settled window belongs to authoritative initial hydration");
});

test("hosted stream waits for the settled initial owner and stays open during later prepends", () => {
  const canStream = (initialHydrationSettled: boolean, streamStartedForSeries: boolean) => (
    canRunHostedIndicatorStream({
      chartDataReady: true,
      initialHydrationSettled,
      streamStartedForSeries,
    })
  );

  for (const partialLength of [89, 126, 214]) {
    assert.equal(
      canStream(false, false),
      false,
      `${partialLength} partial bars must not start hosted subscriptions`,
    );
  }
  assert.equal(canStream(false, false), false, "222 final bars still belong to initial-visible");
  assert.equal(canStream(true, false), true, "success or terminal failure releases realtime");
  assert.equal(
    canStream(false, true),
    true,
    "a later left-load keeps the already-started per-series socket open",
  );
  assert.equal(
    canRunHostedIndicatorStream({
      chartDataReady: false,
      initialHydrationSettled: true,
      streamStartedForSeries: true,
    }),
    false,
  );
});

test("WS historical fallback and seed refresh remain retained through a partial window", () => {
  assert.equal(canExecuteHostedHistoricalFallback({
    historyWindowPending: true,
    initialHydrationSettled: true,
  }), false);
  assert.equal(canExecuteHostedHistoricalFallback({
    historyWindowPending: false,
    initialHydrationSettled: false,
  }), false);
  assert.equal(canExecuteHostedHistoricalFallback({
    historyWindowPending: false,
    initialHydrationSettled: true,
  }), true);

  for (const partialLength of [89, 126, 214]) {
    assert.equal(canFlushHostedSeedCoverageRefresh({
      acknowledged: true,
      historyWindowPending: true,
      refreshPending: true,
    }), false, `${partialLength} partial bars must not force a seed wave`);
  }
  assert.equal(canFlushHostedSeedCoverageRefresh({
    acknowledged: true,
    historyWindowPending: false,
    refreshPending: true,
  }), true, "the final 222-bar commit releases one retained refresh");
  assert.equal(canFlushHostedSeedCoverageRefresh({
    acknowledged: false,
    historyWindowPending: false,
    refreshPending: true,
  }), false);
});

test("visible-range hydration waits through 89→126→214 and wakes only for the final 222 window", () => {
  const gate = createIndicatorInitialHydrationGate();
  const requestedWindows: number[] = [];
  const attempt = (chartDataLength: number, historyWindowPending: boolean) => {
    if (!canStartIndicatorWindowHydration({ chartDataLength, historyWindowPending })) return false;
    if (!gate.begin("btc-89m-visible-range")) return false;
    requestedWindows.push(chartDataLength);
    gate.complete("btc-89m-visible-range");
    return true;
  };

  assert.equal(attempt(89, true), false);
  assert.equal(attempt(126, true), false);
  assert.equal(attempt(214, true), false);
  assert.equal(attempt(222, false), true);
  assert.equal(attempt(222, false), false);
  assert.deepEqual(requestedWindows, [222]);
});

test("auto-right cannot race retained lines during partial or final initial hydration", () => {
  const canCatchUp = (
    chartDataLength: number,
    historyWindowPending: boolean,
    initialHydrationPending: boolean,
  ) => canStartIndicatorAutoRightCatchup({
    chartDataLength,
    chartDataReady: chartDataLength > 0,
    historyWindowPending,
    initialHydrationPending,
  });

  assert.equal(canCatchUp(89, true, false), false);
  assert.equal(canCatchUp(126, true, false), false);
  assert.equal(canCatchUp(214, true, false), false);
  assert.equal(
    canCatchUp(222, false, true),
    false,
    "the accepted final initial-visible batch owns right-edge hydration",
  );
  assert.equal(
    canCatchUp(222, false, false),
    true,
    "auto-right resumes only after no initial hydration owns the window",
  );
});

test("consumed indicator event ids are bounded and reclaimed with the active queue/session", () => {
  const consumed = new Set([1, 2, 3, 4, 5]);
  const requests = [1, 2, 3, 4, 5].map((id) => structuralMock<IndicatorRangeEvent>({
    ...rangeEvent("window-prepend", id, id),
    id,
    sessionKey: "current",
  }));
  reconcileConsumedIndicatorRangeRequestIds(consumed, requests, "current", 3);
  assert.deepEqual([...consumed], [3, 4, 5]);

  reconcileConsumedIndicatorRangeRequestIds(consumed, requests.slice(-1), "current", 3);
  assert.deepEqual([...consumed], [5]);
  reconcileConsumedIndicatorRangeRequestIds(consumed, requests, "next-session", 3);
  assert.equal(consumed.size, 0);
});

test("correction queue merges dirty history while retaining the newest revision on retry", () => {
  const revision1 = {
    indicatorId: "ema",
    seriesKey: "btc-1h",
    targetKey: "ema-config",
    dirtyRange: { start: 1_000, end: 2_000 },
    revision: { correctionRevision: "1" },
  };
  const revision2 = {
    ...revision1,
    dirtyRange: { start: 500, end: 900 },
    revision: { correctionRevision: "2" },
  };
  const newest = mergePendingIndicatorCorrection(revision1, revision2);
  assert.deepEqual(newest.dirtyRange, { start: 500, end: 2_000 });
  assert.equal(newest.revision?.correctionRevision, "2");

  const failedOldRequest = {
    ...revision1,
    dirtyRange: { start: 2_100, end: 2_200 },
  };
  const retried = mergePendingIndicatorCorrection(newest, failedOldRequest, true);
  assert.deepEqual(retried.dirtyRange, { start: 500, end: 2_200 });
  assert.equal(retried.revision?.correctionRevision, "2");
});

test("initial retry timers are isolated by signature across session races", () => {
  type Timer = ReturnType<typeof setTimeout>;
  const callbacks = new Map<Timer, () => void>();
  const cancelled = new Set<Timer>();
  const timers = createKeyedIndicatorRetryTimers({
    cancelTimer: (timer) => { cancelled.add(timer); },
    setTimer: (callback) => {
      const timer = structuralMock<Timer>({});
      callbacks.set(timer, callback);
      return timer;
    },
  });
  const fired: string[] = [];
  timers.schedule("session-a", () => fired.push("a-old"), 500);
  const oldA = Array.from(callbacks.keys())[0];
  timers.schedule("session-b", () => fired.push("b"), 500);
  const timerB = Array.from(callbacks.keys())[1];
  timers.schedule("session-a", () => fired.push("a-new"), 500);
  const newA = Array.from(callbacks.keys())[2];

  assert.equal(cancelled.has(mustBeDefined(oldA)), true);
  assert.equal(cancelled.has(mustBeDefined(timerB)), false);
  mustBeDefined(callbacks.get(mustBeDefined(oldA)))();
  assert.deepEqual(fired, []);
  mustBeDefined(callbacks.get(mustBeDefined(timerB)))();
  assert.deepEqual(fired, ["b"]);
  assert.equal(timers.has("session-a"), true);
  mustBeDefined(callbacks.get(mustBeDefined(newA)))();
  assert.deepEqual(fired, ["b", "a-new"]);
  assert.equal(timers.size, 0);
});
