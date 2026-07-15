import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareDrawingExportFailClosed,
} from "../drawingExportReadiness.js";
import type {
  DrawingExportReadinessDependencies,
  DrawingExportReadyApi,
} from "../drawingExportReadiness.js";
import type { DrawingExportLease } from "../../drawingInteractionController.js";

const lease = Object.freeze({ leaseId: 1 }) as unknown as DrawingExportLease;

function fixture(overrides: Partial<DrawingExportReadinessDependencies> = {}) {
  let api: DrawingExportReadyApi | null = null;
  let probeCount = 0;
  let prepareCount = 0;
  const dependencies: DrawingExportReadinessDependencies = {
    drawingKey: "scope",
    drawingToolActive: false,
    engineLoadError: null,
    getApi: () => api,
    hasPresenceHint: () => false,
    probePresence: async () => {
      probeCount += 1;
      return false;
    },
    supportsDrawingFeatures: true,
    ...overrides,
  };
  return {
    dependencies,
    installApi() {
      api = { prepareExport: async () => { prepareCount += 1; return lease; } };
    },
    prepareCount: () => prepareCount,
    probeCount: () => probeCount,
  };
}

test("ready API runs immediately without storage probing", async () => {
  const state = fixture();
  state.installApi();
  assert.strictEqual(await prepareDrawingExportFailClosed(state.dependencies), lease);
  assert.equal(state.prepareCount(), 1);
  assert.equal(state.probeCount(), 0);
});

test("only confirmed missing drawings may continue without a lease", async () => {
  const missing = fixture();
  assert.equal(await prepareDrawingExportFailClosed(missing.dependencies), null);
  assert.equal(missing.probeCount(), 1);

  const unsupported = fixture({ supportsDrawingFeatures: false });
  assert.equal(await prepareDrawingExportFailClosed(unsupported.dependencies), null);
  assert.equal(unsupported.probeCount(), 0);
});

test("API mounted during the presence probe is used for the barrier", async () => {
  const state = fixture();
  const dependencies: DrawingExportReadinessDependencies = {
    ...state.dependencies,
    probePresence: async () => {
      state.installApi();
      return true;
    },
  };
  assert.strictEqual(await prepareDrawingExportFailClosed(dependencies), lease);
  assert.equal(state.prepareCount(), 1);
});

test("present/loading and module failure states reject instead of omitting drawings", async () => {
  const loading = fixture({ hasPresenceHint: () => true });
  await assert.rejects(prepareDrawingExportFailClosed(loading.dependencies), /仍在加载/);

  const failed = fixture({
    engineLoadError: new Error("chunk failed"),
    hasPresenceHint: () => true,
  });
  await assert.rejects(prepareDrawingExportFailClosed(failed.dependencies), /加载失败/);
});

test("invalid or unavailable presence errors propagate fail-closed", async () => {
  const state = fixture({
    probePresence: async () => { throw new Error("IDB denied"); },
  });
  await assert.rejects(prepareDrawingExportFailClosed(state.dependencies), /IDB denied/);
});
