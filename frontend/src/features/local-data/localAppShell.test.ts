import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


test("local analysis reuses shared chart controls, settings, export, and indicator surfaces", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(directory, "LocalApp.tsx"), "utf8");

  assert.match(source, /<IndicatorPanel/);
  assert.match(source, /staticCatalog=\{indicatorCatalog\}/);
  assert.match(source, /<DrawingToolbar/);
  assert.match(source, /drawingTool=\{drawingTool\}/);
  assert.match(source, /<ExportPanel/);
  assert.match(source, /<SettingsModal/);
  assert.match(source, /useChartSettingsRuntime\(\)/);
  assert.match(source, /usePriceScalePrefs/);
  assert.match(source, /saveVisibleRangeForInterval/);
  assert.doesNotMatch(source, /LocalIndicatorPanel/);
  assert.doesNotMatch(source, /LOCAL_STATIC_INDICATOR_CATALOG/);
});
