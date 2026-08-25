import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LocalDatasetManifest, LocalImportJob } from "../researchDataApi.js";
import { ResearchDataImportForm } from "../ResearchDataImportForm.js";
import { ResearchDatasetRail } from "../ResearchDatasetRail.js";
import { ResearchDatasetQuality } from "../ResearchDatasetQuality.js";
import { pollResearchImportJob } from "../useResearchDataLibrary.js";

function manifest(overrides: Partial<LocalDatasetManifest> = {}): LocalDatasetManifest {
  return {
    schema_version: 1,
    dataset_id: "local-0123456789abcdef0123456789abcdef",
    data_epoch: `sha256:${"a".repeat(64)}`,
    name: "BTC sample",
    source: "local_dataset",
    symbol: "BTC-USDT",
    interval: "1m",
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
    imported_at: "2026-08-05T00:00:00+00:00",
    ...overrides,
  };
}

function job(status: LocalImportJob["status"], processed = 0): LocalImportJob {
  return {
    job_id: "job-1",
    kind: "csv_import",
    status,
    stage: status,
    processed_rows: processed,
    total_rows: 10,
    created_at: "2026-08-25T00:00:00Z",
    started_at: "2026-08-25T00:00:00Z",
    finished_at: status === "completed" || status === "cancelled" ? "2026-08-25T00:00:01Z" : null,
    dataset: status === "completed" ? manifest() : null,
    error: null,
    cancel_requested: status === "cancelled",
  };
}

test("import form submit is disabled until a file is chosen and cancel appears while importing", () => {
  const idle = renderToStaticMarkup(
    React.createElement(ResearchDataImportForm, {
      importing: false,
      importJob: null,
      uploadProgress: null,
      selected: null,
      onCancel() {},
      async onImport() {},
    }),
  );
  assert.match(idle, /research-data-import-form/);
  assert.match(idle, /disabled/);

  const importing = renderToStaticMarkup(
    React.createElement(ResearchDataImportForm, {
      importing: true,
      importJob: job("running", 4),
      uploadProgress: 1,
      selected: manifest(),
      onCancel() {},
      async onImport() {},
    }),
  );
  assert.match(importing, /local-import-progress/);
  assert.match(importing, /role="status"/);
});

test("dataset rail lists datasets and marks the selected row", () => {
  const html = renderToStaticMarkup(
    React.createElement(ResearchDatasetRail, {
      datasets: [manifest(), manifest({ dataset_id: "local-ffffffffffffffffffffffffffffffff", name: "ETH" })],
      selectedId: "local-ffffffffffffffffffffffffffffffff",
      importing: false,
      importJob: null,
      uploadProgress: null,
      onSelect() {},
      async onImport() {},
      onCancelImport() {},
      management: null,
      analysis: null,
    }),
  );
  assert.match(html, /research-dataset-rail/);
  assert.match(html, /ETH/);
  assert.match(html, /class="active"/);
});

test("quality card uses the same dataset identity the library already selected", () => {
  const html = renderToStaticMarkup(
    React.createElement(ResearchDatasetQuality, {
      manifest: manifest(),
      details: null,
      revisionCount: 2,
    }),
  );
  assert.match(html, /research-dataset-quality/);
  assert.match(html, />2</);
});

test("import job polling follows queued to completed and cancel stops at cancelled", async () => {
  const seen: string[] = [];
  const completed = await pollResearchImportJob(job("queued"), {
    delay: async () => undefined,
    getJob: async () => {
      seen.push("poll");
      return seen.length < 2 ? job("running", 3) : job("completed", 10);
    },
    onUpdate: (next) => seen.push(next.status),
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.dataset?.dataset_id, manifest().dataset_id);
  assert.ok(seen.includes("queued") || seen.includes("running"));

  const cancelled = await pollResearchImportJob(job("running"), {
    delay: async () => undefined,
    getJob: async () => job("cancelled"),
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.dataset, null);
});

test("LocalApp no longer embeds import or management implementations and keeps interval localStorage keys", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    path.resolve(directory, "../../local-data/LocalApp.tsx"),
    "utf8",
  );
  const intervalSource = readFileSync(
    path.resolve(directory, "../../local-data/useLocalIntervalSelection.ts"),
    "utf8",
  );
  assert.match(source, /useResearchDataLibrary/);
  assert.match(source, /ResearchDatasetRail/);
  assert.match(source, /ResearchDatasetManagement/);
  assert.match(source, /useLocalIntervalSelection/);
  assert.match(intervalSource, /candlescope:local-interval:v1:/);
  assert.doesNotMatch(source, /function LocalImportForm/);
  assert.doesNotMatch(source, /function LocalDatasetRail/);
  assert.doesNotMatch(source, /function LocalDatasetManagement/);
  assert.doesNotMatch(source, /createLocalImportJob/);
  assert.doesNotMatch(source, /getLocalImportJob/);
});

test("researchDataApi reuses local-data HTTP adapters instead of copying them", () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../researchDataApi.ts"),
    "utf8",
  );
  assert.match(source, /from "\.\.\/local-data\/localDataApi\.js"/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /\/api\/v1\/local/);
});
