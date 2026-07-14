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
import type { IndicatorRange } from "../indicatorTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

const flushMicrotask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const flushTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  const requests: IndicatorRange[] = [];
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

test("malformed non-array targets fail closed without scheduling work", () => {
  const scheduler = createIndicatorRangeScheduler();
  const options = malformedFixture<Parameters<typeof scheduler.ensureCoverage>[0]>({
    sessionKey: "one",
    targets: { length: 1 },
    range: { start: 60, end: 180 },
    execute: async () => ({ ok: true }),
  });

  assert.deepEqual(scheduler.ensureCoverage(options), {
    accepted: false,
    epoch: 0,
    queued: 0,
  });
});

test("overlapping intents in the same turn are unioned into one request", async () => {
  const scheduler = createIndicatorRangeScheduler();
  const requests: IndicatorRange[] = [];
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: async ({ range }: { range: IndicatorRange }) => requests.push(range),
  };
  scheduler.ensureCoverage({ ...common, range: { start: 60, end: 180 } });
  scheduler.ensureCoverage({ ...common, range: { start: 120, end: 300 } });
  await scheduler.drain();
  assert.deepEqual(requests, [{ start: 60, end: 300 }]);
});

test("in-flight coverage prevents overlap and requests only the new tail", async () => {
  const scheduler = createIndicatorRangeScheduler();
  const requests: IndicatorRange[] = [];
  const settled: boolean[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const execute = async ({ range }: { range: IndicatorRange }) => {
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
  await flushMicrotask();
  scheduler.ensureCoverage({
    ...common,
    range: { start: 120, end: 240 },
    onSettled: (ok) => settled.push(ok),
  });
  await flushMicrotask();
  assert.deepEqual(requests, [{ start: 60, end: 180 }, { start: 240, end: 240 }]);
  assert.deepEqual(settled, []);
  mustBeDefined(releaseFirst)();
  await scheduler.drain();
  assert.deepEqual(settled, [true]);
});

test("an exact in-flight join fans failure out to every waiter", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let rejectRequest: ((reason?: unknown) => void) | undefined;
  const blocked = new Promise<unknown>((_resolve, reject) => { rejectRequest = reject; });
  const settled: Array<[string, boolean]> = [];
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
  await flushMicrotask();
  scheduler.ensureCoverage({
    ...common,
    onSettled: (ok) => settled.push(["second", ok]),
  });
  await flushMicrotask();
  assert.deepEqual(settled, []);
  mustBeDefined(rejectRequest)(new Error("failed"));
  await scheduler.drain();
  assert.deepEqual(settled, [["first", false], ["second", false]]);
});

test("an unrelated in-flight failure does not settle another requested range", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let rejectUnrelated: ((reason?: unknown) => void) | undefined;
  const unrelated = new Promise<unknown>((_resolve, reject) => { rejectUnrelated = reject; });
  const settled: boolean[] = [];
  const common = {
    sessionKey: "one",
    targets: [{ key: "ma", id: "ma" }],
    step: 60,
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: ({ range }: { range: IndicatorRange }) => (
      range.start === 60 ? unrelated : Promise.resolve({ ok: true })
    ),
  };
  scheduler.ensureCoverage({ ...common, range: { start: 60, end: 120 } });
  await flushMicrotask();
  scheduler.ensureCoverage({
    ...common,
    range: { start: 300, end: 360 },
    onSettled: (ok) => settled.push(ok),
  });
  await flushTimer();
  assert.deepEqual(settled, [true]);
  mustBeDefined(rejectUnrelated)(new Error("unrelated failed"));
  await scheduler.drain();
  assert.deepEqual(settled, [true]);
});

test("session epoch blocks a stale response even when transport ignores abort", async () => {
  const scheduler = createIndicatorRangeScheduler();
  let resolveRequest: ((value: { ok: boolean }) => void) | undefined;
  const pending = new Promise<{ ok: boolean }>((resolve) => { resolveRequest = resolve; });
  let applied = 0;
  scheduler.ensureCoverage({
    sessionKey: "old",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 120 },
    getCoveredSegments: () => [],
    execute: () => pending,
    apply: () => { applied += 1; },
  });
  await flushMicrotask();
  scheduler.setSession("new");
  mustBeDefined(resolveRequest)({ ok: true });
  await flushMicrotask();
  assert.equal(applied, 0);
});

test("a newer correction revision supersedes an in-flight response in the same session", async () => {
  const scheduler = createIndicatorRangeScheduler<{ key: string; id: string }, { revision: number }>();
  let resolveOld: ((value: { revision: number }) => void) | undefined;
  const oldRequest = new Promise<{ revision: number }>((resolve) => { resolveOld = resolve; });
  const applied: number[] = [];
  const base = {
    sessionKey: "same",
    targets: [{ key: "ma", id: "ma" }],
    range: { start: 60, end: 120 },
    getCoveredSegments: () => [],
    apply: ({ result }: { result: { revision: number } }) => { applied.push(result.revision); },
  };
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 1 },
    execute: () => oldRequest,
  });
  await flushMicrotask();
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 2 },
    execute: async () => ({ revision: 2 }),
  });
  await flushMicrotask();
  await flushMicrotask();
  mustBeDefined(resolveOld)({ revision: 1 });
  await flushMicrotask();
  assert.deepEqual(applied, [2]);
});
