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
import { createIndicatorRangeBatcher } from "../indicatorRangeBatcher.js";
import { buildIndicatorRangeLifecycleKey } from "../indicatorRangeLifecycle.js";
import { resolveDirectIndicatorRangeRevision } from "../indicatorRangeRequestDedupe.js";
import {
  planVisibleIndicatorHydrationRange,
  resolveInitialHostedRange,
  type IndicatorVisibleNavigationState,
} from "../indicatorRangePlanning.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import type {
  IndicatorRange,
  IndicatorRangeSegment,
  IndicatorRevision,
} from "../indicatorTypes.js";
import { malformedFixture, mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

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

test("monthly coverage uses calendar successors across leap February", () => {
  const jan = Date.UTC(2024, 0, 1) / 1_000;
  const feb = Date.UTC(2024, 1, 1) / 1_000;
  const mar = Date.UTC(2024, 2, 1) / 1_000;
  const apr = Date.UTC(2024, 3, 1) / 1_000;
  const covered = mergeIndicatorRangeSegments([
    { start: jan, end: jan },
    { start: feb, end: feb },
  ], { interval: "1M", step: 2_592_000 });
  assert.deepEqual(covered, [{ start: jan, end: feb }]);
  assert.deepEqual(
    subtractIndicatorRange({ start: jan, end: apr }, covered, { interval: "1M" }),
    [{ start: mar, end: apr }],
  );
  assert.deepEqual(invalidateIndicatorRangeSegments(
    [{ start: jan, end: apr, revision: { correctionRevision: "1" } }],
    { start: mar, end: mar },
    { interval: "1M", revision: { correctionRevision: "2" } },
  ), [{ start: jan, end: feb, revision: { correctionRevision: "2" } }]);
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

test("rightward viewport gestures inside one hydration bucket produce no physical request", async () => {
  const chartData = Array.from({ length: 5_000 }, (_, index) => structuralMock<KlineBar>({
    time: 1_700_000_000 + index * 60,
  }));
  const target = { key: "ema", id: "ema" };
  const scheduler = createIndicatorRangeScheduler<typeof target, IndicatorRange>();
  const initialDesired = mustBeDefined(resolveInitialHostedRange(
    chartData,
    [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
    { logical: { from: 0, to: 419 } },
  ));
  let navigation: IndicatorVisibleNavigationState | null = planVisibleIndicatorHydrationRange({
    chartData,
    desired: initialDesired,
    interval: "1m",
    seriesKey: "one|1m",
  }).nextState;
  let covered = [{ start: initialDesired.start, end: initialDesired.end }];
  const requests: IndicatorRange[] = [];

  const navigate = async (from: number, to: number) => {
    const desired = mustBeDefined(resolveInitialHostedRange(
      chartData,
      [{ id: "ema", engineName: "EMA", params: { period: 20 } }],
      { logical: { from, to } },
    ));
    const plan = planVisibleIndicatorHydrationRange({
      chartData,
      desired,
      interval: "1m",
      previous: navigation,
      seriesKey: "one|1m",
    });
    navigation = plan.nextState;
    scheduler.ensureCoverage({
      sessionKey: "one|1m",
      targets: [target],
      range: plan.range,
      step: 60,
      getCoveredSegments: () => covered,
      execute: async ({ range }) => {
        requests.push(range);
        return range;
      },
      apply: ({ result }) => {
        covered = mergeIndicatorRangeSegments([...covered, result], { step: 60 });
      },
    });
    await scheduler.drain();
  };

  await navigate(420, 839);
  await navigate(840, 1_259);
  await navigate(900, 1_319);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.end, chartData[1_499]?.time);

  await navigate(1_260, 1_679);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], {
    start: chartData[1_500]?.time,
    end: chartData[2_999]?.time,
  });
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

test("initial settlement invalidates stale progressive coverage and joins initial-visible in one physical batch", async () => {
  const targets = [
    { key: "ema", id: "ema" },
    { key: "rsi", id: "rsi" },
  ];
  const revision: IndicatorRevision = { correctionRevision: "settled" };
  const covered = new Map<string, IndicatorRangeSegment[]>(targets.map((target) => [target.key, [{
    start: 420,
    end: 600,
    revision,
  }]]));
  const physicalBatches: Array<Array<{
    clientId: string;
    start: number;
    end: number;
    reason: string;
  }>> = [];
  const batcher = createIndicatorRangeBatcher({
    sendBatch: async ({ requests }) => {
      physicalBatches.push(requests.map((request) => ({
        clientId: request.clientId,
        start: Number(Reflect.get(request, "start")),
        end: Number(Reflect.get(request, "end")),
        reason: String(Reflect.get(request, "reason")),
      })));
      return { results: requests.map(() => ({ payload: { ok: true } })) };
    },
  });
  const scheduler = createIndicatorRangeScheduler<
    (typeof targets)[number],
    { ok: boolean }
  >();

  // A progressive preview covered the suffix, but those values were computed
  // before the retained K-line owner published its repaired prefix. The
  // settlement correction must invalidate that suffix before initial-visible
  // consults coverage; otherwise the stale preview would be treated as warm.
  for (const target of targets) {
    const invalidated = invalidateIndicatorRangeSegments(
      covered.get(target.key),
      { start: 100, end: 180 },
      { cascadeRight: true, revision, step: 60 },
    );
    covered.set(target.key, invalidated);
  }
  assert.deepEqual(Array.from(covered.values()), [[], []]);

  const common = {
    sessionKey: "settled-series",
    targets,
    step: 60,
    revision,
    getCoveredSegments: (target: (typeof targets)[number]) => covered.get(target.key) || [],
    execute: async ({ range, reason, target }: {
      range: IndicatorRange;
      reason: string;
      target: (typeof targets)[number];
    }) => batcher.schedule(structuralMock({
      clientId: target.id,
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
      start: range.start,
      end: range.end,
      reason,
    })),
  };
  scheduler.ensureCoverage({
    ...common,
    range: { start: 100, end: 180 },
    reason: "window-mid-merge",
  });
  scheduler.ensureCoverage({
    ...common,
    range: { start: 100, end: 600 },
    reason: "initial-visible",
  });

  await scheduler.drain();
  assert.equal(physicalBatches.length, 1);
  assert.deepEqual(physicalBatches[0], [
    { clientId: "ema", start: 100, end: 600, reason: "initial-visible" },
    { clientId: "rsi", start: 100, end: 600, reason: "initial-visible" },
  ]);
  batcher.dispose();
});

test("a correction arriving after initial-visible still invalidates and schedules a new suffix", async () => {
  const target = { key: "ema", id: "ema" };
  let revision: IndicatorRevision = { correctionRevision: "initial" };
  let covered: IndicatorRangeSegment[] = [{ start: 100, end: 600, revision }];
  const requests: Array<{ range: IndicatorRange; reason: string }> = [];
  const scheduler = createIndicatorRangeScheduler<typeof target, { ok: boolean }>();
  const execute = async ({ range, reason }: { range: IndicatorRange; reason: string }) => {
    requests.push({ range, reason });
    return { ok: true };
  };

  scheduler.ensureCoverage({
    sessionKey: "late-correction",
    targets: [target],
    range: { start: 100, end: 600 },
    reason: "initial-visible",
    revision,
    getCoveredSegments: () => [],
    execute,
  });
  await scheduler.drain();

  revision = { correctionRevision: "corrected" };
  covered = invalidateIndicatorRangeSegments(
    covered,
    { start: 300, end: 360 },
    { cascadeRight: true, revision, step: 60 },
  );
  assert.deepEqual(covered, [{ start: 100, end: 240, revision }]);
  scheduler.ensureCoverage({
    sessionKey: "late-correction",
    targets: [target],
    range: { start: 300, end: 600 },
    reason: "window-mid-merge",
    revision,
    getCoveredSegments: () => covered,
    execute,
  });
  await scheduler.drain();

  assert.deepEqual(requests, [
    { range: { start: 100, end: 600 }, reason: "initial-visible" },
    { range: { start: 300, end: 600 }, reason: "window-mid-merge" },
  ]);
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
  let oldSignal: AbortSignal | undefined;
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
    execute: ({ signal }) => {
      oldSignal = signal;
      return oldRequest;
    },
  });
  await flushMicrotask();
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 2 },
    execute: async () => ({ revision: 2 }),
  });
  assert.equal(mustBeDefined(oldSignal).aborted, true);
  await flushMicrotask();
  await flushMicrotask();
  mustBeDefined(resolveOld)({ revision: 1 });
  await flushMicrotask();
  assert.deepEqual(applied, [2]);
});

test("revision supersession stays in the demand lifecycle while generation changes abort", async () => {
  const scheduler = createIndicatorRangeScheduler<{ key: string }, { ok: boolean }>();
  const firstLifecycle = buildIndicatorRangeLifecycleKey("series", {
    scope: "viewport",
    generation: 1,
  });
  const nextLifecycle = buildIndicatorRangeLifecycleKey("series", {
    scope: "viewport",
    generation: 2,
  });
  let signal: AbortSignal | undefined;
  let resolveRequest: ((value: { ok: boolean }) => void) | undefined;
  const pending = new Promise<{ ok: boolean }>((resolve) => { resolveRequest = resolve; });
  let applied = 0;
  scheduler.ensureCoverage({
    sessionKey: firstLifecycle,
    targets: [{ key: "ma" }],
    range: { start: 60, end: 120 },
    revision: { correctionRevision: 1 },
    getCoveredSegments: () => [],
    execute: ({ signal: currentSignal }) => {
      signal = currentSignal;
      return pending;
    },
    apply: () => { applied += 1; },
  });
  await flushMicrotask();
  const originalEpoch = scheduler.snapshot().epoch;

  scheduler.supersedeRevision({
    abortInFlight: false,
    revision: { correctionRevision: 2 },
    sessionKey: firstLifecycle,
    targetKeys: ["ma"],
  });
  assert.equal(scheduler.snapshot().epoch, originalEpoch);
  assert.equal(mustBeDefined(signal).aborted, false);

  scheduler.setSession(nextLifecycle);
  assert.ok(scheduler.snapshot().epoch > originalEpoch);
  assert.equal(mustBeDefined(signal).aborted, true);
  mustBeDefined(resolveRequest)({ ok: true });
  await flushMicrotask();
  assert.equal(applied, 0);
});

test("queued correction supersedes stale apply without aborting physical work", async () => {
  const scheduler = createIndicatorRangeScheduler<{ key: string; id: string }, { revision: number }>();
  let resolveOld: ((value: { revision: number }) => void) | undefined;
  const oldRequest = new Promise<{ revision: number }>((resolve) => { resolveOld = resolve; });
  let oldSignal: AbortSignal | undefined;
  const applied: number[] = [];
  const settled: Array<{ ok: boolean; stale: boolean }> = [];
  const base = {
    sessionKey: "same",
    targets: [{ key: "ema", id: "ema" }],
    range: { start: 60, end: 600 },
    getCoveredSegments: () => [],
    apply: ({ result }: { result: { revision: number } }) => { applied.push(result.revision); },
  };
  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 1 },
    execute: ({ signal }) => {
      oldSignal = signal;
      return oldRequest;
    },
    onSettled: (ok, detail) => settled.push({ ok, stale: detail.stale === true }),
  });
  await flushMicrotask();

  scheduler.supersedeRevision({
    abortInFlight: false,
    revision: { correctionRevision: 2 },
    sessionKey: "same",
    targetKeys: ["ema"],
  });
  assert.equal(mustBeDefined(oldSignal).aborted, false);
  mustBeDefined(resolveOld)({ revision: 1 });
  await scheduler.drain();
  assert.deepEqual(applied, []);
  assert.deepEqual(settled, [{ ok: false, stale: true }]);

  scheduler.ensureCoverage({
    ...base,
    revision: { correctionRevision: 2 },
    execute: async () => ({ revision: 2 }),
  });
  await scheduler.drain();
  assert.deepEqual(applied, [2]);
});

test("released WS intent enqueues once at the already-superseded current revision", async () => {
  const scheduler = createIndicatorRangeScheduler<{ key: string }, { revision: number }>();
  const applied: number[] = [];
  const executed: string[] = [];
  const target = { key: "ema" };
  scheduler.supersedeRevision({
    abortInFlight: false,
    revision: { serverEpoch: "boot-1", correctionRevision: 4 },
    sessionKey: "same",
    targetKeys: ["ema"],
  });
  const replayRevision = resolveDirectIndicatorRangeRevision(
    { serverEpoch: "boot-1", correctionRevision: 4 },
    { serverEpoch: "boot-1", correctionRevision: 3 },
  );
  scheduler.ensureCoverage({
    apply: ({ result }) => { applied.push(result.revision); },
    execute: async () => {
      executed.push(replayRevision?.correctionRevision || "legacy");
      return { revision: Number(replayRevision?.correctionRevision) };
    },
    getCoveredSegments: () => [],
    range: { start: 60, end: 600 },
    revision: replayRevision,
    sessionKey: "same",
    targets: [target],
  });
  await scheduler.drain();

  assert.deepEqual(executed, ["4"]);
  assert.deepEqual(applied, [4]);
  assert.equal(scheduler.snapshot().inFlight.length, 0);
  assert.equal(scheduler.snapshot().pending, 0);
});
