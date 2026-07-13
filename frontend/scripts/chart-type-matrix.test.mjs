import assert from "node:assert/strict";
import test from "node:test";

import { MAIN_CHART_TYPES } from "../src/shared/mainChartTypes.js";
import {
  findMissingChartTypes,
  summarizeChartTypeMatrixAcceptance,
} from "./chart-type-matrix.mjs";

function passingSteps(chartTypes = MAIN_CHART_TYPES) {
  return chartTypes.map((chartType) => ({ chartType, passed: true }));
}

test("chart type matrix acceptance passes for the complete ordered contract", () => {
  const acceptance = summarizeChartTypeMatrixAcceptance({
    menuChartTypes: [...MAIN_CHART_TYPES],
    steps: passingSteps(),
    persistence: { passed: true },
  });

  assert.equal(acceptance.variantContractMatches, true);
  assert.equal(acceptance.stepsPassed, true);
  assert.equal(acceptance.persistencePassed, true);
  assert.deepEqual(acceptance.missingMenuChartTypes, []);
  assert.deepEqual(acceptance.missingStepChartTypes, []);
  assert.equal(acceptance.passed, true);
});

test("findMissingChartTypes reports every expected type absent from the actual set", () => {
  const missingType = "point-and-figure";
  const actual = MAIN_CHART_TYPES.filter((chartType) => chartType !== missingType);

  assert.deepEqual(findMissingChartTypes(actual), [missingType]);
});

test("chart type matrix acceptance fails when menu and executed steps omit types", () => {
  const missingMenuType = "renko";
  const missingStepType = "kagi";
  const acceptance = summarizeChartTypeMatrixAcceptance({
    menuChartTypes: MAIN_CHART_TYPES.filter((chartType) => chartType !== missingMenuType),
    steps: passingSteps(
      MAIN_CHART_TYPES.filter((chartType) => chartType !== missingStepType),
    ),
    persistence: { passed: true },
  });

  assert.deepEqual(acceptance.missingMenuChartTypes, [missingMenuType]);
  assert.deepEqual(acceptance.missingStepChartTypes, [missingStepType]);
  assert.equal(acceptance.variantContractMatches, false);
  assert.equal(acceptance.stepsPassed, false);
  assert.equal(acceptance.passed, false);
});

test("chart type matrix acceptance rejects failed steps and failed persistence", () => {
  const steps = passingSteps();
  steps[0] = { ...steps[0], passed: false };
  const acceptance = summarizeChartTypeMatrixAcceptance({
    menuChartTypes: [...MAIN_CHART_TYPES],
    steps,
    persistence: { passed: false },
  });

  assert.equal(acceptance.stepsPassed, false);
  assert.equal(acceptance.persistencePassed, false);
  assert.equal(acceptance.passed, false);
});
