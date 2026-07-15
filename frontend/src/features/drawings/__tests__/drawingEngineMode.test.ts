import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_ENGINE_MODES,
  isDrawingEngineMode,
  resolvePhase3DrawingEngineMode,
  resolveRequestedDrawingEngineMode,
} from "../drawingEngineMode.js";

test("drawing engine mode resolver accepts the four exact rollout values", () => {
  for (const mode of DRAWING_ENGINE_MODES) {
    assert.equal(isDrawingEngineMode(mode), true);
    assert.deepEqual(
      resolveRequestedDrawingEngineMode({ configured: mode, allowUrlOverride: false }),
      { mode, source: "environment" },
    );
  }
  assert.equal(isDrawingEngineMode("SHADOW"), false);
  assert.equal(isDrawingEngineMode("unknown"), false);
});

test("development URL override wins but production ignores user-controlled input", () => {
  assert.deepEqual(resolveRequestedDrawingEngineMode({
    configured: "legacy",
    urlSearch: "?drawingEngineMode=shadow",
    allowUrlOverride: true,
  }), { mode: "shadow", source: "url" });
  assert.deepEqual(resolveRequestedDrawingEngineMode({
    configured: "legacy",
    urlSearch: "?drawingEngineMode=shadow",
    allowUrlOverride: false,
  }), { mode: "legacy", source: "environment" });
});

test("invalid configuration and URL values fall back to the release default", () => {
  assert.deepEqual(resolveRequestedDrawingEngineMode({
    configured: "invalid",
    urlSearch: "?drawingEngineMode=also-invalid",
    allowUrlOverride: true,
  }), { mode: "legacy", source: "default" });
  assert.deepEqual(resolveRequestedDrawingEngineMode({
    configured: null,
    allowUrlOverride: false,
    defaultMode: "shadow",
  }), { mode: "shadow", source: "default" });
});

test("Phase 3 enables only invisible shadow work and fails visible modes closed", () => {
  assert.deepEqual(resolvePhase3DrawingEngineMode({ configured: "shadow" }), {
    requested: "shadow",
    effective: "shadow",
    source: "environment",
    failedClosed: false,
  });
  assert.deepEqual(resolvePhase3DrawingEngineMode({ configured: "scene-canary" }), {
    requested: "scene-canary",
    effective: "legacy",
    source: "environment",
    failedClosed: true,
  });
  assert.deepEqual(resolvePhase3DrawingEngineMode({ configured: "scene" }), {
    requested: "scene",
    effective: "legacy",
    source: "environment",
    failedClosed: true,
  });
});

test("a resolved mode is an immutable mount-time value", () => {
  const mounted = resolvePhase3DrawingEngineMode({ configured: "shadow" });
  const laterEnvironment = resolvePhase3DrawingEngineMode({ configured: "legacy" });
  assert.equal(Object.isFrozen(mounted), true);
  assert.equal(mounted.effective, "shadow");
  assert.equal(laterEnvironment.effective, "legacy");
  assert.notStrictEqual(mounted, laterEnvironment);
});
