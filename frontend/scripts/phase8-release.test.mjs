import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePhase8Release } from "./phase8-release.mjs";

function fixture() {
  const window = {
    renderer: {
      chartRoots: 16,
      dataReadyRoots: 16,
      indicators: { runtimeCount: 16, definitionCount: 32 },
    },
  };
  return {
    phase7: { result: "pass" },
    w3: { result: "pass", mode: "W3", analysis: { result: "pass" }, samples: [{ windows: [window, window, window, window] }] },
    soak: { result: "pass", analysis: { result: "pass", measurements: { durationMs: 14_400_000 } } },
    f1: { result: "pass", gates: { a: true, b: true } },
    f2: { result: "pass", gates: { a: true, b: true } },
    f3: { result: "implementation-pass-hardware-pending", gates: { implementation: { a: true }, physical: { a: false } } },
    rollback: { result: "pass" },
    package: { result: "pass" },
    validation: { result: "pass" },
    independentReleaseReview: false,
  };
}

test("complete implementation remains blocked by physical displays and independent review", () => {
  const evaluation = evaluatePhase8Release(fixture());
  assert.equal(evaluation.implementationPass, true);
  assert.equal(evaluation.releaseReady, false);
  assert.equal(evaluation.result, "implementation-pass-hardware-and-review-pending");
});

test("release passes only when physical evidence and independent review also pass", () => {
  const input = fixture();
  input.f3.result = "pass";
  input.f3.gates.physical.a = true;
  input.independentReleaseReview = true;
  assert.equal(evaluatePhase8Release(input).result, "pass");
});

test("a shortened soak fails the implementation gate", () => {
  const input = fixture();
  input.soak.analysis.measurements.durationMs -= 1;
  const evaluation = evaluatePhase8Release(input);
  assert.equal(evaluation.implementationPass, false);
  assert.equal(evaluation.result, "fail");
});
