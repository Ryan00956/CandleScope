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
import {
  BASE_TIME_MS,
  replayBar,
  replaySessionResponse,
  replayTradeSessionResponse,
} from "./fixtures.js";

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

test("atomic snapshots reject duplicate or reordered bars before the series store can normalize them", () => {
  for (const bars of [
    [replayBar(BASE_TIME_MS), replayBar(BASE_TIME_MS)],
    [replayBar(BASE_TIME_MS + 60_000), replayBar(BASE_TIME_MS)],
  ]) {
    const response = replaySessionResponse({ virtualTimeMs: BASE_TIME_MS + 119_999 });
    const builder = response.snapshot.components.bar_builder;
    builder.closed_bars = bars;
    builder.closed_count = bars.length;
    const snapshot = parseReplaySessionResponse(response).snapshot;
    const store = new SeriesWindowStore();
    assert.throws(
      () => replaceReplaySeriesFromSnapshot(store, snapshot),
      /snapshot bars are not strictly increasing/,
    );
    assert.equal(store.barCount, 0);
  }
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

test("aggregate-trade public snapshot and batched updates reuse the same series store", () => {
  const tradeSnapshot = parseReplaySessionResponse(replayTradeSessionResponse()).snapshot;
  const tradeStore = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(tradeStore, tradeSnapshot);
  assert.equal(tradeStore.barCount, 2);
  assert.equal(tradeStore.last()?.replayClosed, false);

  const barSnapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, barSnapshot);
  const result = applyReplayBarUpdate(store, {
    action: "batch",
    updates: [
      {
        action: "append",
        bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101")),
        source_sequence: 1,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "previous_close_zero_volume",
      },
      {
        action: "tick",
        bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "102")),
        source_sequence: 1,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "previous_close_zero_volume",
      },
    ],
  }, BASE_TIME_MS + 119_999);
  assert.equal(result.type, "tick");
  assert.equal(store.barCount, 2);
  assert.equal(store.last()?.close, 102);
});

test("a later unrepresentable batch row cannot leave the shared series half-applied", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, snapshot);
  const original = store.snapshot().map((row) => ({ ...row }));
  const appended = parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101"));
  const invalid = parseReplayDisplayBar({
    ...replayBar(BASE_TIME_MS + 60_000, "101"),
    close: "9".repeat(400),
  });

  assert.throws(() => applyReplayBarUpdate(store, {
    action: "batch",
    updates: [
      {
        action: "append",
        bar: appended,
        source_sequence: 1,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "reject",
      },
      {
        action: "tick",
        bar: invalid,
        source_sequence: 1,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "reject",
      },
    ],
  }, BASE_TIME_MS + 119_999), /cannot be represented/);
  assert.deepEqual(store.snapshot(), original);
});

test("a forged tick cannot rewrite an already revealed historical bar", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, snapshot);
  applyReplayBarUpdate(store, {
    action: "append",
    bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101")),
    source_sequence: 1,
    base_open_time_ms: BASE_TIME_MS + 60_000,
    gap_policy: "reject",
    synthetic_policy: "reject",
  }, BASE_TIME_MS + 119_999);
  const original = store.snapshot().map((row) => ({ ...row }));

  assert.throws(() => applyReplayBarUpdate(store, {
    action: "tick",
    bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS, "999")),
    source_sequence: 2,
    base_open_time_ms: BASE_TIME_MS + 60_000,
    gap_policy: "reject",
    synthetic_policy: "reject",
  }, BASE_TIME_MS + 119_999), /does not target the revealed series tail/);
  assert.deepEqual(store.snapshot(), original);
});

test("a bar marked closed cannot be published before its close time", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, snapshot);
  assert.throws(() => applyReplayBarUpdate(store, {
    action: "append",
    bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101")),
    source_sequence: 1,
    base_open_time_ms: BASE_TIME_MS + 60_000,
    gap_policy: "reject",
    synthetic_policy: "reject",
  }, BASE_TIME_MS + 60_000), /closed replay bar exceeds the public cursor/);
  assert.equal(store.barCount, 1);
});

test("semantic batch validation is atomic and rejects backward source order", () => {
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  const store = new SeriesWindowStore();
  replaceReplaySeriesFromSnapshot(store, snapshot);
  const original = store.snapshot().map((row) => ({ ...row }));

  assert.throws(() => applyReplayBarUpdate(store, {
    action: "batch",
    updates: [
      {
        action: "append",
        bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "101")),
        source_sequence: 2,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "reject",
      },
      {
        action: "tick",
        bar: parseReplayDisplayBar(replayBar(BASE_TIME_MS + 60_000, "102")),
        source_sequence: 1,
        base_open_time_ms: BASE_TIME_MS + 60_000,
        gap_policy: "reject",
        synthetic_policy: "reject",
      },
    ],
  }, BASE_TIME_MS + 119_999), /source sequence moved backward/);
  assert.deepEqual(store.snapshot(), original);
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
