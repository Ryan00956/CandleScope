import assert from "node:assert/strict";
import test from "node:test";

import { hasCurrentDatasetOwnership } from "../../components/singleChartPaneLifecycle.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { buildLocalChartDataMeta } from "./useLocalChartRuntime.js";


test("local chart metadata grants indicator rendering ownership to the immutable series", () => {
  const datasetKey = `local:local-${"a".repeat(32)}:sha256:${"b".repeat(64)}`;
  const seriesStore = new SeriesWindowStore({
    intervalSeconds: 60,
    seriesKey: datasetKey,
  });
  const meta = buildLocalChartDataMeta(seriesStore, "ready");

  assert.equal(meta.seriesKey, datasetKey);
  assert.equal(meta.source, "local_dataset");
  assert.equal(meta.optimistic, false);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: meta,
    datasetKey,
    seriesStore,
  }), true);
});
