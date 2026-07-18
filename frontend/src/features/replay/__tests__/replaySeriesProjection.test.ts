import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import { parseReplayDisplayBar, parseReplaySessionResponse } from "../replayParser.js";
import {
  applyReplayBarUpdate,
  buildReplayDatasetKey,
  replayDisplayBarToKline,
  replaceReplaySeriesFromSnapshot,
} from "../replaySeriesProjection.js";
import { BASE_TIME_MS, replayBar, replaySessionResponse } from "./fixtures.js";

test("atomic snapshot maps to one SeriesWindowStore replace", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  const deltas: string[] = [];
  store.subscribe((delta) => deltas.push(delta.type));
  const delta = replaceReplaySeriesFromSnapshot(store, snapshot);
  assert.equal(delta.type, "replace");
  assert.deepEqual(deltas, ["replace"]);
  assert.equal(store.barCount, 1);
  assert.equal(store.last()?.close, 100);
  assert.match(String(store.seriesKey), /source=replay/);
});

test("append and tick use existing delta hot paths without copying the full series", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, snapshot);
  const appendedBar = parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101"));
  const append = applyReplayBarUpdate(store, {
    action: "append",
    bar: appendedBar,
    source_sequence: 1,
    base_open_time_ms: BASE_TIME_MS + 60_000,
    gap_policy: "reject",
    synthetic_policy: "reject",
  }, BASE_TIME_MS + 119_999);
  assert.equal(append.type, "append");
  assert.equal(store.barCount, 2);

  const stableSnapshot = store.snapshot();
  const tick = applyReplayBarUpdate(store, {
    action: "tick",
    bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "102")),
    source_sequence: 2,
    base_open_time_ms: BASE_TIME_MS + 60_000,
    gap_policy: "reject",
    synthetic_policy: "reject",
  }, BASE_TIME_MS + 119_999);
  assert.equal(tick.type, "tick");
  assert.strictEqual(store.snapshot(), stableSnapshot);
  assert.equal(store.last()?.close, 102);
});

test("chart conversion fails closed when a valid Decimal exceeds Number capacity", () => {
  const bar = parseReplayDisplayBar({
    ...replayBar(),
    close: "9".repeat(400),
  });
  assert.throws(() => replayDisplayBarToKline(bar), /cannot be represented/);
});

test("dataset key is isolated by session, data epoch, and public timeline epoch", () => {
  const first = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const second = parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-0002" })).snapshot;
  assert.notEqual(buildReplayDatasetKey(first), buildReplayDatasetKey(second));
  assert.match(buildReplayDatasetKey(first), /session=session-0001/);
});
