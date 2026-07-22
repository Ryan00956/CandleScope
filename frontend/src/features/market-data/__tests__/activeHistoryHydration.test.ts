import assert from "node:assert/strict";
import test from "node:test";

import { epochSeconds, partialMock } from "../../../test/testHelpers.js";
import type { CommitChartData, KlineApi, KlineFetchResult } from "../klineContracts.js";
import { SeriesDataFeed as ProductionSeriesDataFeed } from "../feed/seriesDataFeed.js";
import type { SeriesDataFeed } from "../feed/seriesDataFeed.js";
import { ForegroundPreloadGate } from "../foregroundPreloadGate.js";
import type { MarketSeries } from "../marketDataTypes.js";
import {
  activeHistoryHydrationContinuationDelayMs,
  activeHistoryHydrationRetryDelayMs,
  runActiveHistoryHydration,
  shouldStartActiveHistoryHydration,
} from "../useActiveChartHistoryHydration.js";

const SERIES: MarketSeries = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
  interval: "1m",
};

function settledResult(overrides: Partial<KlineFetchResult> = {}): KlineFetchResult {
  return {
    data: [{ time: epochSeconds(1), close: 1 }],
    rows: [{ time: epochSeconds(1), close: 1 }],
    complete: true,
    retryable: false,
    history_state: "ready",
    verified_contiguous: true,
    all_rows_final: true,
    has_tail_gap: false,
    truncated: false,
    missing_ranges: [],
    active: true,
    stale: false,
    ...overrides,
  } as KlineFetchResult;
}

function feedWith(getBars: (...args: unknown[]) => Promise<KlineFetchResult>): SeriesDataFeed {
  return {
    currentEpoch: () => 4,
    isCurrent: (_series: MarketSeries, epoch: number) => epoch === 4,
    shouldCommitActive: () => true,
    getBars,
  } as unknown as SeriesDataFeed;
}

test("hydration starts only after the viewport contract is validated", () => {
  const decision = (validatedCountBack: number | null) => shouldStartActiveHistoryHydration({
    enabled: true,
    historyComplete: true,
    historyRepairPending: false,
    viewportCountBack: 500,
    targetCountBack: 1_500,
    validatedCountBack,
  });

  assert.equal(decision(null), false, "latest-only paint is not a settled viewport");
  assert.equal(decision(499), false);
  assert.equal(decision(500), true);
  assert.equal(decision(1_500), false, "a fully warm series needs no hydration");
  assert.equal(shouldStartActiveHistoryHydration({
    enabled: true,
    historyComplete: true,
    historyRepairPending: false,
    viewportCountBack: 422,
    targetCountBack: 422,
    validatedCountBack: 422,
  }), false, "budget-limited intervals have no second phase");
  assert.equal(shouldStartActiveHistoryHydration({
    enabled: true,
    historyComplete: false,
    historyRepairPending: true,
    viewportCountBack: 500,
    targetCountBack: 1_500,
    validatedCountBack: 500,
  }), false, "repair-pending metadata cannot admit hydration");
});

test("active history hydration bypasses quiet dwell and publishes one complete prepend", async () => {
  const gate = new ForegroundPreloadGate(30_000);
  gate.requireQuietDwell();
  assert.equal(gate.tryAcquirePreload("watchlist"), null);
  const requests: unknown[][] = [];
  const commits: Parameters<CommitChartData>[] = [];
  const outcome = await runActiveHistoryHydration({
    series: SERIES,
    sessionKey: "session-a",
    targetCountBack: 1_500,
    priorityGate: gate,
    seriesDataFeed: feedWith(async (...args) => {
      requests.push(args);
      assert.equal(gate.tryAcquirePreload("ordinary-preload"), null);
      return settledResult();
    }),
    commitMergedChartData: (...args) => { commits.push(args); },
  });

  assert.equal(outcome, "complete");
  assert.equal(requests.length, 1);
  const options = requests[0]?.[1] as Record<string, unknown>;
  assert.deepEqual({
    countBack: options.countBack,
    maxWaitMs: options.maxWaitMs,
    intent: options.intent,
    commit: options.commit,
    priority: options.priority,
  }, {
    countBack: 1_500,
    maxWaitMs: 0,
    intent: "active_hydration",
    commit: "none",
    priority: "hydrate",
  });
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.[2].length, 1);
  assert.equal(commits[0]?.[3].historyValidatedCountBack, 1_500);
  assert.equal(commits[0]?.[3].historyComplete, true);
});

test("foreground synchronously aborts hydration and fences its late result", async () => {
  const gate = new ForegroundPreloadGate(0);
  const commits: Parameters<CommitChartData>[] = [];
  const outcome = await runActiveHistoryHydration({
    series: SERIES,
    sessionKey: "session-b",
    targetCountBack: 1_500,
    priorityGate: gate,
    seriesDataFeed: feedWith(async (_series, rawOptions) => {
      const options = rawOptions as { signal: AbortSignal };
      const foreground = gate.enterForeground("symbol-switch");
      assert.equal(options.signal.aborted, true);
      foreground.release();
      return settledResult();
    }),
    commitMergedChartData: (...args) => { commits.push(args); },
  });

  assert.equal(outcome, "preempted");
  assert.equal(commits.length, 0);
});

test("pending hydration keeps one lease across bounded contract probes", async () => {
  const gate = new ForegroundPreloadGate(0);
  let calls = 0;
  const outcome = await runActiveHistoryHydration({
    series: SERIES,
    sessionKey: "session-c",
    targetCountBack: 1_500,
    priorityGate: gate,
    seriesDataFeed: feedWith(async () => {
      calls += 1;
      return calls === 1
        ? settledResult({
            complete: false,
            retryable: true,
            history_state: "pending",
            verified_contiguous: false,
            all_rows_final: false,
            has_tail_gap: true,
            missing_ranges: [{ start_ms: 0, end_ms: 1, reason: "pending" }],
          })
        : settledResult();
    }),
    commitMergedChartData: () => {},
    sleep: async (_delayMs, signal) => !signal.aborted,
  });

  assert.equal(outcome, "complete");
  assert.equal(calls, 2);
  assert.deepEqual(
    [0, 1, 2, 8].map(activeHistoryHydrationRetryDelayMs),
    [750, 1_500, 3_000, 5_000],
  );
});

test("real SeriesDataFeed keeps partial probes silent and publishes completion once", async () => {
  const gate = new ForegroundPreloadGate(0);
  let calls = 0;
  const hiddenWrites: string[] = [];
  const visibleCommits: Parameters<CommitChartData>[] = [];
  const feed = new ProductionSeriesDataFeed({
    api: partialMock<KlineApi>({
      fetchKlinesHistory: async () => {
        calls += 1;
        return calls === 1
          ? settledResult({
              complete: false,
              retryable: true,
              history_state: "pending",
              verified_contiguous: false,
              all_rows_final: false,
              has_tail_gap: true,
              missing_ranges: [{ start_ms: 0, end_ms: 1, reason: "pending" }],
            })
          : settledResult();
      },
    }),
    getActiveSeries: () => SERIES,
    mergeCacheData: () => { hiddenWrites.push("cache"); },
    commitMergedChartData: () => { hiddenWrites.push("active"); },
  });

  const outcome = await runActiveHistoryHydration({
    series: SERIES,
    sessionKey: "session-real-feed",
    targetCountBack: 1_500,
    priorityGate: gate,
    seriesDataFeed: feed,
    commitMergedChartData: (...args) => { visibleCommits.push(args); },
    sleep: async (_delayMs, signal) => !signal.aborted,
  });

  assert.equal(outcome, "complete");
  assert.equal(calls, 2);
  assert.deepEqual(hiddenWrites, []);
  assert.equal(visibleCommits.length, 1);
  assert.equal(visibleCommits[0]?.[3].historyValidatedCountBack, 1_500);
});

test("a bounded pending round schedules eventual hydration with capped backoff", async () => {
  const gate = new ForegroundPreloadGate(0);
  let nowMs = 0;
  const outcome = await runActiveHistoryHydration({
    series: SERIES,
    sessionKey: "session-d",
    targetCountBack: 1_500,
    priorityGate: gate,
    seriesDataFeed: feedWith(async () => settledResult({
      complete: false,
      retryable: true,
      history_state: "pending",
      verified_contiguous: false,
      all_rows_final: false,
      has_tail_gap: true,
      missing_ranges: [{ start_ms: 0, end_ms: 1, reason: "pending" }],
    })),
    commitMergedChartData: () => {},
    maxDurationMs: 1,
    now: () => nowMs,
    sleep: async (delayMs, signal) => {
      nowMs += delayMs;
      return !signal.aborted;
    },
  });

  assert.equal(outcome, "pending");
  assert.deepEqual(
    [0, 1, 2, 8].map((round) => (
      activeHistoryHydrationContinuationDelayMs(outcome, round)
    )),
    [5_000, 10_000, 20_000, 30_000],
  );
  assert.equal(activeHistoryHydrationContinuationDelayMs("complete", 0), null);
  assert.equal(activeHistoryHydrationContinuationDelayMs("preempted", 0), 250);
});
