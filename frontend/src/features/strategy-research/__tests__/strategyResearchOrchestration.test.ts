import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import StrategyResearchApp from "../StrategyResearchApp.js";
import {
  parseStrategyResearchLaunch,
  resolveStrategyResearchBootstrap,
} from "../strategyResearchLaunch.js";
import {
  STRATEGY_RESEARCH_LEGACY_MAP,
} from "../strategyResearchLegacyMap.js";
import {
  dismissCompatNotice,
  isCompatNoticeDismissed,
  isLegacyResearchStorageKey,
  listLegacyResearchStorageKeys,
  STRATEGY_RESEARCH_COMPAT_NOTICE_KEY,
} from "../strategyResearchCompat.js";
import { StrategyResearchCompatNotice } from "../StrategyResearchCompatNotice.js";


const here = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(path.resolve(here, relative), "utf8");
}

test("legacy-to-unified map covers migrated orchestration and names deferred M9 surfaces", () => {
  const ids = STRATEGY_RESEARCH_LEGACY_MAP.map((entry) => entry.id);
  assert.deepEqual(new Set(ids).size, ids.length);
  for (const required of [
    "csv-import-poll",
    "dataset-selection",
    "run-poll",
    "python-studio",
    "rsi-trace-pane",
    "bounded-fill-table",
  ]) {
    assert.equal(ids.includes(required), true, required);
  }
  for (const entry of STRATEGY_RESEARCH_LEGACY_MAP) {
    if (entry.status === "deferred") {
      assert.ok(entry.followUp && entry.followUp.length > 12, entry.id);
    } else {
      assert.equal(entry.followUp, null, entry.id);
      assert.notEqual(entry.unified, entry.legacy);
    }
  }
});

test("import polling, dataset selection, and Run polling are not reimplemented in page apps", () => {
  const localApp = source("../../local-data/LocalApp.tsx");
  const backtestApp = source("../../backtest/BacktestApp.tsx");
  const library = source("../../research-data/useResearchDataLibrary.ts");
  const researchRuntime = source("../../backtest/research/useBacktestResearchRuntime.ts");
  const runClient = source("../../backtest/backtestRunClient.ts");
  assert.match(library, /export async function pollResearchImportJob/);
  assert.doesNotMatch(localApp, /pollResearchImportJob|setInterval\(/);
  assert.doesNotMatch(backtestApp, /listDatasets|setInterval\(|pollResearchImportJob|pollBacktestRunToTerminal/);
  assert.match(localApp, /useResearchDataLibrary/);
  assert.match(backtestApp, /BacktestResearchApp/);
  assert.match(researchRuntime, /window\.setInterval/);
  assert.match(runClient, /export async function pollBacktestRunToTerminal/);
  assert.equal((library.match(/export async function pollResearchImportJob/g) ?? []).length, 1);
  assert.equal((runClient.match(/export async function pollBacktestRunToTerminal/g) ?? []).length, 1);
});

test("flag-off still restores the local compatibility shell without unified first-paint cost", () => {
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "local" }), "local-legacy");
  assert.equal(resolveStrategyResearchBootstrap({ libraryEnabled: false, page: "backtest" }), "backtest-legacy");
  const bootstrap = source("../strategyResearchBootstrap.tsx");
  assert.match(bootstrap, /if \(mode === "local-legacy"\)/);
  assert.match(bootstrap, /<LocalApp/);
  assert.match(bootstrap, /<BacktestApp/);
  const localApp = source("../../local-data/LocalApp.tsx");
  assert.match(localApp, /local-app-compat-shell/);
  assert.doesNotMatch(localApp, /pollResearchImportJob|window\.setInterval/);
  const unified = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(unified, /strategy-research-shell/);
  assert.doesNotMatch(unified, /strategy-research-compat-notice/);
  assert.doesNotMatch(unified, /monaco/i);
});

test("compatibility URLs show a one-time notice and keep using the unified app", () => {
  const local = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/local.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(local, /strategy-research-compat-notice/);
  assert.match(local, /data-compat-page="local"/);
  const backtest = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/backtest.html", search: "?run=bt_0123456789abcdef" }),
      libraryEnabled: true,
    }),
  );
  assert.match(backtest, /strategy-research-compat-notice/);
  assert.match(backtest, /strategy-research-advanced|strategy-research-deep-link-error/);
});

test("compat notice dismiss writes only its key and never deletes legacy storage", () => {
  const store = new Map<string, string>([
    ["candlescope:local-interval:v1:ds:epoch", "15m"],
    ["candlescope:local-analysis:v1:ds:epoch", "{}"],
    ["candlescope-strategy-drafts-v1", "{}"],
    ["candlescope.python-studio.v1", "{}"],
  ]);
  const removed: string[] = [];
  const storage = {
    getItem(key: string) { return store.get(key) ?? null; },
    setItem(key: string, value: string) { store.set(key, value); },
    removeItem(key: string) {
      removed.push(key);
      store.delete(key);
    },
  };
  assert.equal(isCompatNoticeDismissed(storage), false);
  dismissCompatNotice(storage);
  assert.equal(isCompatNoticeDismissed(storage), true);
  assert.equal(removed.length, 0);
  assert.deepEqual(
    listLegacyResearchStorageKeys([...store.keys()].filter((key) => key !== STRATEGY_RESEARCH_COMPAT_NOTICE_KEY)),
    [
      "candlescope:local-interval:v1:ds:epoch",
      "candlescope:local-analysis:v1:ds:epoch",
      "candlescope-strategy-drafts-v1",
      "candlescope.python-studio.v1",
    ],
  );
  assert.equal(isLegacyResearchStorageKey("candlescope:local-interval:v1:ds:epoch"), true);
  assert.equal(store.get("candlescope:local-interval:v1:ds:epoch"), "15m");
  assert.equal(store.get("candlescope-strategy-drafts-v1"), "{}");
  const html = renderToStaticMarkup(React.createElement(StrategyResearchCompatNotice, { page: "local" }));
  assert.match(html, /strategy-research-compat-notice/);
});
