import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isBacktestEntryEnabled,
  isBacktestLegacyWorkbenchEnabled,
  isBacktestResearchEnabled,
} from "../backtestFlags.js";
import { createBacktestStore, reportHidesApproximate } from "../backtestStore.js";

const featureRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

test("backtest and research entries default on with explicit rollback flags", () => {
  assert.equal(isBacktestEntryEnabled({ VITE_BACKTEST_ENTRY_ENABLED: "0" }), false);
  assert.equal(isBacktestEntryEnabled({}), true);
  assert.equal(isBacktestEntryEnabled({ VITE_BACKTEST_ENTRY_ENABLED: "1" }), true);
  assert.equal(isBacktestResearchEnabled({}), true);
  assert.equal(isBacktestResearchEnabled({ VITE_BACKTEST_RESEARCH_ENABLED: "0" }), false);
  assert.equal(isBacktestResearchEnabled({ VITE_BACKTEST_RESEARCH_ENABLED: "1" }), true);
  assert.equal(isBacktestLegacyWorkbenchEnabled({}), true);
  assert.equal(
    isBacktestLegacyWorkbenchEnabled({ VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED: "0" }),
    false,
  );
});

test("live top bar exposes the enabled backtest entry without coupling to replay state", () => {
  const topBar = readFileSync(join(featureRoot, "..", "..", "app", "TopBar.tsx"), "utf8");
  assert.match(topBar, /isBacktestEntryEnabled\(\)/);
  assert.match(topBar, /data-backtest-entry="enabled"/);
  assert.match(topBar, /href="\/backtest\.html"/);
  assert.match(topBar, /t\("shell\.backtest"\)/);
});

test("backtest feature does not import replay stores or controllers", () => {
  const files = walk(featureRoot).filter((path) => /\.(ts|tsx)$/.test(path));
  const hits = files.filter((path) => {
    if (path.includes(`${sep}__tests__${sep}`)) return false;
    const text = readFileSync(path, "utf8");
    return /features\/replay|replayStore|TrainingRun/.test(text);
  });
  assert.deepEqual(hits, []);
});

test("BAR reports cannot hide the approximate label", () => {
  assert.equal(
    reportHidesApproximate({
      schemaVersion: "candlescope.backtest-report/1",
      runId: "bt_1",
      fidelity_mode: "BAR_APPROX",
      source_event_kind: "BAR",
      report_label: "TRADE_SEQUENCE",
      hashes: {},
      metrics: {
        fill_count: 0,
        ambiguity_count: 0,
        rejected_order_count: 0,
        trade_count: 0,
        winning_trade_count: 0,
        win_rate: "0",
        realized_net_pnl: "0",
      },
      unmodeled: [],
      suitable_for: [],
      not_suitable_for: [],
      fills: [],
      trades: [],
    }),
    true,
  );
});

test("stream gap marks RESYNC_REQUIRED without cancelling the run", () => {
  const store = createBacktestStore();
  store.applyStream({ type: "PROGRESS", sequence: 4 });
  store.applyStream({ type: "RESYNC_REQUIRED" });
  assert.equal(store.getState().resyncRequired, true);
  assert.equal(store.getState().lastSequence, 4);
});
