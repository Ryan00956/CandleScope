const EXPECTED_DRAWING_ENGINE_DOM_EVIDENCE = Object.freeze({
  interactionMode: "overlay",
  registryKind: "scene-document-only",
  effectiveEngineMode: "scene-canary",
  legacyPrimitiveInstanceCount: 0,
  legacyPrimitiveAttachedCount: 0,
  zeroLegacyPrimitiveInvariant: true,
});

function nonNegativeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : null));
}

/**
 * Runs in the page through CDP. Keep this function self-contained because both
 * smoke.mjs and drawing-performance.mjs serialize it with Function#toString.
 */
export function drawingEngineDomEvidenceBrowserSnapshot() {
  const interactionModes = Array.from(
    document.querySelectorAll("[data-drawing-interaction-mode]"),
    (node) => node.getAttribute("data-drawing-interaction-mode"),
  );
  const registries = Array.from(
    document.querySelectorAll("[data-drawing-registry-kind]"),
    (node) => ({
      registryKind: node.getAttribute("data-drawing-registry-kind"),
      legacyPrimitiveInstanceCount: node.getAttribute("data-drawing-legacy-instances"),
      legacyPrimitiveAttachedCount: node.getAttribute("data-drawing-legacy-attached"),
      zeroLegacyPrimitiveInvariant: node.getAttribute("data-drawing-zero-legacy"),
    }),
  );
  const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
  const runtimeSummary = drawingHandle?.readRuntimeSummary?.() || null;
  return {
    hostReadyCount: document.querySelectorAll('[data-drawing-engine="ready"]').length,
    interactionModes,
    registries,
    drawingHandlePresent: Boolean(drawingHandle),
    effectiveEngineMode: runtimeSummary?.effectiveEngineMode ?? null,
  };
}

export function normalizeDrawingEngineDomEvidence(raw) {
  const candidate = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const hostReadyCount = nonNegativeInteger(candidate.hostReadyCount) ?? 0;
  const interactionModes = stringArray(candidate.interactionModes);
  const registries = Array.isArray(candidate.registries)
    ? candidate.registries.map((entry) => {
        const registry = entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry
          : {};
        return {
          registryKind: typeof registry.registryKind === "string"
            ? registry.registryKind
            : null,
          legacyPrimitiveInstanceCount: nonNegativeInteger(
            registry.legacyPrimitiveInstanceCount,
          ),
          legacyPrimitiveAttachedCount: nonNegativeInteger(
            registry.legacyPrimitiveAttachedCount,
          ),
          zeroLegacyPrimitiveInvariant: registry.zeroLegacyPrimitiveInvariant === true
            || registry.zeroLegacyPrimitiveInvariant === "true",
          zeroLegacyPrimitiveInvariantPresent:
            registry.zeroLegacyPrimitiveInvariant === true
            || registry.zeroLegacyPrimitiveInvariant === false
            || registry.zeroLegacyPrimitiveInvariant === "true"
            || registry.zeroLegacyPrimitiveInvariant === "false",
        };
      })
    : [];
  return {
    hostReadyCount,
    interactionModes,
    registries,
    drawingHandlePresent: candidate.drawingHandlePresent === true,
    effectiveEngineMode: typeof candidate.effectiveEngineMode === "string"
      ? candidate.effectiveEngineMode
      : null,
  };
}

export function assessDrawingEngineDomEvidence(raw, { required = true } = {}) {
  const evidence = normalizeDrawingEngineDomEvidence(raw);
  if (!required) {
    return {
      required: false,
      passed: true,
      evidence,
      failureReasons: [],
    };
  }

  const failureReasons = [];
  if (evidence.hostReadyCount === 0) {
    failureReasons.push("drawing-engine-host-ready-marker-missing");
  }
  if (evidence.interactionModes.length === 0) {
    failureReasons.push("drawing-interaction-mode-evidence-missing");
  } else if (evidence.interactionModes.some(
    (mode) => mode !== EXPECTED_DRAWING_ENGINE_DOM_EVIDENCE.interactionMode,
  )) {
    failureReasons.push("drawing-interaction-mode-not-overlay");
  }
  if (evidence.registries.length === 0) {
    failureReasons.push("drawing-registry-evidence-missing");
  }
  if (evidence.hostReadyCount > 0 && (
    evidence.interactionModes.length !== evidence.hostReadyCount
    || evidence.registries.length !== evidence.hostReadyCount
  )) {
    failureReasons.push("drawing-engine-host-evidence-count-mismatch");
  }
  for (const registry of evidence.registries) {
    if (registry.registryKind !== EXPECTED_DRAWING_ENGINE_DOM_EVIDENCE.registryKind) {
      failureReasons.push("drawing-registry-kind-not-scene-document-only");
    }
    if (registry.legacyPrimitiveInstanceCount === null) {
      failureReasons.push("drawing-legacy-instance-count-missing-or-invalid");
    } else if (registry.legacyPrimitiveInstanceCount !== 0) {
      failureReasons.push("drawing-legacy-instance-count-not-zero");
    }
    if (registry.legacyPrimitiveAttachedCount === null) {
      failureReasons.push("drawing-legacy-attached-count-missing-or-invalid");
    } else if (registry.legacyPrimitiveAttachedCount !== 0) {
      failureReasons.push("drawing-legacy-attached-count-not-zero");
    }
    if (!registry.zeroLegacyPrimitiveInvariantPresent) {
      failureReasons.push("drawing-zero-legacy-invariant-missing");
    } else if (!registry.zeroLegacyPrimitiveInvariant) {
      failureReasons.push("drawing-zero-legacy-invariant-false");
    }
  }
  if (!evidence.drawingHandlePresent) {
    failureReasons.push("drawing-runtime-evidence-missing");
  }
  if (evidence.effectiveEngineMode !== EXPECTED_DRAWING_ENGINE_DOM_EVIDENCE.effectiveEngineMode) {
    failureReasons.push("drawing-engine-mode-not-scene-canary");
  }

  return {
    required: true,
    passed: failureReasons.length === 0,
    evidence,
    failureReasons: Array.from(new Set(failureReasons)),
  };
}

export function formatDrawingEngineDomEvidenceFailure(assessment, label = "Drawing engine") {
  if (!assessment?.required || assessment?.passed) return "";
  const reasons = Array.isArray(assessment?.failureReasons)
    ? assessment.failureReasons.join(", ")
    : "unknown-evidence-failure";
  return `${label} Phase 8 DOM evidence failed: ${reasons}. Observed ${JSON.stringify(
    assessment?.evidence ?? null,
  )}`;
}

export function shouldRequireDrawingEngineDomEvidenceForSmoke({
  drawingCheck = false,
  overlayHeavy = false,
} = {}) {
  return drawingCheck === true || overlayHeavy === true;
}

export function shouldRequireDrawingEngineDomEvidenceForPerformance({
  phase = null,
  interactionSurfaceMode = null,
} = {}) {
  // Phase 5/6 are the retained-overlay release paths used by the Phase 8
  // acceptance run. Older phase0-4 legacy/shadow baselines remain runnable.
  return phase === "phase5"
    || phase === "phase6"
    || interactionSurfaceMode === "overlay";
}

export function summarizeDrawingEngineDomEvidenceAssessments(records, { required = true } = {}) {
  const candidates = Array.isArray(records) ? records : [];
  const observations = candidates.flatMap((record, index) => {
    const id = typeof record?.id === "string" ? record.id : `run-${index + 1}`;
    return [
      { id: `${id}:initial`, assessment: record?.initial ?? null },
      { id: `${id}:reload`, assessment: record?.reload ?? null },
    ];
  });
  const observed = observations.filter(({ assessment }) => (
    assessment && typeof assessment === "object"
  ));
  const failed = observed.filter(({ assessment }) => assessment.passed !== true);
  const incomplete = observed.length !== observations.length;
  const failureReasons = Array.from(new Set([
    ...(incomplete ? ["drawing-engine-evidence-observation-incomplete"] : []),
    ...failed.flatMap(({ assessment }) => (
      Array.isArray(assessment.failureReasons) ? assessment.failureReasons : []
    )),
  ]));
  return {
    required: required === true,
    passed: required !== true || (
      observations.length > 0
      && !incomplete
      && failed.length === 0
    ),
    expectedObservationCount: observations.length,
    observedObservationCount: observed.length,
    failedObservationIds: failed.map(({ id }) => id),
    failureReasons,
  };
}

export { EXPECTED_DRAWING_ENGINE_DOM_EVIDENCE };
