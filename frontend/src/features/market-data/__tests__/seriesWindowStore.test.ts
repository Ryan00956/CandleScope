import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../window/seriesWindowStore.js";
import { WINDOW_DELTA_TYPES } from "../window/windowDeltas.js";
import type { KlineBar } from "../marketDataTypes.js";
import { epochSeconds, mustBeDefined } from "../../../test/testHelpers.js";

function rows(times: number[]): KlineBar[] {
  return times.map((time) => ({
    time: epochSeconds(time),
    open: time,
    high: time + 1,
    low: time - 1,
    close: time + 0.5,
    volume: time * 10,
  }));
}

test("replace normalizes duplicate and unsorted rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  const delta = store.replace([
    ...rows([180, 60, 120]),
    { ...rows([120])[0], close: 999 },
  ]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.REPLACE);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180]);
  assert.equal(mustBeDefined(store.snapshot()[1]).close, 999);
});

test("applyRange appends newer rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const delta = store.applyRange(rows([180, 240]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.APPEND);
  assert.equal(delta.addedRight, 2);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180, 240]);
});

test("applyRange prepends older rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([180, 240]));
  const delta = store.applyRange(rows([60, 120]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.equal(delta.addedLeft, 2);
  assert.equal(delta.retainedIncomingRows, 2);
  assert.deepEqual(delta.changedRanges, [{ start: 60, end: 120, type: "prepend" }]);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180, 240]);
});

test("a full historical window retains prepended rows and trims the right edge", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 1, maxBars: 10_000 });
  store.replace(rows(Array.from({ length: 10_000 }, (_, index) => index + 501)));

  const delta = store.applyRange(rows(Array.from({ length: 500 }, (_, index) => index + 1)));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.equal(delta.trimmedLeft, 0);
  assert.equal(delta.trimmedRight, 500);
  assert.equal(delta.retainedIncomingRows, 500);
  assert.deepEqual(delta.changedRanges, [{ start: 1, end: 500, type: "prepend" }]);
  assert.equal(store.barCount, 10_000);
  assert.equal(store.first()?.time, 1);
  assert.equal(store.last()?.time, 10_000);
  assert.equal(store.rightTruncated, true);
});

test("right truncation stays retryable until a successful replacement", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 1, maxBars: 3 });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);

  // A failed reload does not mutate the store. The next right-edge gesture
  // can therefore retry the same atomic replacement.
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);

  store.replace(rows([4, 5, 6]), { source: "right-window-restore" });
  assert.equal(store.rightTruncated, false);
  assert.deepEqual(store.snapshot().map((row) => row.time), [4, 5, 6]);
});

test("a right-truncated historical window rejects a newer realtime tick", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const delta = store.applyTick(rows([100])[0]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.NOOP);
  assert.equal(delta.originalIncomingBars, 1);
  assert.equal(delta.ignoredRightTruncatedRows, 1);
  assert.equal(delta.rightBoundaryTime, 3);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
  assert.deepEqual(store.coverage().gaps, []);
});

test("a right-truncated historical window rejects newer range rows but keeps in-window corrections", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const delta = store.applyRange([
    { ...rows([2])[0], close: 777 },
    ...rows([100, 101]),
  ]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.MID_MERGE);
  assert.equal(delta.incomingBars, 1);
  assert.equal(delta.originalIncomingBars, 3);
  assert.equal(delta.ignoredRightTruncatedRows, 2);
  assert.equal(delta.rightBoundaryTime, 3);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
  assert.equal(store.getByTime(2)?.close, 777);
  assert.deepEqual(store.coverage().gaps, []);
});

test("a right-truncated historical window rejects an entirely newer range patch", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const delta = store.applyRange(rows([100, 101]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.NOOP);
  assert.equal(delta.originalIncomingBars, 2);
  assert.equal(delta.ignoredRightTruncatedRows, 2);
  assert.equal(delta.rightBoundaryTime, 3);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
  assert.deepEqual(store.coverage().gaps, []);
});

test("a right-truncated historical window can keep sliding left", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([7, 8, 9]));
  store.applyRange(rows([4, 5, 6]));

  const delta = store.applyRange(rows([1, 2, 3]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.equal(delta.trimmedRight, 3);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
  assert.deepEqual(store.coverage().gaps, []);
});

test("a right-truncated historical window still accepts a retained tail correction", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const delta = store.applyTick({ ...rows([3])[0], close: 888 });

  assert.equal(delta.type, WINDOW_DELTA_TYPES.TICK);
  assert.equal(delta.replaced, true);
  assert.equal(store.rightTruncated, true);
  assert.equal(store.getByTime(3)?.close, 888);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
  assert.deepEqual(store.coverage().gaps, []);
});

test("a generic right-truncated store keeps authoritative range convergence enabled", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 1, maxBars: 3 });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const delta = store.applyRange(rows([4, 5, 6]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.APPEND);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [4, 5, 6]);
});

test("a trusted forward page advances a fenced historical window without enabling realtime", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));

  const page = store.applyForwardPage(rows([4, 5, 6]), { source: "right-window-page" });
  const blockedTick = store.applyTick(rows([100])[0]);

  assert.equal(page.type, WINDOW_DELTA_TYPES.APPEND);
  assert.equal(page.trimmedLeft, 3);
  assert.equal(store.rightTruncated, true);
  assert.equal(blockedTick.type, WINDOW_DELTA_TYPES.NOOP);
  assert.deepEqual(store.snapshot().map((row) => row.time), [4, 5, 6]);
});

test("only a verified current-tail transition re-enables realtime ticks", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([4, 5, 6]));
  store.applyRange(rows([1, 2, 3]));
  store.applyForwardPage(rows([4, 5, 6]));

  assert.equal(store.markRightEdgeCurrent(), true);
  assert.equal(store.markRightEdgeCurrent(), false);
  assert.equal(store.applyTick(rows([7])[0]).type, WINDOW_DELTA_TYPES.TICK);
  assert.equal(store.rightTruncated, false);
  assert.deepEqual(store.snapshot().map((row) => row.time), [5, 6, 7]);
});

test("a forward page cannot be used outside a right-truncated window", () => {
  const store = new SeriesWindowStore({
    intervalSeconds: 1,
    maxBars: 3,
    rightTruncatedFuturePolicy: "reject",
  });
  store.replace(rows([1, 2, 3]));

  const delta = store.applyForwardPage(rows([4, 5, 6]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.NOOP);
  assert.equal(delta.rejectedForwardPage, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
});

test("prepend retention reports incoming rows discarded beyond the window budget", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 1, maxBars: 3 });
  store.replace(rows([5, 6, 7]));

  const delta = store.applyRange(rows([1, 2, 3, 4]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.equal(delta.trimmedRight, 4);
  assert.equal(delta.retainedIncomingRows, 3);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
});

test("an inclusive before-page boundary still slides the full window left", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 1, maxBars: 3 });
  store.replace(rows([3, 4, 5]));

  const delta = store.applyRange(rows([1, 2, 3]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.equal(delta.trimmedRight, 2);
  assert.equal(store.rightTruncated, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [1, 2, 3]);
});

test("applyRange mid-merges overlapping rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 240]));
  const delta = store.applyRange([
    { ...rows([120])[0], close: 500 },
    ...rows([180]),
  ]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.MID_MERGE);
  assert.deepEqual(delta.changedRanges, [
    { start: 120, end: 180, type: "mid-merge" },
  ]);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180, 240]);
  assert.equal(mustBeDefined(store.snapshot()[1]).close, 500);
});

test("a large identical patch emits only its actually prepended row", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([120, 180, 240, 300]));
  const delta = store.applyRange(rows([60, 120, 180, 240, 300]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.PREPEND);
  assert.deepEqual(delta.changedRanges, [{ start: 60, end: 60, type: "prepend" }]);
});

test("changed ranges split across unchanged rows and retained segment gaps", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 180, 300, 360]));
  const delta = store.applyRange([
    { ...rows([60])[0], close: 999 },
    mustBeDefined(rows([120])[0]),
    { ...rows([180])[0], close: 999 },
    { ...rows([300])[0], close: 999 },
  ]);

  assert.deepEqual(delta.changedRanges, [
    { start: 60, end: 60, type: "mid-merge" },
    { start: 180, end: 180, type: "mid-merge" },
    { start: 300, end: 300, type: "mid-merge" },
  ]);
});

test("applyRange noops when incoming rows are already present", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const delta = store.applyRange(rows([60, 120]));

  assert.equal(delta.type, WINDOW_DELTA_TYPES.NOOP);
});

test("applyTick replaces the latest bar through the time index", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const delta = store.applyTick({ ...rows([120])[0], close: 777 });

  assert.equal(delta.type, WINDOW_DELTA_TYPES.TICK);
  assert.equal(delta.replaced, true);
  assert.equal(mustBeDefined(store.snapshot()[1]).close, 777);
});

test("applyTick treats non-tail corrections as structural merges", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 180]));
  const delta = store.applyTick({ ...rows([120])[0], close: 777 });

  assert.equal(delta.type, WINDOW_DELTA_TYPES.MID_MERGE);
  assert.equal(mustBeDefined(store.snapshot()[1]).close, 777);
});

test("applyTick appends a new tail bar", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const delta = store.applyTick(rows([180])[0]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.TICK);
  assert.equal(delta.appended, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180]);
});

test("axis revision ignores value-only updates and advances for time-axis changes", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  assert.equal(store.axisRevision, 0);

  store.replace(rows([60, 120, 240]));
  assert.equal(store.axisRevision, 1);

  store.applyTick({ ...rows([240])[0], close: 777 });
  store.applyTick({ ...rows([120])[0], close: 888 });
  store.applyRange([{ ...rows([120])[0], close: 999 }]);
  assert.equal(store.axisRevision, 1);

  store.applyRange(rows([180]));
  assert.equal(store.axisRevision, 2);

  store.applyTick(rows([300])[0]);
  assert.equal(store.axisRevision, 3);

  store.clear();
  assert.equal(store.axisRevision, 4);
});

test("applyTick ignores older rows outside the window", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([120, 180]));
  const delta = store.applyTick(rows([60])[0]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.NOOP);
  assert.deepEqual(store.snapshot().map((row) => row.time), [120, 180]);
});

test("trimToBudget anchors on the newest rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60, maxBars: 3 });
  const delta = store.replace(rows([60, 120, 180, 240, 300]));

  assert.equal(delta.trimmedLeft, 2);
  assert.deepEqual(store.snapshot().map((row) => row.time), [180, 240, 300]);
});

test("applyTick trims left when appending beyond budget", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60, maxBars: 3 });
  store.replace(rows([60, 120, 180]));
  const delta = store.applyTick(rows([240])[0]);

  assert.equal(delta.trimmedLeft, 1);
  assert.deepEqual(store.snapshot().map((row) => row.time), [120, 180, 240]);
});

test("coverage reports segment gaps", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 300, 360]));

  assert.deepEqual(store.coverage(), {
    firstTime: 60,
    lastTime: 360,
    bars: 4,
    gaps: [{ from: 120, to: 300, missingBars: 2 }],
  });
});

test("store exposes stable indexed reads for chart consumers", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 180]));

  assert.equal(store.hasTime(120), true);
  assert.equal(store.hasTime(240), false);
  assert.equal(mustBeDefined(store.getByTime(120)).close, 120.5);
  assert.equal(store.getByTime(240), null);
  assert.equal(store.indexOfTime(180), 2);
  assert.equal(store.indexOfTime(240), -1);
  assert.equal(mustBeDefined(store.first()).time, 60);
  assert.equal(mustBeDefined(store.last()).time, 180);
  assert.deepEqual([...store.timeSet()], [60, 120, 180]);
});

test("time set follows trim and clear operations", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60, maxBars: 3 });
  store.replace(rows([60, 120, 180]));
  store.applyTick(rows([240])[0]);

  assert.deepEqual([...store.timeSet()], [120, 180, 240]);
  assert.equal(store.hasTime(60), false);

  store.clear();

  assert.deepEqual([...store.timeSet()], []);
  assert.equal(store.first(), null);
  assert.equal(store.last(), null);
});

test("subscribers receive deltas", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  const events: string[] = [];
  const unsubscribe = store.subscribe((delta) => { events.push(delta.type); });

  store.replace(rows([60]));
  store.applyTick(rows([120])[0]);
  unsubscribe();
  store.applyTick(rows([180])[0]);

  assert.deepEqual(events, [WINDOW_DELTA_TYPES.REPLACE, WINDOW_DELTA_TYPES.TICK]);
});

test("replace-last tick keeps the snapshot identity stable", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const before = store.snapshot();

  store.applyTick({ ...rows([120])[0], close: 777 });

  const after = store.snapshot();
  assert.equal(after, before);
  assert.equal(mustBeDefined(after[1]).close, 777);
});

test("appended tick keeps the time index incrementally consistent", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));

  store.applyTick(rows([180])[0]);
  store.applyTick({ ...rows([180])[0], close: 999 });

  assert.equal(store.indexOfTime(180), 2);
  assert.equal(mustBeDefined(store.getByTime(180)).close, 999);
  assert.equal(store.hasTime(180), true);
  assert.deepEqual(store.snapshot({ force: true }).map((row) => row.time), [60, 120, 180]);
});
