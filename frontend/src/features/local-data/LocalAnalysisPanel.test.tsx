import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LocalAnalysisPanel from "./LocalAnalysisPanel.js";
import { LocalAnalysisEventStore } from "./localAnalysisStore.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const manifest = {
  schema_version: 2,
  dataset_id: "dataset-1",
  data_epoch: "sha256:abc",
  name: "Research sample",
  source: "local_dataset",
  symbol: "BTCUSDT",
  interval: "1h",
  volume_available: true,
  timezone: "UTC",
  timestamp_semantics: "bar_open",
  rows: 10,
  first_open_ms: 1_700_000_000_000,
  last_open_ms: 1_700_032_400_000,
  all_rows_final: true,
  excluded_range_count: 0,
  sqlite_sha256: "abc",
  imported_at: "2026-08-05T00:00:00Z",
} satisfies LocalDatasetManifest;

test("analysis panel exposes generic marker presets and a selected K-line anchor", () => {
  const eventStore = new LocalAnalysisEventStore({
    datasetId: manifest.dataset_id,
    dataEpoch: manifest.data_epoch,
  }, { storage: new MemoryStorage() });
  const html = renderToStaticMarkup(
    <LocalAnalysisPanel
      manifest={manifest}
      snapshot={eventStore.getSnapshot()}
      eventStore={eventStore}
      crosshair={{
        time: 1_700_000_000,
        open: 1,
        high: 2,
        low: 1,
        close: 2,
        volume: null,
      }}
      onFocus={() => undefined}
      onError={() => undefined}
    />,
  );

  assert.match(html, /事件标记/);
  assert.match(html, /开仓/);
  assert.match(html, /平仓/);
  assert.match(html, /自定义/);
  assert.match(html, /添加到图表/);
  assert.match(html, /导入事件 CSV/);
  assert.doesNotMatch(html, /添加到图表[^>]*disabled/);
});

test("analysis panel requires a chart selection before adding a marker", () => {
  const eventStore = new LocalAnalysisEventStore({
    datasetId: manifest.dataset_id,
    dataEpoch: manifest.data_epoch,
  }, { storage: new MemoryStorage() });
  const html = renderToStaticMarkup(
    <LocalAnalysisPanel
      manifest={manifest}
      snapshot={eventStore.getSnapshot()}
      eventStore={eventStore}
      crosshair={null}
      onFocus={() => undefined}
      onError={() => undefined}
    />,
  );

  assert.match(html, /将鼠标移到一根 K 线上/);
  assert.match(html, /disabled=""/);
});
