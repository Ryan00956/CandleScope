import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LocalDatasetManifest } from "../../local-data/localDataTypes.js";
import { LOCAL_INTERVAL_STORAGE_PREFIX, localIntervalStorageKey } from "../../local-data/useLocalIntervalSelection.js";
import { resolveLocalIntervalSupport } from "../../local-data/localIntervalPolicy.js";
import { buildLocalAnalysisStorageKey } from "../../local-data/localAnalysisStore.js";
import StrategyResearchApp from "../StrategyResearchApp.js";
import {
  importedChartDatasetKey,
  importedDatasetSourceFromManifest,
  importedDrawingKeyBase,
} from "../importedDatasetSource.js";
import { parseStrategyResearchLaunch } from "../strategyResearchLaunch.js";


const here = path.dirname(fileURLToPath(import.meta.url));

function manifest(overrides: Partial<LocalDatasetManifest> = {}): LocalDatasetManifest {
  return {
    schema_version: 1,
    dataset_id: "local-0123456789abcdef0123456789abcdef",
    data_epoch: `sha256:${"a".repeat(64)}`,
    name: "BTC sample",
    source: "local_dataset",
    symbol: "BTC-USDT",
    interval: "15m",
    alignment: "fixed_epoch",
    alignment_offset_ms: 0,
    volume_available: true,
    timezone: "UTC",
    timestamp_semantics: "bar_open",
    rows: 12,
    first_open_ms: 1_704_067_200_000,
    last_open_ms: 1_704_067_260_000,
    all_rows_final: true,
    excluded_range_count: 0,
    sqlite_sha256: "b".repeat(64),
    imported_at: "2026-08-25T00:00:00+00:00",
    ...overrides,
  };
}

test("imported source identity is dataset_id + data_epoch and never invents a snapshot hash", () => {
  const source = importedDatasetSourceFromManifest(manifest(), "1h");
  assert.equal(source.kind, "IMPORTED_DATASET");
  assert.equal(source.datasetId, manifest().dataset_id);
  assert.equal(source.dataEpoch, manifest().data_epoch);
  assert.equal(source.interval, "1h");
  assert.equal("snapshotHash" in source, false);
});

test("chart, drawings, indicators, events, and interval keys isolate by dataset_id + data_epoch", () => {
  const current = manifest();
  const nextEpoch = manifest({ data_epoch: `sha256:${"b".repeat(64)}` });
  assert.equal(
    importedChartDatasetKey(current, "30m"),
    `local:${current.dataset_id}:${current.data_epoch}:30m`,
  );
  assert.notEqual(importedChartDatasetKey(current, "30m"), importedChartDatasetKey(nextEpoch, "30m"));
  assert.equal(importedDrawingKeyBase(current), `local:${current.dataset_id}:${current.data_epoch}`);
  assert.notEqual(importedDrawingKeyBase(current), importedDrawingKeyBase(nextEpoch));
  const analysisKey = buildLocalAnalysisStorageKey({
    datasetId: current.dataset_id,
    dataEpoch: current.data_epoch,
  });
  assert.match(analysisKey, new RegExp(current.dataset_id));
  assert.match(analysisKey, /sha256/);
  assert.notEqual(
    analysisKey,
    buildLocalAnalysisStorageKey({
      datasetId: nextEpoch.dataset_id,
      dataEpoch: nextEpoch.data_epoch,
    }),
  );
  assert.notEqual(
    localIntervalStorageKey(current.dataset_id, current.data_epoch),
    localIntervalStorageKey(nextEpoch.dataset_id, nextEpoch.data_epoch),
  );
  assert.match(localIntervalStorageKey(current.dataset_id, current.data_epoch), new RegExp(LOCAL_INTERVAL_STORAGE_PREFIX));
});

test("15m imported data allows 30m/1h/90m and rejects 89m", () => {
  const source = { interval: "15m", alignment_offset_ms: 0 };
  assert.equal(resolveLocalIntervalSupport(source, "30m").supported, true);
  assert.equal(resolveLocalIntervalSupport(source, "1h").supported, true);
  assert.equal(resolveLocalIntervalSupport(source, "90m").supported, true);
  const rejected = resolveLocalIntervalSupport(source, "89m");
  assert.equal(rejected.supported, false);
  assert.equal(rejected.code, "interval_not_composable");
});

test("unified app owns one library store and drawer does not create another", () => {
  const appSource = readFileSync(path.resolve(here, "../StrategyResearchApp.tsx"), "utf8");
  const drawerSource = readFileSync(path.resolve(here, "../../research-data/ResearchDataDrawer.tsx"), "utf8");
  const chartSource = readFileSync(path.resolve(here, "../StrategyResearchChart.tsx"), "utf8");
  assert.match(appSource, /useResearchDataLibrary\(\)/);
  assert.match(appSource, /StrategyResearchImportedWorkspace/);
  assert.match(appSource, /importedDatasetSourceFromManifest/);
  assert.doesNotMatch(drawerSource, /useResearchDataLibrary\(\)/);
  assert.match(drawerSource, /library\?:/);
  assert.match(chartSource, /followLatest=\{false\}/);
  assert.match(chartSource, /realtimeMode="historical-only"/);
});

test("CURRENT_CHART keeps the chart slot placeholder while imported data uses the empty CSV surface", () => {
  const first = renderToStaticMarkup(
    React.createElement(StrategyResearchApp, {
      intent: parseStrategyResearchLaunch({ pathname: "/strategy.html", search: "" }),
      libraryEnabled: true,
    }),
  );
  assert.match(first, /data-visual-state="first"/);
  assert.match(first, /strategy-research-empty-chart/);
  assert.doesNotMatch(first, /monaco/i);
});
