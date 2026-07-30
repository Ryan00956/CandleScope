import assert from "node:assert/strict";
import test from "node:test";
import {
  composeDrawingPaneExportLeases,
  drawingPaneWarmMountKeys,
  drawingPaneIdAfterPointerLeave,
  drawingToolForPane,
  drawingPaneScopeKey,
  isDrawingInteractionReady,
  ownsDrawingApiRegistrationCleanup,
  reconcileRegisteredDrawingPaneMountKeys,
  reconcileDrawingPaneHostMountKeys,
  resolveDrawingInteractionPaneId,
} from "../drawingPaneSurface.js";
import type { DrawingExportLease } from "../../features/drawings/drawingInteractionController.js";

function lease(
  scopeKey: string,
  documentRevision: number,
  options: Readonly<{ valid?: boolean; restore?: () => Promise<void> }> = {},
): DrawingExportLease {
  return Object.freeze({
    leaseId: documentRevision,
    receipt: Object.freeze({ scopeKey, documentRevision }),
    revalidate: async () => options.valid !== false,
    restore: options.restore ?? (async () => {}),
  }) as unknown as DrawingExportLease;
}

test("pane drawing scope keys retain the pre-native-pane persistence contract", () => {
  assert.equal(drawingPaneScopeKey("BTCUSDT", "rsi-14"), "BTCUSDT__rsi-14");
});

test("idle drawing input follows hover and falls back to the main pane", () => {
  assert.equal(resolveDrawingInteractionPaneId({
    drawingToolActive: true,
    hoveredPaneId: "volume-vol",
    paneIds: ["main", "volume-vol"],
  }), "volume-vol");
  assert.equal(resolveDrawingInteractionPaneId({
    drawingToolActive: true,
    hoveredPaneId: null,
    paneIds: ["main", "volume-vol"],
  }), "main");
  assert.equal(resolveDrawingInteractionPaneId({
    drawingToolActive: false,
    hoveredPaneId: "volume-vol",
    paneIds: ["main", "volume-vol"],
  }), null);
});

test("only the interaction pane receives the active drawing tool", () => {
  assert.equal(drawingToolForPane("pen", "volume-vol", "volume-vol"), "pen");
  assert.equal(drawingToolForPane("pen", "volume-vol", "main"), null);
  assert.equal(drawingToolForPane(null, "volume-vol", "volume-vol"), null);
  assert.equal(drawingToolForPane("cursor-crosshair", null, "main"), "cursor-crosshair");
  assert.equal(drawingToolForPane("cursor-crosshair", null, "volume-vol"), "cursor-crosshair");
});

test("pointer leave preserves an active drawing pane owner until chart re-entry", () => {
  assert.equal(drawingPaneIdAfterPointerLeave("volume-vol", true), "volume-vol");
  assert.equal(drawingPaneIdAfterPointerLeave("volume-vol", false), null);
  assert.equal(drawingPaneIdAfterPointerLeave(null, true), null);
});

test("only the next pointer-owned pane is warmed and admitted for interaction", () => {
  assert.deepEqual([...drawingPaneWarmMountKeys({
    dataReady: true,
    interactionDrawingKey: "BTCUSDT__volume-vol",
    loading: false,
  })], ["BTCUSDT__volume-vol"]);
  assert.deepEqual([...drawingPaneWarmMountKeys({
    dataReady: false,
    interactionDrawingKey: "BTCUSDT__main",
    loading: false,
  })], []);

  assert.equal(isDrawingInteractionReady({
    interactionDrawingKey: "BTCUSDT__main",
    registeredKeys: new Set(["BTCUSDT__main"]),
    surfaceDataReady: true,
    supportsDrawingFeatures: true,
  }), true);
  assert.equal(isDrawingInteractionReady({
    interactionDrawingKey: "BTCUSDT__volume-vol",
    registeredKeys: new Set(["BTCUSDT__main"]),
    surfaceDataReady: true,
    supportsDrawingFeatures: true,
  }), false);
  assert.equal(isDrawingInteractionReady({
    interactionDrawingKey: "BTCUSDT__volume-vol",
    registeredKeys: new Set(["BTCUSDT__volume-vol"]),
    surfaceDataReady: false,
    supportsDrawingFeatures: true,
  }), false);
  assert.equal(isDrawingInteractionReady({
    interactionDrawingKey: null,
    registeredKeys: new Set(),
    surfaceDataReady: false,
    supportsDrawingFeatures: false,
  }), true);
});

test("late API cleanup cannot remove a newer same-key or different-scope host", () => {
  const oldApi = {};
  const newApi = {};
  assert.equal(ownsDrawingApiRegistrationCleanup({
    cleanupApi: oldApi,
    cleanupKey: "BTCUSDT__main",
    currentApi: newApi,
    currentKey: "BTCUSDT__main",
  }), false);
  assert.equal(ownsDrawingApiRegistrationCleanup({
    cleanupApi: oldApi,
    cleanupKey: "BTCUSDT__main",
    currentApi: oldApi,
    currentKey: "BTCUSDT__main",
  }), true);
  assert.equal(ownsDrawingApiRegistrationCleanup({
    cleanupApi: null,
    cleanupKey: "BTCUSDT__main",
    currentApi: newApi,
    currentKey: "BTCUSDT__main",
  }), false);
  assert.equal(ownsDrawingApiRegistrationCleanup({
    cleanupApi: null,
    cleanupKey: "BTCUSDT__main",
    currentApi: newApi,
    currentKey: "ETHUSDT__main",
  }), false);
});

test("registered readiness keys follow the current pane API map after late cleanup", () => {
  const afterScopeBRegistered = reconcileRegisteredDrawingPaneMountKeys(
    new Set(["BTCUSDT__main", "ETHUSDT__main"]),
    new Map([["main", "ETHUSDT__main"]]).values(),
  );
  assert.deepEqual([...afterScopeBRegistered], ["ETHUSDT__main"]);

  const sameKeyRefresh = reconcileRegisteredDrawingPaneMountKeys(
    new Set(["BTCUSDT__main"]),
    new Map([["main", "BTCUSDT__main"]]).values(),
  );
  assert.deepEqual([...sameKeyRefresh], ["BTCUSDT__main"]);
});

test("an admitted pane host remains mounted across hover routing and prunes on scope removal", () => {
  const retained = new Set(["BTCUSDT__volume-vol"]);
  const next = reconcileDrawingPaneHostMountKeys({
    admittedKeys: new Set(["BTCUSDT__main"]),
    availableKeys: new Set(["BTCUSDT__main", "BTCUSDT__volume-vol"]),
    retainedKeys: retained,
  });
  assert.deepEqual([...next], ["BTCUSDT__volume-vol", "BTCUSDT__main"]);

  const stable = reconcileDrawingPaneHostMountKeys({
    admittedKeys: new Set(),
    availableKeys: new Set(["BTCUSDT__main", "BTCUSDT__volume-vol"]),
    retainedKeys: next,
  });
  assert.strictEqual(stable, next);

  const pruned = reconcileDrawingPaneHostMountKeys({
    admittedKeys: new Set(),
    availableKeys: new Set(["ETHUSDT__main"]),
    retainedKeys: stable,
  });
  assert.deepEqual([...pruned], []);
});

test("one pane export lease remains identity-stable", () => {
  const only = lease("BTCUSDT__main", 4);
  assert.strictEqual(composeDrawingPaneExportLeases([only]), only);
});

test("composite export targets cover every pane revision and restore every lease once", async () => {
  let mainRestores = 0;
  let rsiRestores = 0;
  const main = lease("BTCUSDT__main", 4, {
    restore: async () => { mainRestores += 1; },
  });
  const rsi = lease("BTCUSDT__rsi", 9, {
    restore: async () => { rsiRestores += 1; },
  });
  const composite = composeDrawingPaneExportLeases([main, rsi]);
  const changed = composeDrawingPaneExportLeases([main, lease("BTCUSDT__rsi", 10)]);

  assert.ok(composite);
  assert.ok(changed);
  assert.match(composite.receipt.scopeKey, /^drawing-pane-set:/);
  assert.notEqual(composite.receipt.documentRevision, changed.receipt.documentRevision);
  assert.equal(await composite.revalidate(), true);
  await Promise.all([composite.restore(), composite.restore()]);
  assert.equal(mainRestores, 1);
  assert.equal(rsiRestores, 1);
});

test("composite revalidation fails closed when any pane becomes stale", async () => {
  const composite = composeDrawingPaneExportLeases([
    lease("BTCUSDT__main", 1),
    lease("BTCUSDT__macd", 2, { valid: false }),
  ]);
  assert.ok(composite);
  assert.equal(await composite.revalidate(), false);
});
