import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../window/seriesWindowStore.js";
import { WINDOW_DELTA_TYPES } from "../window/windowDeltas.js";

function rows(times) {
  return times.map((time) => ({
    time,
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
  assert.equal(store.snapshot()[1].close, 999);
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
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180, 240]);
});

test("applyRange mid-merges overlapping rows", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 240]));
  const delta = store.applyRange([
    { ...rows([120])[0], close: 500 },
    ...rows([180]),
  ]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.MID_MERGE);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180, 240]);
  assert.equal(store.snapshot()[1].close, 500);
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
  assert.equal(store.snapshot()[1].close, 777);
});

test("applyTick treats non-tail corrections as structural merges", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120, 180]));
  const delta = store.applyTick({ ...rows([120])[0], close: 777 });

  assert.equal(delta.type, WINDOW_DELTA_TYPES.MID_MERGE);
  assert.equal(store.snapshot()[1].close, 777);
});

test("applyTick appends a new tail bar", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));
  const delta = store.applyTick(rows([180])[0]);

  assert.equal(delta.type, WINDOW_DELTA_TYPES.TICK);
  assert.equal(delta.appended, true);
  assert.deepEqual(store.snapshot().map((row) => row.time), [60, 120, 180]);
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
  assert.equal(store.getByTime(120).close, 120.5);
  assert.equal(store.getByTime(240), null);
  assert.equal(store.indexOfTime(180), 2);
  assert.equal(store.indexOfTime(240), -1);
  assert.equal(store.first().time, 60);
  assert.equal(store.last().time, 180);
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
  const events = [];
  const unsubscribe = store.subscribe((delta) => events.push(delta.type));

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
  assert.equal(after[1].close, 777);
});

test("appended tick keeps the time index incrementally consistent", () => {
  const store = new SeriesWindowStore({ intervalSeconds: 60 });
  store.replace(rows([60, 120]));

  store.applyTick(rows([180])[0]);
  store.applyTick({ ...rows([180])[0], close: 999 });

  assert.equal(store.indexOfTime(180), 2);
  assert.equal(store.getByTime(180).close, 999);
  assert.equal(store.hasTime(180), true);
  assert.deepEqual(store.snapshot({ force: true }).map((row) => row.time), [60, 120, 180]);
});
