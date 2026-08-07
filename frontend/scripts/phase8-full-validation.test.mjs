import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBackendJUnit,
  evaluateValidationSteps,
} from "./phase8-full-validation.mjs";

const ids = [
  "architecture", "plugins", "typecheck", "lint", "frontend-tests",
  "desktop-tests", "frontend-build", "backend-tests",
];

test("full validation passes only when every required command exits zero", () => {
  const evaluation = evaluateValidationSteps(ids.map((id) => ({ id, exitCode: 0 })));
  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.missing, []);
  assert.deepEqual(evaluation.failed, []);
});

test("full validation reports missing and failed commands", () => {
  const evaluation = evaluateValidationSteps([
    ...ids.slice(0, -2).map((id) => ({ id, exitCode: id === "lint" ? 1 : 0 })),
    { id: "backend-tests", exitCode: 0 },
  ]);
  assert.equal(evaluation.passed, false);
  assert.deepEqual(evaluation.missing, ["frontend-build"]);
  assert.deepEqual(evaluation.failed, ["lint"]);
});

test("full validation accepts a reviewed backend baseline without hiding its exit code", () => {
  const evaluation = evaluateValidationSteps(ids.map((id) => ({
    id,
    exitCode: id === "backend-tests" ? 1 : 0,
    acceptedBaseline: id === "backend-tests",
  })));
  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.failed, []);
});

test("backend JUnit comparison accepts only reviewed non-passing node ids", () => {
  const baseline = {
    capturedFrom: "base",
    sourceEvidence: "baseline.json",
    minimumCollected: 2,
    expected: { passed: 1, failures: 1, errors: 0, warnings: 0 },
    nodeIds: ["backend/tests/test_known.py::test_known"],
  };
  const xml = '<?xml version="1.0"?><testsuites><testsuite tests="2" failures="1" errors="0" skipped="0">'
    + '<testcase classname="backend.tests.test_ok" name="test_ok" />'
    + '<testcase classname="backend.tests.test_known" name="test_known"><failure message="known">known</failure></testcase>'
    + '</testsuite></testsuites>';
  const comparison = analyzeBackendJUnit(xml, baseline);
  assert.equal(comparison.accepted, true);
  assert.deepEqual(comparison.unexpectedNodeIds, []);
  assert.deepEqual(comparison.resolvedNodeIds, []);
});

test("backend JUnit comparison rejects a new failure", () => {
  const baseline = {
    capturedFrom: "base",
    sourceEvidence: "baseline.json",
    minimumCollected: 1,
    expected: { passed: 1, failures: 1, errors: 0, warnings: 0 },
    nodeIds: ["backend/tests/test_known.py::test_known"],
  };
  const xml = '<testsuites><testsuite tests="1" failures="1" errors="0" skipped="0">'
    + '<testcase classname="backend.tests.test_new" name="test_new"><failure>new</failure></testcase>'
    + '</testsuite></testsuites>';
  const comparison = analyzeBackendJUnit(xml, baseline);
  assert.equal(comparison.accepted, false);
  assert.deepEqual(comparison.unexpectedNodeIds, ["backend/tests/test_new.py::test_new"]);
});
