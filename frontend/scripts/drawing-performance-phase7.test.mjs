import assert from "node:assert/strict";
import test from "node:test";

import { buildDrawingFixture } from "./drawing-performance-fixtures.mjs";
import { parsePhase7CliArgs } from "./drawing-performance-phase7-cli.mjs";
import {
  buildPhase7Acceptance,
  buildPhase7V2Record,
  nearestRankPercentile,
  PHASE7_DATABASE_NAME,
  PHASE7_ENTITY_COUNT,
  PHASE7_STORE_NAME,
  phase7BrowserProbeBootstrap,
} from "./drawing-performance-phase7.mjs";

function passingRun(iteration = 1) {
  const scopeKey = "binance:spot:BTCUSDT__main";
  return {
    iteration,
    browser: {
      headed: true,
      windowState: "normal",
      visibilityState: "visible",
      hidden: false,
      devicePixelRatio: 1,
    },
    seed: {
      nativeIndexedDb: true,
      databaseName: PHASE7_DATABASE_NAME,
      storeName: PHASE7_STORE_NAME,
      scopeKey,
      entityCount: PHASE7_ENTITY_COUNT,
    },
    restore: {
      entityCount: PHASE7_ENTITY_COUNT,
      sceneEntityCount: PHASE7_ENTITY_COUNT,
      manifest: { scopeKey, count: PHASE7_ENTITY_COUNT, revision: 0 },
      legacyStorageRead: false,
    },
    metrics: {
      restoreChunkMs: { samples: [7.5, 8.25] },
      persistenceMs: { samples: [420 + iteration] },
    },
    longTasks: {
      observerSupported: true,
      windowCount: 2,
      attributableCount: 0,
    },
  };
}

test("Phase 7 v2 fixture builder matches the strict IndexedDB record shape", () => {
  const fixture = buildDrawingFixture("entities512");
  const saved = JSON.parse(fixture.raw);
  const record = buildPhase7V2Record(fixture.metadata.scopeKey, saved, 1234);

  assert.equal(record.documentSchemaVersion, 1);
  assert.equal(record.scopeKey, fixture.metadata.scopeKey);
  assert.equal(record.documentRevision, 0);
  assert.equal(record.updatedAt, 1234);
  assert.equal(record.entities.length, PHASE7_ENTITY_COUNT);
  assert.deepEqual(Object.keys(record).sort(), [
    "documentRevision",
    "documentSchemaVersion",
    "entities",
    "scopeKey",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(record.entities[0]).sort(), [
    "bounds",
    "geometry",
    "geometryRevision",
    "id",
    "kind",
    "style",
    "styleRevision",
  ]);
  assert.equal(record.entities.some((entity) => entity.kind === "line"), true);
  assert.equal(record.entities.some((entity) => entity.kind === "shape"), true);
  assert.equal(new Set(record.entities.map((entity) => entity.id)).size, PHASE7_ENTITY_COUNT);
});

test("Phase 7 v2 fixture builder rejects count and kind drift", () => {
  const fixture = buildDrawingFixture("entities512");
  const saved = JSON.parse(fixture.raw);
  assert.throws(
    () => buildPhase7V2Record(fixture.metadata.scopeKey, saved.slice(1), 1),
    /exactly 512/,
  );
  const unsupported = saved.map((drawing, index) => (
    index === 0 ? { ...drawing, type: "text" } : drawing
  ));
  assert.throws(
    () => buildPhase7V2Record(fixture.metadata.scopeKey, unsupported, 1),
    /does not support drawing type text/,
  );
});

test("nearest-rank percentile remains deterministic for small browser samples", () => {
  assert.equal(nearestRankPercentile([10, 30, 20, 50, 40], 95), 50);
  assert.equal(nearestRankPercentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(nearestRankPercentile([], 95), null);
  assert.equal(nearestRankPercentile([10, Number.NaN, -1, 20], 95), 20);
});

test("Phase 7 acceptance requires headed IDB restore, manifest, metrics, and zero long tasks", () => {
  const runs = Array.from({ length: 5 }, (_, index) => passingRun(index + 1));
  const acceptance = buildPhase7Acceptance({ runs }, { minimumRuns: 5 });

  assert.equal(acceptance.passed, true);
  assert.equal(acceptance.restoreChunkSampleCount, 10);
  assert.equal(acceptance.restoreChunkMaxMs, 8.25);
  assert.equal(acceptance.persistenceSampleCount, 5);
  assert.equal(acceptance.persistenceP95Ms, 425);
  assert.deepEqual(acceptance.failureReasons, []);
});

test("Phase 7 acceptance fails closed when performance evidence is absent", () => {
  const run = passingRun();
  run.metrics.restoreChunkMs.samples = [];
  run.metrics.persistenceMs.samples = [];
  run.restore.manifest = null;
  run.restore.legacyStorageRead = true;
  run.longTasks.observerSupported = false;
  const acceptance = buildPhase7Acceptance({ runs: [run] }, { minimumRuns: 1 });

  assert.equal(acceptance.passed, false);
  assert.deepEqual(acceptance.failureReasons, [
    "phase7-manifest-repair-failed",
    "phase7-v2-restore-read-legacy-storage",
    "phase7-restore-chunk-metric-missing",
    "phase7-persistence-metric-missing",
    "phase7-long-task-observer-unavailable",
  ]);
});

test("Phase 7 acceptance rejects over-budget samples, hidden windows, and attributable tasks", () => {
  const run = passingRun();
  run.browser.hidden = true;
  run.metrics.restoreChunkMs.samples = [16.01];
  run.metrics.persistenceMs.samples = [500.01];
  run.longTasks.attributableCount = 1;
  const acceptance = buildPhase7Acceptance({ runs: [run] }, { minimumRuns: 1 });

  assert.equal(acceptance.passed, false);
  assert.equal(acceptance.restoreBudgetPassed, false);
  assert.equal(acceptance.persistenceBudgetPassed, false);
  assert.equal(acceptance.attributableLongTaskPassed, false);
  assert.deepEqual(acceptance.failureReasons, [
    "phase7-headed-visible-window-required",
    "phase7-restore-chunk-budget-exceeded",
    "phase7-persistence-p95-budget-exceeded",
    "phase7-attributable-long-task-detected",
  ]);
});

test("Phase 7 browser bootstrap starts restore attribution at the manifest read", () => {
  const previous = new Map([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["Storage", Object.getOwnPropertyDescriptor(globalThis, "Storage")],
    ["PerformanceObserver", Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver")],
  ]);
  class MemoryStorage {
    values = new Map();

    getItem(key) {
      return this.values.get(String(key)) ?? null;
    }
  }
  class NoopPerformanceObserver {
    observe() {}
  }
  const fakeWindow = {};
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "Storage", { configurable: true, value: MemoryStorage });
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: NoopPerformanceObserver,
  });

  try {
    const key = "candlescope-drawings-v2-manifest-scope";
    const storage = new MemoryStorage();
    phase7BrowserProbeBootstrap({ manifestKey: key });
    storage.getItem("unrelated");
    assert.equal(fakeWindow.__CANDLESCOPE_PHASE7_PROBE__.report().windows.restore, undefined);
    storage.getItem(key);
    fakeWindow.__CANDLESCOPE_PHASE7_PROBE__.endWindow("restore");
    fakeWindow.__CANDLESCOPE_PHASE7_PROBE__.beginWindow("persistence");
    fakeWindow.__CANDLESCOPE_PHASE7_PROBE__.endWindow("persistence");
    const report = fakeWindow.__CANDLESCOPE_PHASE7_PROBE__.report();
    assert.deepEqual(report.storageReads, ["unrelated", key]);
    assert.equal(report.longTaskSupported, true);
    assert.ok(report.windows.restore.endTime >= report.windows.restore.startTime);
    assert.ok(report.windows.persistence.endTime >= report.windows.persistence.startTime);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("Phase 7 CLI parser defaults to headed five-run acceptance", () => {
  const defaults = parsePhase7CliArgs([]);
  assert.equal(defaults.runs, 5);
  assert.equal(defaults.dpr, 1);
  assert.equal(defaults.url, "http://127.0.0.1:15173/");
  const custom = parsePhase7CliArgs([
    "--url", "http://127.0.0.1:5173",
    "--runs", "2",
    "--dpr", "2",
    "--timeout-ms", "1000",
  ]);
  assert.equal(custom.url, "http://127.0.0.1:5173/");
  assert.equal(custom.runs, 2);
  assert.equal(custom.dpr, 2);
  assert.equal(custom.timeoutMs, 1000);
  assert.throws(() => parsePhase7CliArgs(["--headless"]), /Unknown argument/);
});
