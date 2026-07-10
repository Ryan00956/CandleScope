import assert from "node:assert/strict";
import test from "node:test";

import {
  clampIndicatorRangeToClosedThrough,
  indicatorRangeCovered,
  invalidateIndicatorRangeSegments,
  mergeIndicatorRangeSegments,
  planIndicatorDirtyRefresh,
  subtractIndicatorRange,
} from "../indicatorRangeCoverage.js";
import { createIndicatorRangeScheduler } from "../indicatorRangeScheduler.js";

test("coverage merges adjacent interval segments and subtracts only the missing tail", () => {
  const covered = mergeIndicatorRangeSegments([
    { start: 60, end: 120 },
    { start: 180, end: 180 },
  ], { step: 60 });
  assert.deepEqual(covered, [{ start: 60, end: 180 }]);
  assert.deepEqual(
    subtractIndicatorRange({ start: 60, end: 300 }, covered, { step: 60 }),
    [{ start: 240, end: 300 }],
  );
  assert.equal(indicatorRangeCovered({ start: 60, end: 180 }, covered, { step: 60 }), true);
});

test("forming last bar is excluded so closed warm coverage remains a zero-request hit", () => {
  const clamped = clampIndicatorRangeToClosedThrough(
    { start: 60, end: 240 },
    { closedThrough: 180, correctionRevision: 1 },
  );
  assert.deepEqual(clamped, { formingOnly: false, range: { start: 60, end: 180 } });
  assert.equal(indicatorRangeCovered(
    clamped.range,
    [{ start: 60, end: 180, revision: { correctionRevision: 1 } }],
    { step: 60, revision: { correctionRevision: 1 } },
  ), true);
  assert.deepEqual(clampIndicatorRangeToClosedThrough(
    { start: 240, end: 240 },
    { closedThrough: 180 },
  ), { formingOnly: true, range: null });
});

test("dirty correction invalidation keeps the valid prefix and conservatively drops the right side", () => {
  assert.deepEqual(
    invalidateIndicatorRangeSegments(
      [{ start: 60, end: 300, revision: { correctionRevision: "1" } }],
      { start: 180, end: 180 },
      { step: 60, revision: { correctionRevision: "2" } },
    ),
    [{ start: 60, end: 120, revision: { correctionRevision: "2" } }],
  );
});

test("recomputed refresh is limited to the visible invalidated suffix", () => {
  assert.deepEqual(
    planIndicatorDirtyRefresh(
      { start: 1_000, end: 1_060 },
      { start: 900, end: 1_200 },
    ),
    { start: 1_000, end: 1_200 },
  );
  assert.equal(planIndicatorDirtyRefresh(
    { start: 1_000, end: 1_060 },
    { start: 100, end: 900 },
  ), null);
});

test("warm coverage produces zero work", async () => {
  const scheduler = createIndicatorRangeScheduler();
  const requests = [];
  scheduler.ensureCoverage({
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 180 },
    step: 60,
    getCoveredSegments: () => [{ start: 60, end: 180 }],
    execute: async ({ range }) => requests.push(range),
  });
  await scheduler.drain();
  assert.deepEqual(requests, []);
});

test("overlapping intents in the same turn are unioned into one request", async () => {
  const scheduler = createIndicatorRangeScheduler();
  const requests = [];
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: async ({ range }) => requests.push(range),
  };
  scheduler.ensureCoverage({ ...common, range: { start: 60, end: 180 } });
  scheduler.ensureCoverage({ ...common, range: { start: 120, end: 300 } });
  await scheduler.drain();
  assert.deepEqual(requests, [{ start: 60, end: 300 }]);
});

test("in-flight coverage prevents overlap and requests only the new tail", async () => {
  const scheduler = createIndicatorRangeScheduler();
  const requests = [];
  const settled = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const execute = async ({ range }) => {
    requests.push(range);
    if (requests.length === 1) await firstBlocked;
    return { ok: true };
  };
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute,
  };
  scheduler.ensureCoverage({ ...common, range: { start: 60, end: 180 } });
  await new Promise((resolve) => queueMicrotask(resolve));
  scheduler.ensureCoverage({
    ...common,
    range: { start: 120, end: 240 },
    onSettled: (ok) => settled.push(ok),
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(requests, [{ start: 60, end: 180 }, { start: 240, end: 240 }]);
  assert.deepEqual(settled, []);
  releaseFirst();
  await scheduler.drain();
  assert.deepEqual(settled, [true]);
});

test("an exact in-flight join fans failure out to every waiter", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let rejectRequest;
  const blocked = new Promise((resolve, reject) => { rejectRequest = reject; });
  const settled = [];
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 180 },
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: () => blocked,
  };
  scheduler.ensureCoverage({
    ...common,
    onSettled: (ok) => settled.push(["first", ok]),
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  scheduler.ensureCoverage({
    ...common,
    onSettled: (ok) => settled.push(["second", ok]),
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(settled, []);
  rejectRequest(new Error("failed"));
  await scheduler.drain();
  assert.deepEqual(settled, [["first", false], ["second", false]]);
});

test("an unrelated in-flight failure does not settle another requested range", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let rejectUnrelated;
  const unrelated = new Promise((resolve, reject) => { rejectUnrelated = reject; });
  const settled = [];
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: ({ range }) => (range.start === 60 ? unrelated : Promise.resolve({ ok: true })),
  };
  scheduler.ensureCoverage({ ...common, range: { start: 60, end: 120 } });
  await new Promise((resolve) => queueMicrotask(resolve));
  scheduler.ensureCoverage({
    ...common,
    range: { start: 300, end: 360 },
    onSettled: (ok) => settled.push(ok),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(settled, [true]);
  rejectUnrelated(new Error("unrelated failed"));
  await scheduler.drain();
  assert.deepEqual(settled, [true]);
});

test("session epoch blocks a stale response even when transport ignores abort", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  let applied = 0;
  scheduler.ensureCoverage({
    sessionKey: "old",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 120 },
    getCoveredSegments: () => [],
    execute: () => pending,
    apply: () => { applied += 1; },
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  scheduler.setSession("new");
  resolveRequest({ ok: true });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(applied, 0);
});

test("a newer correction revision supersedes an in-flight response in the same session", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let resolveOld;
  const oldRequest = new Promise((resolve) => { resolveOld = resolve; });
  const applied = [];
  const base = {
    sessionKey: "same",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 120 },
    getCoveredSegments: () => [],
    apply: ({ result }) => applied.push(result.revision),
  };
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 1 },
    execute: () => oldRequest,
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 2 },
    execute: async () => ({ revision: 2 }),
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  resolveOld({ revision: 1 });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(applied, [2]);
});
