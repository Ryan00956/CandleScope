import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheIndicatorSnapshot,
  getCachedIndicatorResult,
  replaceCachedIndicatorRange,
  resetIndicatorResultCache,
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
    getCachedIndicatorResult(maIndicator, baseContext).normalized.lines[0].data,
    [{ time: 10, value: 100 }],
  );
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
    getCachedIndicatorResult(maIndicator, baseContext).normalized.lines[0].data,
    [
      { time: 10, value: 1 },
      { time: 20, value: 200 },
    ],
  );
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
    getCachedIndicatorResult(maIndicator, baseContext).normalized.lines[0].data,
    [
      { time: 10, value: 1 },
      { time: 20, value: 2 },
      { time: 30, value: 3 },
    ],
  );
  const entry = snapshotIndicatorResultCacheDiagnostics().entries[0];
  assert.equal(entry.coverage.firstTime, 10);
  assert.equal(entry.coverage.lastTime, 30);
  assert.equal(entry.coverage.points, 3);
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

  const entry = snapshotIndicatorResultCacheDiagnostics().entries[0];
  assert.equal(entry.coverage.firstTime, 1);
  assert.equal(entry.coverage.lastTime, 50_000);
  assert.equal(entry.coverage.points, 150_000);
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
  assert.deepEqual(cached.normalized.markers, [{
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

  const entry = snapshotIndicatorResultCacheDiagnostics().entries[0];
  assert.equal(entry.trimSafety.safeRangeTrim, true);
  trimIndicatorResultCacheEntries([{ key: entry.key, action: "trim-range", keepStart: 20 }]);

  assert.deepEqual(
    getCachedIndicatorResult(maIndicator, baseContext).normalized.lines[0].data,
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

  const entry = snapshotIndicatorResultCacheDiagnostics().entries[0];
  assert.equal(entry.trimSafety.safeRangeTrim, false);
  trimIndicatorResultCacheEntries([{ key: entry.key, action: "trim-range", keepStart: 20 }]);

  assert.equal(getCachedIndicatorResult(maIndicator, baseContext), null);
});
