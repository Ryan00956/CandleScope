import assert from "node:assert/strict";
import test from "node:test";

import type { ChartStrategyAttachmentRecord } from "../../../chart-workspace/chartWorkspaceTypes.js";
import { splitChartWorkspaceDocument } from "../../../chart-workspace/chartWorkspaceEditing.js";
import { chartWorkspaceCell } from "../../../chart-workspace/chartWorkspaceDocument.js";
import { createDefaultChartWorkspace } from "../../../chart-workspace/chartWorkspaceStorage.js";
import {
  ChartStrategyTesterRuntimeFactory,
  chartStrategyTesterCellScope,
} from "../ChartStrategyTesterRuntime.js";

const attachment: ChartStrategyAttachmentRecord = {
  schemaVersion: 1,
  strategyDraftId: "draft-12345678",
  strategyRevisionId: null,
  displayName: "Strategy",
  language: "pyne",
  parameters: {},
  rangeMode: "VISIBLE",
  customRange: null,
  fidelityPreference: "FAST",
  quickPresetId: "CRYPTO_PERP_STANDARD_V1",
  autoRun: false,
};

const activation = (cellId: string, attached = true) => ({
  workspaceId: "workspace-a",
  cellId,
  attachment: attached ? attachment : null,
  session: {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "1h",
  },
  draftContentRevision: 1,
});

test("flag off and 64 unattached cells create zero runtime instances", () => {
  const disabled = new ChartStrategyTesterRuntimeFactory(false);
  assert.equal(disabled.activate(activation("cell-1")), null);
  assert.equal(disabled.diagnostics().activeInstances, 0);

  const enabled = new ChartStrategyTesterRuntimeFactory(true);
  for (let index = 0; index < 64; index += 1) {
    assert.equal(enabled.activate(activation(`cell-${index}`, false)), null);
  }
  assert.deepEqual(enabled.diagnostics(), {
    enabled: true,
    activeInstances: 0,
    createdInstances: 0,
    disposedInstances: 0,
    scopes: [],
  });
});

test("N attached cells create at most N runtimes and repeated activation reuses identity", () => {
  const factory = new ChartStrategyTesterRuntimeFactory(true);
  const first = factory.activate(activation("cell-1"));
  assert.ok(first);
  assert.equal(factory.activate(activation("cell-1")), first);
  for (let index = 2; index <= 16; index += 1) factory.activate(activation(`cell-${index}`));
  assert.equal(factory.diagnostics().activeInstances, 16);
  assert.equal(factory.diagnostics().createdInstances, 16);
});

test("copy and blank edits do not create runtimes until explicit activation", () => {
  const factory = new ChartStrategyTesterRuntimeFactory(true);
  const source = createDefaultChartWorkspace();
  chartWorkspaceCell(source, "cell-1").strategyAttachment = attachment;
  const copied = splitChartWorkspaceDocument(source, "cell-1", "columns", "copy").document;
  assert.deepEqual(chartWorkspaceCell(copied, "cell-2").strategyAttachment, attachment);
  assert.equal(factory.diagnostics().activeInstances, 0);

  const blanked = splitChartWorkspaceDocument(source, "cell-1", "columns", "blank").document;
  assert.equal(chartWorkspaceCell(blanked, "cell-2").strategyAttachment, null);
  assert.equal(factory.diagnostics().activeInstances, 0);
});

test("close, detach, workspace deletion, and flag off fully dispose resources", () => {
  const factory = new ChartStrategyTesterRuntimeFactory(true);
  const runtime = factory.activate(activation("cell-1"));
  assert.ok(runtime);
  const controller = new AbortController();
  let cleanupCalls = 0;
  let markerClears = 0;
  let markerDisposals = 0;
  runtime.trackTimer(setTimeout(() => undefined, 60_000));
  runtime.trackAbortController(controller);
  runtime.trackCleanup(() => { cleanupCalls += 1; });
  runtime.setMarkerSource({
    clear: () => { markerClears += 1; },
    dispose: () => { markerDisposals += 1; },
  });
  runtime.setResultReference({ report: true });

  factory.reconcileActiveScopes(new Set());
  assert.equal(controller.signal.aborted, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(markerClears, 1);
  assert.equal(markerDisposals, 1);
  assert.deepEqual(runtime.diagnostics(), {
    disposed: true,
    timers: 0,
    abortControllers: 0,
    cleanups: 0,
    hasMarkerSource: false,
    hasResultReference: false,
  });
  assert.equal(factory.diagnostics().activeInstances, 0);

  const detached = factory.activate(activation("cell-2"));
  assert.ok(detached);
  assert.equal(factory.activate(activation("cell-2", false)), null);
  assert.equal(detached.diagnostics().disposed, true);
  factory.activate(activation("cell-2"));
  factory.activate({ ...activation("cell-3"), workspaceId: "workspace-b" });
  factory.releaseWorkspace("workspace-a");
  assert.equal(factory.diagnostics().activeInstances, 1);
  factory.setEnabled(false);
  assert.equal(factory.diagnostics().activeInstances, 0);
  assert.equal(factory.diagnostics().enabled, false);
});

test("cell scopes isolate identical cell ids across workspaces", () => {
  assert.notEqual(
    chartStrategyTesterCellScope("workspace-a", "cell-1"),
    chartStrategyTesterCellScope("workspace-b", "cell-1"),
  );
});
