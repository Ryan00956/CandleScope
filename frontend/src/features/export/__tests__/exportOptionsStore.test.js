import assert from "node:assert/strict";
import test from "node:test";

import { loadExportOptions, saveExportOptions } from "../exportOptionsStore.js";

test("loadExportOptions merges persisted values over the defaults", () => {
  const options = loadExportOptions(() => ({
    chartExportOptions: {
      format: "webp",
      scale: 3,
      watermarkEnabled: true,
    },
  }));

  assert.equal(options.scope, "chart");
  assert.equal(options.format, "webp");
  assert.equal(options.scale, 3);
  assert.equal(options.watermarkEnabled, true);
  assert.equal(options.filenamePrefix, "candlescope");
});

test("loadExportOptions repairs a persisted transparent JPEG background", () => {
  const options = loadExportOptions(() => ({
    chartExportOptions: {
      format: "jpeg",
      backgroundColor: "transparent",
    },
  }));

  assert.equal(options.backgroundColor, "auto");
});

test("saveExportOptions writes through the chart export preference key", () => {
  const writes = [];
  const options = { format: "png", scale: 2 };
  saveExportOptions((key, value) => writes.push({ key, value }), options);

  assert.deepEqual(writes, [{ key: "chartExportOptions", value: options }]);
});
