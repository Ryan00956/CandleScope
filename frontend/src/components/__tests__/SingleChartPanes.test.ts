import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisibleRangeSnapshot,
  disposeChartPaneSurface,
  hasCurrentDatasetOwnership as hasCurrentDatasetOwnershipProduction,
  isConfirmedMainPaneHorizontalPan,
  isIndicatorReconcileReady,
  isMainPanePlotPointerStart,
  removedDrawingSubPaneScopeKeys,
  prepareDrawingSurfaceForSeriesReplacement,
  resolveDrawingSurfaceChartTypeBoundary,
  resolveLeftHistoryDemand,
  resolveIntervalTransitionReplayData,
  resolveDataTimeSet,
  sameIndicatorSeriesData,
  shouldAdvanceDrawingCoordinateGeneration,
  shouldAdvanceIndicatorSeriesReady,
  shouldInvalidateDrawingFrameOnPointerRelease,
  shouldIssueHistoryTicketForWheel,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRequestRightWindowRestore,
  shouldReplayIntervalTransitionSeries,
  shouldRestoreChartViewport as shouldRestoreChartViewportProduction,
} from "../singleChartPaneLifecycle.js";
import { structuralMock } from "../../test/testHelpers.js";

function hasCurrentDatasetOwnership(value: object): boolean {
  return hasCurrentDatasetOwnershipProduction(
    structuralMock<NonNullable<Parameters<typeof hasCurrentDatasetOwnershipProduction>[0]>>(value),
  );
}

function shouldRestoreChartViewport(value: object): boolean {
  return shouldRestoreChartViewportProduction(
    structuralMock<NonNullable<Parameters<typeof shouldRestoreChartViewportProduction>[0]>>(value),
  );
}

test("chart disposal detaches drawings and disables auto-size before removal", () => {
  const calls: unknown[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: (options) => calls.push(["options", options]),
    remove: () => calls.push(["remove"]),
  }, {
    beforeRemove: () => { calls.push(["drawings"]); },
    afterRemove: () => { calls.push(["drawings-complete"]); },
  }), true);

  assert.deepEqual(calls, [
    ["drawings"],
    ["options", { autoSize: false }],
    ["remove"],
    ["drawings-complete"],
  ]);
});

test("chart disposal still removes a surface when disabling auto-size fails", () => {
  const calls: unknown[] = [];
  assert.doesNotThrow(() => disposeChartPaneSurface({
    applyOptions: () => {
      calls.push("options");
      throw new Error("already disposing");
    },
    remove: () => calls.push("remove"),
  }));

  assert.deepEqual(calls, ["options", "remove"]);
});

test("chart disposal reports failure and continues when drawing teardown throws", () => {
  const calls: unknown[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: () => calls.push("options"),
    remove: () => calls.push("remove"),
  }, {
    beforeRemove: () => {
      calls.push("drawings");
      throw new Error("stale drawing runtime");
    },
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);

  assert.deepEqual(calls, ["drawings", "options", "remove", "drawings-complete"]);
});

test("sub-pane drawing cleanup never applies previous ids to a new symbol base", () => {
  assert.deepEqual(removedDrawingSubPaneScopeKeys({
    currentBase: "binance:spot:ETHUSDT",
    currentIds: new Set(["rsi"]),
    previousBase: "binance:spot:BTCUSDT",
    previousIds: new Set(["rsi", "macd"]),
  }), []);
  assert.deepEqual(removedDrawingSubPaneScopeKeys({
    currentBase: "binance:spot:BTCUSDT",
    currentIds: new Set(["rsi"]),
    previousBase: "binance:spot:BTCUSDT",
    previousIds: new Set(["rsi", "macd"]),
  }), ["binance:spot:BTCUSDT__macd"]);
});

test("main-series drawing preparation restores partial and throwing failures", () => {
  const calls: string[] = [];
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-false");
    return false;
  }, () => calls.push("restore-false")), false);
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-throw");
    throw new Error("partial detach");
  }, () => calls.push("restore-throw")), false);
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-success");
    return true;
  }, () => calls.push("restore-unexpected")), true);
  assert.deepEqual(calls, [
    "prepare-false",
    "restore-false",
    "prepare-throw",
    "restore-throw",
    "prepare-success",
  ]);
});

test("full chart recreation carries only a real chart-type boundary", () => {
  assert.deepEqual(
    resolveDrawingSurfaceChartTypeBoundary("candlestick", "renko"),
    {
      kind: "chart-type",
      beforeValue: "candlestick",
      afterValue: "renko",
    },
  );
  assert.equal(resolveDrawingSurfaceChartTypeBoundary("line", "line"), undefined);
  assert.equal(resolveDrawingSurfaceChartTypeBoundary(null, "line"), undefined);
});

test("chart disposal reports explicit drawing failure while still releasing the chart", () => {
  const calls: string[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: () => calls.push("options"),
    remove: () => calls.push("remove"),
  }, {
    beforeRemove: () => {
      calls.push("drawings");
      return false;
    },
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);

  assert.deepEqual(calls, ["drawings", "options", "remove", "drawings-complete"]);
});

test("chart disposal invalidates drawing credentials even when remove throws", () => {
  const calls: string[] = [];
  assert.equal(disposeChartPaneSurface({
    remove: () => {
      calls.push("remove");
      throw new Error("remove failed");
    },
  }, {
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);
  assert.deepEqual(calls, ["remove", "drawings-complete"]);
});

test("visible range snapshots include the fitted time and logical coverage", () => {
  assert.deepEqual(buildVisibleRangeSnapshot({
    barSpacing: 0.5,
    logicalRange: { from: -0.5, to: 1_500.5 },
    rightOffset: 0,
    timeRange: { from: 1_640_995_200, to: 1_770_652_800 },
  }), {
    barSpacing: 0.5,
    logical: { from: -0.5, to: 1_500.5 },
    rightOffset: 0,
    rightmostTime: 1_770_652_800,
    time: { from: 1_640_995_200, to: 1_770_652_800 },
  });
});

test("only user-driven viewport changes publish persistence and interactive coverage", () => {
  const range = { from: 0, to: 1_500 };

  assert.equal(shouldPublishUserViewportRange({ range, userInteracted: true }), true);
  assert.equal(shouldPublishUserViewportRange({ range, userInteracted: false }), false);
  assert.equal(shouldPublishUserViewportRange({
    isProgrammatic: true,
    range,
    userInteracted: true,
  }), false);
  assert.equal(shouldPublishUserViewportRange({
    isSyncing: true,
    range,
    userInteracted: true,
  }), false);
});

test("pointer release only deduplicates drawing invalidation after a logical-range change", () => {
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease({
    logicalRangeChanged: true,
    mainPanePlotStart: true,
    maxHorizontalMovementPx: 24,
    maxVerticalMovementPx: 2,
    pointerActive: true,
  }), false);
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease({
    logicalRangeChanged: true,
    mainPanePlotStart: false,
    maxHorizontalMovementPx: 24,
    maxVerticalMovementPx: 2,
    pointerActive: true,
  }), true, "a price-axis/pane gesture still invalidates after an interleaved range callback");
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease({
    logicalRangeChanged: true,
    mainPanePlotStart: true,
    maxHorizontalMovementPx: 0,
    maxVerticalMovementPx: 0,
    pointerActive: true,
  }), true, "a click is not a confirmed pan");
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease({
    drawingToolActive: true,
    logicalRangeChanged: true,
    mainPanePlotStart: true,
    maxHorizontalMovementPx: 24,
    maxVerticalMovementPx: 2,
    pointerActive: true,
  }), true, "an active drawing tool owns the gesture even when range changes");
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease({
    logicalRangeChanged: false,
    mainPanePlotStart: true,
    maxHorizontalMovementPx: 24,
    maxVerticalMovementPx: 2,
    pointerActive: true,
  }), true, "movement without a range change is not a confirmed pan");
  assert.equal(shouldInvalidateDrawingFrameOnPointerRelease(), false);
});

test("history tickets admit only a real primary main-pane horizontal pan", () => {
  const validPan = {
    logicalRangeChanged: true,
    mainPanePlotStart: true,
    maxHorizontalMovementPx: 24,
    maxVerticalMovementPx: 2,
    pointerActive: true,
  };

  assert.equal(isConfirmedMainPaneHorizontalPan(validPan), true);
  assert.equal(isConfirmedMainPaneHorizontalPan({
    ...validPan,
    maxHorizontalMovementPx: 0,
  }), false, "zero-displacement clicks do not issue history tickets");
  assert.equal(isConfirmedMainPaneHorizontalPan({
    ...validPan,
    mainPanePlotStart: false,
  }), false, "right-click/axis/separator starts are ineligible");
  assert.equal(isConfirmedMainPaneHorizontalPan({
    ...validPan,
    drawingToolActive: true,
  }), false, "drawing gestures remain drawing-owned");
  assert.equal(isConfirmedMainPaneHorizontalPan({
    ...validPan,
    maxVerticalMovementPx: 30,
  }), false, "vertical pane gestures are not horizontal pans");
});

test("history wheel tickets require a non-zero wheel over the main plot", () => {
  assert.equal(shouldIssueHistoryTicketForWheel({
    deltaY: 100,
    mainPanePlotStart: true,
  }), true);
  assert.equal(shouldIssueHistoryTicketForWheel({
    deltaX: 0,
    deltaY: 0,
    mainPanePlotStart: true,
  }), false);
  assert.equal(shouldIssueHistoryTicketForWheel({
    deltaY: 100,
    mainPanePlotStart: false,
  }), false);
  assert.equal(shouldIssueHistoryTicketForWheel({
    deltaY: 100,
    drawingToolActive: true,
    mainPanePlotStart: true,
  }), false);
});

test("main-pane pan classification excludes price scale, time scale, separators, and unknown geometry", () => {
  const containerRect = { left: 100, top: 50 };
  const plotRect = { x: 20, y: 0, width: 800, height: 400 };
  assert.equal(isMainPanePlotPointerStart({
    clientX: 300,
    clientY: 200,
    containerRect,
    plotRect,
  }), true);
  assert.equal(isMainPanePlotPointerStart({
    clientX: 930,
    clientY: 200,
    containerRect,
    plotRect,
  }), false, "right price scale is outside the plot");
  assert.equal(isMainPanePlotPointerStart({
    clientX: 300,
    clientY: 455,
    containerRect,
    plotRect,
  }), false, "time scale and bottom pane boundary are outside the plot");
  assert.equal(isMainPanePlotPointerStart({
    clientX: 300,
    clientY: 446,
    containerRect,
    plotRect,
  }), false, "the guarded pane-separator edge is not a pan start");
  assert.equal(isMainPanePlotPointerStart({
    clientX: 300,
    clientY: 200,
    containerRect: null,
    plotRect,
  }), false);
});

test("resolveDataTimeSet reuses one empty set until a series store exists", () => {
  const first = resolveDataTimeSet(null);
  const second = resolveDataTimeSet(undefined);
  const storeTimes = new Set([60, 120]);

  assert.strictEqual(second, first);
  assert.strictEqual(
    resolveDataTimeSet(structuralMock<NonNullable<Parameters<typeof resolveDataTimeSet>[0]>>({
      timeSet: () => storeTimes,
    })),
    storeTimes,
  );
});

test("indicator reconciliation requires metadata and store ownership for the current dataset", () => {
  const datasetKey = "binance-spot-BTCUSDT-5m";
  const currentStore = { seriesKey: datasetKey };

  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { status: "provisional", seriesKey: datasetKey },
    datasetKey,
    seriesStore: currentStore,
  }), true);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { seriesKey: "binance-spot-BTCUSDT-1m" },
    datasetKey,
    seriesStore: currentStore,
  }), false);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { seriesKey: datasetKey },
    datasetKey,
    seriesStore: { seriesKey: "binance-spot-BTCUSDT-1m" },
  }), false);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { optimistic: true, seriesKey: datasetKey },
    datasetKey,
    seriesStore: currentStore,
  }), false);
});

test("interval replay prefers committed data and never restores old data onto a replacement series", () => {
  const scheduledSeries = {};
  const replacementSeries = {};
  const fallbackData = [{ time: 1 }];
  const committedData = [{ time: 2 }];

  assert.strictEqual(resolveIntervalTransitionReplayData({
    currentData: committedData,
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), committedData);
  assert.strictEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 1,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), fallbackData);
  assert.deepEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), []);
  assert.equal(resolveIntervalTransitionReplayData({
    currentData: null,
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), null);
  assert.deepEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 1,
    currentSeries: replacementSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), []);
});

test("an empty indicator rebuild does not advance series readiness", () => {
  assert.equal(shouldAdvanceIndicatorSeriesReady(), false);
  assert.equal(shouldAdvanceIndicatorSeriesReady({
    createdSeriesCount: 0,
    paneStructureChanged: false,
    removedSeriesCount: 0,
    structureChanged: false,
  }), false);
});

test("viewport restore waits for full ready history instead of a provisional latest seed", () => {
  const datasetKey = "binance::spot::BTCUSDT::3m";

  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "provisional", seriesKey: datasetKey },
    datasetKey,
    hasRows: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: "binance::spot::BTCUSDT::1h" },
    datasetKey,
    hasRows: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey },
    datasetKey,
    hasRows: true,
  }), true);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "kline-ws" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
  }), true);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
    userInteracted: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRows: true,
    userInteracted: true,
  }), false);
});

test("fitting a fresh chart does not auto-load left history before user interaction", () => {
  const request = {
    canLoad: true,
    hasData: true,
    hasHandler: true,
    rangeFrom: 0,
    triggerBars: 20,
  };

  assert.equal(shouldRequestMoreLeft(request), false);
  assert.equal(shouldRequestMoreLeft({ ...request, userInteracted: true }), true);
  assert.equal(shouldRequestMoreLeft({
    ...request,
    rangeFrom: 21,
    userInteracted: true,
  }), false);
});

test("indicator reconciliation waits one owned task after dataset publication", () => {
  const datasetKey = "binance-spot-BTCUSDT-5m";

  assert.equal(isIndicatorReconcileReady({
    datasetKey,
    datasetOwned: true,
    readyDatasetKey: null,
  }), false);
  assert.equal(isIndicatorReconcileReady({
    datasetKey,
    datasetOwned: false,
    readyDatasetKey: datasetKey,
  }), false);
  assert.equal(isIndicatorReconcileReady({
    datasetKey,
    datasetOwned: true,
    readyDatasetKey: "binance-spot-BTCUSDT-1m",
  }), false);
  assert.equal(isIndicatorReconcileReady({
    datasetKey,
    datasetOwned: true,
    readyDatasetKey: datasetKey,
  }), true);
});

test("interval replay yields when the target dataset projection has committed", () => {
  const series = {};
  const base = {
    currentCommittedProjectionGeneration: 10,
    currentProjectionGeneration: 10,
    currentSeries: series,
    currentSeriesKey: "binance-spot-BTCUSDT-3m",
    scheduledDatasetKey: "binance-spot-BTCUSDT-3m",
    scheduledProjectionGeneration: 10,
    scheduledSeries: series,
  };

  assert.equal(shouldReplayIntervalTransitionSeries(base), true);
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentProjectionGeneration: 11,
  }), true, "a failed target projection cannot claim a successful submission");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentCommittedProjectionGeneration: 11,
    currentProjectionGeneration: 11,
  }), false, "the target projection already owns the full series submission");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentCommittedProjectionGeneration: 11,
    currentProjectionGeneration: 11,
    currentSeriesKey: "binance-spot-BTCUSDT-1m",
  }), true, "an old dataset render cannot claim ownership of the target interval");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentCommittedProjectionGeneration: 11,
    currentProjectionGeneration: 12,
  }), true, "a newer failed projection invalidates the previous successful token");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentCommittedProjectionGeneration: -1,
    currentProjectionGeneration: 10,
    scheduledProjectionGeneration: 9,
  }), true, "a failed delta invalidates the successful token for the same generation");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    currentSeries: {},
  }), false, "a replacement series already received its complete snapshot");
  assert.equal(shouldReplayIntervalTransitionSeries({
    ...base,
    targetPublicationPending: true,
  }), false, "an optimistic target must not replay the old interval before warm publication");
});

test("left-edge demand survives the in-flight canLoad=false window", () => {
  const request = {
    canLoad: false,
    hasData: true,
    hasHandler: true,
    rangeFrom: 5,
    triggerBars: 15,
    userInteracted: true,
  };

  assert.deepEqual(resolveLeftHistoryDemand(request), {
    demanded: true,
    shouldRequest: false,
  });
  assert.deepEqual(resolveLeftHistoryDemand({ ...request, canLoad: true }), {
    demanded: true,
    shouldRequest: true,
  });
  assert.deepEqual(resolveLeftHistoryDemand({ ...request, rangeFrom: 16 }), {
    demanded: false,
    shouldRequest: false,
  });
});

test("one left-edge user gesture can consume at most one logical history page", () => {
  const request = {
    canLoad: true,
    consumedInteractionGeneration: 6,
    hasData: true,
    hasHandler: true,
    interactionGeneration: 7,
    rangeFrom: 5,
    triggerBars: 15,
    userInteracted: true,
  };

  assert.deepEqual(resolveLeftHistoryDemand(request), {
    demanded: true,
    shouldRequest: true,
  });
  assert.deepEqual(resolveLeftHistoryDemand({
    ...request,
    consumedInteractionGeneration: 7,
  }), {
    demanded: false,
    shouldRequest: false,
  });
  assert.deepEqual(resolveLeftHistoryDemand({
    ...request,
    consumedInteractionGeneration: 7,
    interactionGeneration: 8,
  }), {
    demanded: true,
    shouldRequest: true,
  });
});

test("an unconsumed left-edge gesture waits through loading then consumes once", () => {
  const request = {
    canLoad: false,
    consumedInteractionGeneration: 10,
    hasData: true,
    hasHandler: true,
    interactionGeneration: 11,
    rangeFrom: 0,
    triggerBars: 15,
    userInteracted: true,
  };

  assert.deepEqual(resolveLeftHistoryDemand(request), {
    demanded: true,
    shouldRequest: false,
  });
  assert.deepEqual(resolveLeftHistoryDemand({ ...request, canLoad: true }), {
    demanded: true,
    shouldRequest: true,
  });
  assert.deepEqual(resolveLeftHistoryDemand({
    ...request,
    canLoad: true,
    consumedInteractionGeneration: 11,
  }), {
    demanded: false,
    shouldRequest: false,
  });
});

test("a right-truncated historical window restores only at the user-driven right edge", () => {
  const request = {
    barCount: 10_000,
    canLoad: true,
    hasHandler: true,
    rangeTo: 9_990,
    rightTruncated: true,
    triggerBars: 15,
    userInteracted: true,
  };

  assert.equal(shouldRequestRightWindowRestore(request), true);
  assert.equal(shouldRequestRightWindowRestore({ ...request, rangeTo: 9_980 }), false);
  assert.equal(shouldRequestRightWindowRestore({ ...request, rightTruncated: false }), false);
  assert.equal(shouldRequestRightWindowRestore({ ...request, canLoad: false }), false);
  assert.equal(shouldRequestRightWindowRestore({ ...request, userInteracted: false }), false);
  assert.equal(shouldRequestRightWindowRestore({
    ...request,
    consumedInteractionGeneration: 4,
    interactionGeneration: 4,
  }), false, "a consumed gesture cannot race a new restore");
  assert.equal(shouldRequestRightWindowRestore({
    ...request,
    consumedInteractionGeneration: 4,
    interactionGeneration: 5,
  }), true, "a fresh eligible gesture can own one restore");
});

test("indicator reconcile treats point-identical arrays as the same payload", () => {
  const previous = [
    { time: 10, value: 1, color: "#fff" },
    { time: 20, value: 2 },
  ];
  const identical = previous.map((point) => ({ ...point }));
  const changed = previous.map((point, index) => (
    index === 1 ? { ...point, value: 3 } : { ...point }
  ));

  assert.equal(sameIndicatorSeriesData(previous, previous), true);
  assert.equal(sameIndicatorSeriesData(previous, identical), true);
  assert.equal(sameIndicatorSeriesData(previous, changed), false);
});

test("real indicator or pane structure changes advance series readiness", () => {
  for (const change of [
    { createdSeriesCount: 1 },
    { paneStructureChanged: true },
    { removedSeriesCount: 1 },
    { structureChanged: true },
  ]) {
    assert.equal(shouldAdvanceIndicatorSeriesReady(change), true);
  }
});

test("resolved derived projection replacement advances drawing coordinates", () => {
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "derived-ordinal",
    canReuseProjection: false,
  }), true);
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "derived-ordinal",
    canReuseProjection: true,
  }), false);
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "time",
    canReuseProjection: false,
  }), false);
});
