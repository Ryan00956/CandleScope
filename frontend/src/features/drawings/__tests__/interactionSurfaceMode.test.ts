import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDrawingInteractionSurfaceMode,
  resolveEffectiveDrawingInteractionSurfaceMode,
} from "../interactionSurfaceMode.js";

test("interaction overlay is mount locked behind the Phase 5 rollout flag", () => {
  assert.deepEqual(resolveDrawingInteractionSurfaceMode({ configured: undefined }), {
    mode: "legacy",
    source: "default",
    failedClosed: false,
  });
  assert.deepEqual(resolveDrawingInteractionSurfaceMode({ configured: "legacy" }), {
    mode: "legacy",
    source: "environment",
    failedClosed: false,
  });
  assert.deepEqual(resolveDrawingInteractionSurfaceMode({ configured: "overlay" }), {
    mode: "overlay",
    source: "environment",
    failedClosed: false,
  });
});

test("overlay fails closed unless the single-scene static owner is active", () => {
  assert.equal(resolveEffectiveDrawingInteractionSurfaceMode("overlay", "scene-canary"), "overlay");
  assert.equal(resolveEffectiveDrawingInteractionSurfaceMode("overlay", "legacy"), "legacy");
  assert.equal(resolveEffectiveDrawingInteractionSurfaceMode("overlay", "shadow"), "legacy");
  assert.equal(resolveEffectiveDrawingInteractionSurfaceMode("legacy", "scene-canary"), "legacy");
});

test("invalid interaction surface configuration fails closed to the supported default", () => {
  assert.deepEqual(resolveDrawingInteractionSurfaceMode({ configured: "canvas-v3" }), {
    mode: "legacy",
    source: "default",
    failedClosed: true,
  });
});
