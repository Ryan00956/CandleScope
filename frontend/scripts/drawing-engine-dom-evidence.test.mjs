import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrawingEngineDomEvidence,
  drawingEngineDomEvidenceBrowserSnapshot,
  formatDrawingEngineDomEvidenceFailure,
  normalizeDrawingEngineDomEvidence,
  shouldRequireDrawingEngineDomEvidenceForPerformance,
  shouldRequireDrawingEngineDomEvidenceForSmoke,
  summarizeDrawingEngineDomEvidenceAssessments,
} from "./drawing-engine-dom-evidence.mjs";

function passingRawEvidence() {
  return {
    hostReadyCount: 1,
    interactionModes: ["overlay"],
    registries: [{
      registryKind: "scene-document-only",
      legacyPrimitiveInstanceCount: "0",
      legacyPrimitiveAttachedCount: "0",
      zeroLegacyPrimitiveInvariant: "true",
    }],
    drawingHandlePresent: true,
    effectiveEngineMode: "scene-canary",
  };
}

test("browser snapshot stays self-contained when serialized through CDP", () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const attributes = new Map([
    ["data-drawing-interaction-mode", "overlay"],
    ["data-drawing-registry-kind", "scene-document-only"],
    ["data-drawing-legacy-instances", "0"],
    ["data-drawing-legacy-attached", "0"],
    ["data-drawing-zero-legacy", "true"],
  ]);
  const node = { getAttribute: (name) => attributes.get(name) ?? null };
  globalThis.document = {
    querySelectorAll: (selector) => {
      if (selector === '[data-drawing-engine="ready"]') return [node];
      if (selector === "[data-drawing-interaction-mode]") return [node];
      if (selector === "[data-drawing-registry-kind]") return [node];
      return [];
    },
  };
  globalThis.window = {
    __CANDLESCOPE_DRAWING_PERF__: {
      readRuntimeSummary: () => ({ effectiveEngineMode: "scene-canary" }),
    },
  };

  try {
    const serialized = Function(
      `return (${drawingEngineDomEvidenceBrowserSnapshot.toString()})()`,
    )();
    assert.deepEqual(serialized, passingRawEvidence());
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("Phase 8 DOM evidence accepts only overlay scene-canary with zero legacy ownership", () => {
  const assessment = assessDrawingEngineDomEvidence(passingRawEvidence());

  assert.equal(assessment.required, true);
  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.failureReasons, []);
  assert.deepEqual(assessment.evidence.registries[0], {
    registryKind: "scene-document-only",
    legacyPrimitiveInstanceCount: 0,
    legacyPrimitiveAttachedCount: 0,
    zeroLegacyPrimitiveInvariant: true,
    zeroLegacyPrimitiveInvariantPresent: true,
  });
});

test("missing DrawingEngineHost evidence fails closed with actionable reasons", () => {
  const assessment = assessDrawingEngineDomEvidence(null);

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.failureReasons, [
    "drawing-engine-host-ready-marker-missing",
    "drawing-interaction-mode-evidence-missing",
    "drawing-registry-evidence-missing",
    "drawing-runtime-evidence-missing",
    "drawing-engine-mode-not-scene-canary",
  ]);
  assert.match(
    formatDrawingEngineDomEvidenceFailure(assessment, "Smoke"),
    /^Smoke Phase 8 DOM evidence failed:/,
  );
});

test("legacy interaction, registry instances, attachment, and invariant are all rejected", () => {
  const assessment = assessDrawingEngineDomEvidence({
    ...passingRawEvidence(),
    interactionModes: ["legacy"],
    registries: [{
      registryKind: "legacy-compatible",
      legacyPrimitiveInstanceCount: "2",
      legacyPrimitiveAttachedCount: "1",
      zeroLegacyPrimitiveInvariant: "false",
    }],
    effectiveEngineMode: "legacy",
  });

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.failureReasons, [
    "drawing-interaction-mode-not-overlay",
    "drawing-registry-kind-not-scene-document-only",
    "drawing-legacy-instance-count-not-zero",
    "drawing-legacy-attached-count-not-zero",
    "drawing-zero-legacy-invariant-false",
    "drawing-engine-mode-not-scene-canary",
  ]);
});

test("malformed counters and incomplete duplicate-host evidence cannot look like zero", () => {
  const assessment = assessDrawingEngineDomEvidence({
    ...passingRawEvidence(),
    hostReadyCount: 2,
    interactionModes: ["overlay", "overlay"],
    registries: [{
      registryKind: "scene-document-only",
      legacyPrimitiveInstanceCount: "zero",
      legacyPrimitiveAttachedCount: null,
      zeroLegacyPrimitiveInvariant: null,
    }],
  });

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.failureReasons, [
    "drawing-engine-host-evidence-count-mismatch",
    "drawing-legacy-instance-count-missing-or-invalid",
    "drawing-legacy-attached-count-missing-or-invalid",
    "drawing-zero-legacy-invariant-missing",
  ]);
});

test("non-drawing smoke paths remain explicitly non-applicable", () => {
  const assessment = assessDrawingEngineDomEvidence(null, { required: false });

  assert.deepEqual(assessment, {
    required: false,
    passed: true,
    evidence: normalizeDrawingEngineDomEvidence(null),
    failureReasons: [],
  });
});

test("smoke and performance gates apply only to drawing acceptance paths", () => {
  assert.equal(shouldRequireDrawingEngineDomEvidenceForSmoke(), false);
  assert.equal(shouldRequireDrawingEngineDomEvidenceForSmoke({ drawingCheck: true }), true);
  assert.equal(shouldRequireDrawingEngineDomEvidenceForSmoke({ overlayHeavy: true }), true);

  assert.equal(shouldRequireDrawingEngineDomEvidenceForPerformance({ phase: "phase3" }), false);
  assert.equal(shouldRequireDrawingEngineDomEvidenceForPerformance({ phase: "phase5" }), true);
  assert.equal(shouldRequireDrawingEngineDomEvidenceForPerformance({ phase: "phase6" }), true);
  assert.equal(shouldRequireDrawingEngineDomEvidenceForPerformance({
    phase: "phase3",
    interactionSurfaceMode: "overlay",
  }), true);
});

test("performance evidence summary requires initial and post-reload observations per run", () => {
  const passed = assessDrawingEngineDomEvidence(passingRawEvidence());
  assert.deepEqual(summarizeDrawingEngineDomEvidenceAssessments([{
    id: "scenario-1",
    initial: passed,
    reload: passed,
  }]), {
    required: true,
    passed: true,
    expectedObservationCount: 2,
    observedObservationCount: 2,
    failedObservationIds: [],
    failureReasons: [],
  });

  const incomplete = summarizeDrawingEngineDomEvidenceAssessments([{
    id: "scenario-1",
    initial: passed,
    reload: null,
  }]);
  assert.equal(incomplete.passed, false);
  assert.deepEqual(incomplete.failureReasons, [
    "drawing-engine-evidence-observation-incomplete",
  ]);

  assert.equal(summarizeDrawingEngineDomEvidenceAssessments([], {
    required: false,
  }).passed, true);
});
