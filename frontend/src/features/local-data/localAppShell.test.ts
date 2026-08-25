import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const directory = dirname(fileURLToPath(import.meta.url));

test("imported analysis reuses shared chart controls, settings, export, and indicator surfaces", () => {
  const source = readFileSync(resolve(directory, "../strategy-research/StrategyResearchChart.tsx"), "utf8");

  assert.match(source, /<IndicatorPanel/);
  assert.match(source, /staticCatalog=\{indicatorCatalog\}/);
  assert.match(source, /<DrawingToolbar/);
  assert.match(source, /drawingTool=\{drawingTool\}/);
  assert.match(source, /<ExportPanel/);
  assert.match(source, /usePriceScalePrefs/);
  assert.match(source, /saveVisibleRangeForInterval/);
  assert.match(source, /<LocalIntervalSelector/);
  assert.match(source, /useLocalChartRuntime/);
  assert.match(source, /useLocalIndicatorRuntime/);
  assert.doesNotMatch(source, /LocalIndicatorPanel/);
  assert.doesNotMatch(source, /LOCAL_STATIC_INDICATOR_CATALOG/);
  assert.doesNotMatch(source, /from "\.\.\/market-data\/feed\/klineApi/);
});

test("legacy LocalApp is compatibility assembly without independent chart business logic", () => {
  const source = readFileSync(resolve(directory, "LocalApp.tsx"), "utf8");

  assert.match(source, /StrategyResearchImportedWorkspace/);
  assert.match(source, /useLocalIntervalSelection/);
  assert.match(source, /useResearchDataLibrary/);
  assert.match(source, /ResearchDatasetRail/);
  assert.match(source, /ResearchDatasetManagement/);
  assert.match(source, /<SettingsModal/);
  assert.match(source, /useChartSettingsRuntime\(\)/);
  assert.match(source, /interval=\{selectedInterval\}/);
  assert.doesNotMatch(source, /function LocalChart/);
  assert.doesNotMatch(source, /function LocalDatasetWorkspace/);
  assert.doesNotMatch(source, /<SingleChartPanes/);
  assert.doesNotMatch(source, /<IndicatorPanel/);
  assert.doesNotMatch(source, /<DrawingToolbar/);
  assert.doesNotMatch(source, /<ExportPanel/);
});
