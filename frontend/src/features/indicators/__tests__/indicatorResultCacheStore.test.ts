import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import {
  acquireActiveIndicatorCacheLeases,
  cacheIndicatorSnapshot as cacheIndicatorSnapshotProduction,
  buildIndicatorCacheHydrationSignature,
  buildIndicatorResultCacheKey,
  getCachedIndicatorComputedSegments,
  getCachedIndicatorMetadata,
  getCachedIndicatorResult,
  getCachedIndicatorRevision,
  invalidateCachedIndicatorRange,
  patchCachedIndicatorResult as patchCachedIndicatorResultProduction,
  replaceCachedIndicatorRange as replaceCachedIndicatorRangeProduction,
  removeCachedIndicatorResult,
  resetIndicatorResultCache,
  snapshotIndicatorResultCacheEntries,
  snapshotIndicatorResultCacheDiagnostics,
  trimIndicatorResultCacheEntries,
  upsertCachedIndicatorLinePoint,
} from "../indicatorResultCacheStore.js";
import {
  klineDependencyKey,
  registerCacheResource,
  resetCacheRegistry,
  unregisterCacheResource,
} from "../../cache-gc/cacheRegistry.js";
import type { NormalizedIndicatorPayload } from "../indicatorTypes.js";
import { mustBeDefined, structuralMock } from "../../../test/testHelpers.js";

type CacheSnapshotParams = Parameters<typeof cacheIndicatorSnapshotProduction>;
type ReplaceRangeParams = Parameters<typeof replaceCachedIndicatorRangeProduction>;
type PatchResultParams = Parameters<typeof patchCachedIndicatorResultProduction>;

function cacheIndicatorSnapshot(
  indicator: CacheSnapshotParams[0],
  context: CacheSnapshotParams[1],
  payload: object,
) {
  return cacheIndicatorSnapshotProduction(
    indicator,
    context,
    structuralMock<NormalizedIndicatorPayload>(payload),
  );
}

function replaceCachedIndicatorRange(
  indicator: ReplaceRangeParams[0],
  context: ReplaceRangeParams[1],
  payload: object,
  range: ReplaceRangeParams[3],
  options?: object,
) {
  return replaceCachedIndicatorRangeProduction(
    indicator,
    context,
    structuralMock<NormalizedIndicatorPayload>(payload),
    range,
    options ? structuralMock<NonNullable<ReplaceRangeParams[4]>>(options) : undefined,
  );
}

function patchCachedIndicatorResult(
  indicator: PatchResultParams[0],
  context: PatchResultParams[1],
  payload: object,
  options?: object,
) {
  return patchCachedIndicatorResultProduction(
    indicator,
    context,
    structuralMock<NormalizedIndicatorPayload>(payload),
    options ? structuralMock<NonNullable<PatchResultParams[3]>>(options) : undefined,
  );
}

const baseContext = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
  interval: "1m",
  candleUpColor: "#22c55e",
  candleDownColor: "#ef4444",
};

const maIndicator = {
  id: "ma",
  engineName: "MA",
  script: "# __ENGINE__:MA\nplot(close)",
  params: { period: 20 },
};

function registerBaseKline() {
  registerCacheResource("chart-data-cache", "binance-spot-BTCUSDT-1m", {
    type: "kline",
    dependencyKey: klineDependencyKey(baseContext),
    bars: 100,
  });
}

test("indicator result cache is scoped by chart series context", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
    }],
  });

  assert.equal(
    getCachedIndicatorResult(maIndicator, { ...baseContext, symbol: "ETHUSDT" }),
    null,
  );
  assert.deepEqual(
    mustBeDefined(
      mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext))
        .normalized.lines[0],
    ).data,
    [{ time: 10, value: 100 }],
  );
});

test("indicator result cache canonicalizes fixed-duration aliases", () => {
  assert.equal(
    buildIndicatorResultCacheKey(maIndicator, { ...baseContext, interval: "60m" }),
    buildIndicatorResultCacheKey(maIndicator, { ...baseContext, interval: "1h" }),
  );
});

test("script cache identity is isolated by descriptor language", () => {
  const script = { id: "script-1", script: "plot(close)", params: {} };

  assert.notEqual(
    buildIndicatorResultCacheKey({ ...script, language: "pyne" }, baseContext),
    buildIndicatorResultCacheKey(
      { ...script, language: "community-lang" },
      baseContext,
    ),
  );
});

test("cache hydration identity changes on re-add but ignores runtime line updates", () => {
  const absent = buildIndicatorCacheHydrationSignature([], baseContext);
  const added = buildIndicatorCacheHydrationSignature([maIndicator], baseContext);
  const rendered = buildIndicatorCacheHydrationSignature([{
    ...maIndicator,
    lines: [{ outputName: "ma", data: [{ time: 10, value: 100 }] }],
    error: null,
  }], baseContext);

  assert.notEqual(added, absent);
  assert.equal(rendered, added);
});

test("indicator result cache isolates hosted and explicit local execution", () => {
  const hosted = buildIndicatorResultCacheKey(maIndicator, baseContext);
  const local = buildIndicatorResultCacheKey({
    ...maIndicator,
    executionTarget: "local",
  }, baseContext);

  assert.notEqual(local, hosted);
});

test("removing a local result cannot delete the hosted cache identity", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  const local = { ...maIndicator, executionTarget: "local" as const };
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ data: [{ time: 10, value: 100 }] }],
  });
  cacheIndicatorSnapshot(local, baseContext, {
    lines: [{ data: [{ time: 10, value: 200 }] }],
  });

  assert.equal(removeCachedIndicatorResult(local, baseContext), true);
  assert.equal(getCachedIndicatorResult(local, baseContext), null);
  assert.equal(
    mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext))
      .normalized.lines[0]?.data[0]?.value,
    100,
  );
});

test("cache owns and freezes source data while repeated reads share one stable result", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  const source = structuralMock<NormalizedIndicatorPayload>({
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
    }],
    markers: [{
      id: "cross",
      indicatorId: "wrong-owner",
      data: [{ time: 10, text: "buy" }],
    }],
    fills: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
  });
  const written = cacheIndicatorSnapshotProduction(maIndicator, baseContext, source);

  mustBeDefined(source.lines[0]).data[0]!.value = 999;
  source.lines.push({ data: [{ time: 20, value: 200 }] });
  mustBeDefined(mustBeDefined(source.markers[0]).data)[0]!.text = "changed";

  const first = mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext));
  const second = mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext));
  assert.strictEqual(second, first);
  assert.strictEqual(second.normalized, first.normalized);
  assert.strictEqual(second.normalized.lines[0]?.data, first.normalized.lines[0]?.data);
  assert.deepEqual(first.normalized.lines[0]?.data, [{ time: 10, value: 100 }]);
  assert.deepEqual(first.normalized.markers, [{
    id: "cross",
    indicatorId: "ma",
    data: [{ time: 10, text: "buy" }],
  }]);
  assert.equal(Object.isFrozen(written), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.normalized), true);
  assert.equal(Object.isFrozen(first.normalized.lines), true);
  assert.equal(Object.isFrozen(first.normalized.lines[0]?.data), true);
  assert.equal(Object.isFrozen(first.normalized.lines[0]?.data[0]), true);
  assert.equal(Reflect.set(mustBeDefined(first.normalized.lines[0]?.data[0]), "value", 7), false);
});

test("cache patch publishes a new version while preserving old and untouched identities", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [
      {
        outputName: "fast",
        data: [{ time: 10, value: 1 }, { time: 20, value: 2 }],
      },
      {
        outputName: "slow",
        data: [{ time: 10, value: 10 }],
      },
    ],
  });
  const before = mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext));
  const beforeFast = mustBeDefined(before.normalized.lines[0]);
  const beforeSlow = mustBeDefined(before.normalized.lines[1]);

  patchCachedIndicatorResult(maIndicator, baseContext, {
    lines: [{ outputName: "fast", data: [{ time: 20, value: 200 }] }],
  });

  const after = mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext));
  const afterFast = mustBeDefined(after.normalized.lines[0]);
  const afterSlow = mustBeDefined(after.normalized.lines[1]);
  assert.notStrictEqual(after, before);
  assert.ok(after.contentVersion > before.contentVersion);
  assert.deepEqual(beforeFast.data, [{ time: 10, value: 1 }, { time: 20, value: 2 }]);
  assert.deepEqual(afterFast.data, [{ time: 10, value: 1 }, { time: 20, value: 200 }]);
  assert.strictEqual(afterFast.data[0], beforeFast.data[0]);
  assert.strictEqual(afterSlow, beforeSlow);
  assert.strictEqual(afterSlow.data, beforeSlow.data);
  assert.equal(Object.isFrozen(afterFast.data), true);
});

test("cache metadata and revision reads stay lightweight and payload-free", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  cacheIndicatorSnapshotProduction(
    maIndicator,
    baseContext,
    structuralMock<NormalizedIndicatorPayload>({
      lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }] }],
    }),
    [],
    { revision: { serverEpoch: "boot-1", correctionRevision: "2" } },
  );

  const first = mustBeDefined(getCachedIndicatorMetadata(maIndicator, baseContext));
  const second = mustBeDefined(getCachedIndicatorMetadata(maIndicator, baseContext));
  assert.strictEqual(second, first);
  assert.equal("normalized" in first, false);
  assert.equal(first.contentVersion > 0, true);
  assert.strictEqual(getCachedIndicatorRevision(maIndicator, baseContext), first.revision);
  assert.deepEqual(first.revision, {
    serverEpoch: "boot-1",
    correctionRevision: "2",
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.revision), true);
});

test("cache content versions remain monotonic across resets", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }] }],
  });
  const before = mustBeDefined(getCachedIndicatorMetadata(maIndicator, baseContext));

  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 20, value: 2 }] }],
  });
  const after = mustBeDefined(getCachedIndicatorMetadata(maIndicator, baseContext));

  assert.ok(after.contentVersion > before.contentVersion);
});

test("replaceCachedIndicatorRange replaces only the requested time window", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [
        { time: 10, value: 1 },
        { time: 20, value: 2 },
        { time: 30, value: 3 },
      ],
    }],
  });
  replaceCachedIndicatorRange(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 20, value: 200 }],
    }],
  }, { start: 20, end: 30 });

  assert.deepEqual(
    mustBeDefined(
      mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext))
        .normalized.lines[0],
    ).data,
    [
      { time: 10, value: 1 },
      { time: 20, value: 200 },
    ],
  );
});

test("successful range records computed coverage even when warmup produces no output points", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  replaceCachedIndicatorRange(maIndicator, baseContext, { lines: [] }, { start: 60, end: 180 }, {
    revision: { serverEpoch: "boot-1", correctionRevision: 4 },
  });

  assert.deepEqual(getCachedIndicatorComputedSegments(maIndicator, baseContext), [{
    start: 60,
    end: 180,
    revision: { serverEpoch: "boot-1", correctionRevision: "4" },
  }]);
  assert.equal(mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext)).outputCoverage, null);
});

test("computed coverage is revision-aware and dirty invalidation keeps only the safe prefix", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  replaceCachedIndicatorRange(maIndicator, baseContext, { lines: [] }, { start: 60, end: 300 }, {
    revision: { correctionRevision: 1 },
  });
  assert.deepEqual(
    getCachedIndicatorComputedSegments(
      maIndicator,
      baseContext,
      structuralMock<NonNullable<Parameters<typeof getCachedIndicatorComputedSegments>[2]>>({ correctionRevision: 2 }),
    ),
    [],
  );

  invalidateCachedIndicatorRange(
    maIndicator,
    baseContext,
    { start: 180, end: 180 },
    structuralMock<NonNullable<Parameters<typeof invalidateCachedIndicatorRange>[3]>>({
      revision: { correctionRevision: 2 },
    }),
  );
  assert.deepEqual(
    getCachedIndicatorComputedSegments(
      maIndicator,
      baseContext,
      structuralMock<NonNullable<Parameters<typeof getCachedIndicatorComputedSegments>[2]>>({ correctionRevision: 2 }),
    ),
    [{ start: 60, end: 120, revision: { correctionRevision: "2" } }],
  );
});

test("warm indicator dependencies survive product switches and remain product-scoped", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  const ethContext = { ...baseContext, symbol: "ETHUSDT" };
  registerBaseKline();
  registerCacheResource("chart-data-cache", "binance-spot-ETHUSDT-1m", {
    type: "kline",
    dependencyKey: klineDependencyKey(ethContext),
    bars: 100,
  });
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 100 }] }],
  });
  cacheIndicatorSnapshot(maIndicator, ethContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 200 }] }],
  });

  assert.deepEqual(
    mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext)).normalized.lines[0]?.data,
    [{ time: 10, value: 100 }],
  );
  assert.deepEqual(
    mustBeDefined(getCachedIndicatorResult(maIndicator, ethContext)).normalized.lines[0]?.data,
    [{ time: 10, value: 200 }],
  );

  unregisterCacheResource("chart-data-cache", "binance-spot-BTCUSDT-1m");
  assert.equal(getCachedIndicatorResult(maIndicator, baseContext), null);
  assert.deepEqual(
    mustBeDefined(getCachedIndicatorResult(maIndicator, ethContext)).normalized.lines[0]?.data,
    [{ time: 10, value: 200 }],
  );
});

test("bounded correction rebases dirty-outside segments and leaves only the dirty hole", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  replaceCachedIndicatorRange(maIndicator, baseContext, { lines: [] }, { start: 60, end: 600 }, {
    revision: { serverEpoch: "boot-1", correctionRevision: 1 },
  });
  invalidateCachedIndicatorRange(
    maIndicator,
    baseContext,
    { start: 240, end: 360 },
    {
      cascadeRight: false,
      revision: { serverEpoch: "boot-1", correctionRevision: "2" },
    },
  );

  const revision = structuralMock<
    NonNullable<Parameters<typeof getCachedIndicatorComputedSegments>[2]>
  >({ serverEpoch: "boot-1", correctionRevision: "2" });
  assert.deepEqual(
    getCachedIndicatorComputedSegments(maIndicator, baseContext, revision),
    [
      {
        start: 60,
        end: 180,
        revision: { serverEpoch: "boot-1", correctionRevision: "2" },
      },
      {
        start: 420,
        end: 600,
        revision: { serverEpoch: "boot-1", correctionRevision: "2" },
      },
    ],
  );
});

test("91m mid-window invalidation drops cached coverage through the right edge", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  const context = { ...baseContext, interval: "91m" };
  registerCacheResource("chart-data-cache", "binance-spot-BTCUSDT-91m", {
    type: "kline",
    dependencyKey: klineDependencyKey(context),
    bars: 100,
  });
  const step = 91 * 60;
  const start = 1_700_000_000;
  const dirtyStart = start + step * 2;
  const end = start + step * 5;

  replaceCachedIndicatorRange(maIndicator, context, { lines: [] }, { start, end });
  invalidateCachedIndicatorRange(
    maIndicator,
    context,
    { start: dirtyStart, end: dirtyStart + step },
    { cascadeRight: true },
  );

  assert.deepEqual(getCachedIndicatorComputedSegments(maIndicator, context), [{
    start,
    end: dirtyStart - step,
  }]);
});

test("upsertCachedIndicatorLinePoint preserves consecutive realtime bars", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 1 }],
    }],
  });

  upsertCachedIndicatorLinePoint(maIndicator, baseContext, { ma: 2 }, 20);
  upsertCachedIndicatorLinePoint(maIndicator, baseContext, { ma: 3 }, 30);

  assert.deepEqual(
    mustBeDefined(
      mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext))
        .normalized.lines[0],
    ).data,
    [
      { time: 10, value: 1 },
      { time: 20, value: 2 },
      { time: 30, value: 3 },
    ],
  );
  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  const coverage = mustBeDefined(entry.coverage);
  assert.equal(coverage.firstTime, 10);
  assert.equal(coverage.lastTime, 30);
  assert.equal(coverage.points, 3);
});

test("indicator result cache coverage handles large multiline outputs", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  const lines = ["upper", "basis", "lower"].map((outputName, lineIndex) => ({
    outputName,
    data: Array.from({ length: 50_000 }, (_, index) => ({
      time: index + 1,
      value: index + lineIndex,
    })),
  }));

  cacheIndicatorSnapshot(maIndicator, baseContext, { lines });

  const cached = mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext));
  const readStartedAt = performance.now();
  for (let index = 0; index < 12; index += 1) {
    assert.strictEqual(getCachedIndicatorResult(maIndicator, baseContext), cached);
  }
  const readElapsedMs = performance.now() - readStartedAt;
  assert.ok(
    readElapsedMs < 100,
    `stable 150k-point cache reads took ${readElapsedMs.toFixed(1)}ms`,
  );

  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  const coverage = mustBeDefined(entry.coverage);
  assert.equal(coverage.firstTime, 1);
  assert.equal(coverage.lastTime, 50_000);
  assert.equal(coverage.points, 150_000);
});

test("cached outputs are returned with the active indicator id", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [],
    markers: [{
      id: "cross",
      indicatorId: "ma",
      data: [{ time: 10, text: "buy" }],
    }],
  });

  const cached = getCachedIndicatorResult(maIndicator, baseContext);
  assert.deepEqual(mustBeDefined(cached).normalized.markers, [{
    id: "cross",
    indicatorId: "ma",
    data: [{ time: 10, text: "buy" }],
  }]);
});

test("indicator result cache is not used without its kline dependency", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();

  assert.equal(cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
    }],
  }), null);

  registerBaseKline();
  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
    }],
  });
  unregisterCacheResource("chart-data-cache", "binance-spot-BTCUSDT-1m");

  assert.equal(getCachedIndicatorResult(maIndicator, baseContext), null);
});

test("safe line-only indicator cache can trim old range without deleting entry", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [
        { time: 10, value: 1 },
        { time: 20, value: 2 },
        { time: 30, value: 3 },
      ],
    }],
  });

  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.equal(entry.trimSafety.safeRangeTrim, true);
  trimIndicatorResultCacheEntries([{ key: entry.key, action: "trim-range", keepStart: 20 }]);

  assert.deepEqual(
    mustBeDefined(
      mustBeDefined(getCachedIndicatorResult(maIndicator, baseContext))
        .normalized.lines[0],
    ).data,
    [
      { time: 20, value: 2 },
      { time: 30, value: 3 },
    ],
  );
});

test("complex indicator outputs are not range-trimmed", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }, { time: 20, value: 2 }] }],
    markers: [{ id: "m", data: [{ time: 10, text: "x" }] }],
  });

  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.equal(entry.trimSafety.safeRangeTrim, false);
  const result = trimIndicatorResultCacheEntries([
    { key: entry.key, action: "trim-range", keepStart: 20 },
  ]);

  assert.equal(result.removedCount, 0);
  assert.equal(result.skipped[0]?.reason, "trim-no-longer-safe");
  assert.notEqual(getCachedIndicatorResult(maIndicator, baseContext), null);
});

test("indicator diagnostics account for nested complex output data", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 1 }, { time: 20, value: 2 }],
      colorData: [{ time: 10, color: "red" }, { time: 20, color: "green" }],
    }],
    markers: [{
      id: "m",
      data: [{ time: 10, text: "a" }, { time: 20, text: "b" }],
    }],
    bgcolors: [{
      id: "bg",
      regions: [{ time: 10, color: "red" }, { time: 20, color: "green" }],
    }],
  });

  const diagnostics = snapshotIndicatorResultCacheDiagnostics();
  const entry = mustBeDefined(diagnostics.entries[0]);
  assert.equal(entry.points, 2);
  assert.equal(entry.items, 8);
  assert.equal(entry.estimatedBytes, 1_120);
  assert.equal(diagnostics.totalItems, 8);
  assert.equal(diagnostics.estimatedBytes, 1_120);
});

test("indicator diagnostics expose an exact safe trim plan", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{
      outputName: "ma",
      data: [
        { time: 10, value: 1 },
        { time: 20, value: 2 },
        { time: 30, value: 3 },
        { time: 40, value: 4 },
      ],
      colorData: [
        { time: 10, color: "red" },
        { time: 20, color: "red" },
        { time: 30, color: "green" },
        { time: 40, color: "green" },
      ],
    }],
  });

  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.deepEqual(entry.trimPlan, {
    keepStart: 25,
    removedPoints: 2,
    removedItems: 2,
    removedEstimatedBytes: 400,
  });
});

test("indicator GC rejects a victim after the cache generation changes", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }] }],
  });
  const entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.notEqual(getCachedIndicatorResult(maIndicator, baseContext), null);

  const result = trimIndicatorResultCacheEntries([{
    key: entry.key,
    action: "delete-entry",
    generation: entry.generation,
  }]);

  assert.equal(result.removedCount, 0);
  assert.equal(result.skipped[0]?.reason, "generation-changed");
  assert.notEqual(getCachedIndicatorResult(maIndicator, baseContext), null);
});

test("active indicator lease publishes active diagnostics and survives resource recreation", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  const release = acquireActiveIndicatorCacheLeases(
    [maIndicator],
    baseContext,
    "test-active-runtime",
  );
  try {
    cacheIndicatorSnapshot(maIndicator, baseContext, {
      lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }] }],
    });
    let entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
    assert.equal(entry.tier, "active");
    assert.equal(entry.activeLeaseCount, 1);

    resetIndicatorResultCache();
    cacheIndicatorSnapshot(maIndicator, baseContext, {
      lines: [{ outputName: "ma", data: [{ time: 20, value: 2 }] }],
    });
    entry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
    assert.equal(entry.tier, "active");
    assert.equal(entry.activeLeaseCount, 1);
  } finally {
    release();
  }

  const releasedEntry = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.equal(releasedEntry.tier, "warm");
  assert.equal(releasedEntry.activeLeaseCount, 0);
});

test("indicator GC rechecks an active lease acquired after planning", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  cacheIndicatorSnapshot(maIndicator, baseContext, {
    lines: [{ outputName: "ma", data: [{ time: 10, value: 1 }] }],
  });
  const planned = mustBeDefined(snapshotIndicatorResultCacheDiagnostics().entries[0]);
  assert.equal(planned.tier, "warm");

  const release = acquireActiveIndicatorCacheLeases(
    [maIndicator],
    baseContext,
    "test-toctou-runtime",
  );
  try {
    const result = trimIndicatorResultCacheEntries([{
      key: planned.key,
      action: "delete-entry",
      generation: planned.generation,
      lastAccessMs: planned.lastAccessMs,
    }]);
    assert.equal(result.removedCount, 0);
    assert.equal(result.skipped[0]?.reason, "active-lease");
    assert.equal(snapshotIndicatorResultCacheEntries().length, 1);
  } finally {
    release();
  }
});

test("indicator cache capacity eviction skips active indicator leases", () => {
  resetIndicatorResultCache();
  resetCacheRegistry();
  registerBaseKline();

  const release = acquireActiveIndicatorCacheLeases(
    [maIndicator],
    baseContext,
    "test-capacity-runtime",
  );
  try {
    cacheIndicatorSnapshot(maIndicator, baseContext, {
      lines: [{ outputName: "ma", data: [{ time: 1, value: 1 }] }],
    });
    for (let index = 0; index < 80; index += 1) {
      cacheIndicatorSnapshot({
        ...maIndicator,
        id: `other-${index}`,
      }, baseContext, {
        lines: [{ outputName: "ma", data: [{ time: index + 2, value: index }] }],
      });
    }

    const keys = new Set(snapshotIndicatorResultCacheEntries().map((entry) => entry.key));
    assert.equal(keys.size, 80);
    assert.equal(keys.has(buildIndicatorResultCacheKey(maIndicator, baseContext)), true);
    assert.equal(keys.has(buildIndicatorResultCacheKey({
      ...maIndicator,
      id: "other-0",
    }, baseContext)), false);
  } finally {
    release();
  }
});
