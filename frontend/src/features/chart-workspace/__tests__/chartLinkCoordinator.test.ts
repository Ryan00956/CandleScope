import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartLinkCoordinator,
  type ChartLinkSurface,
} from "../chartLinkCoordinator.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import { chartWorkspaceCell } from "../chartWorkspaceDocument.js";

function recordingSurface() {
  const crosshair: Array<number | null> = [];
  const anchors: number[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const readyListeners = new Set<(generation: number) => void>();
  let readyGeneration = 0;
  const surface: ChartLinkSurface = {
    setLinkedCrosshairTime: (time) => {
      crosshair.push(time);
      return true;
    },
    setLinkedVisibleTimeAnchor: (time) => {
      anchors.push(time);
      return true;
    },
    setLinkedVisibleTimeRange: (range) => {
      ranges.push(range);
      return true;
    },
    subscribeLinkedViewportReady: (listener) => {
      readyListeners.add(listener);
      return () => { readyListeners.delete(listener); };
    },
  };
  return {
    surface,
    crosshair,
    anchors,
    ranges,
    signalReady: () => {
      readyGeneration += 1;
      for (const listener of [...readyListeners]) listener(readyGeneration);
    },
  };
}

test("crosshair and time ranges fan out only to registered cells in the same enabled group", () => {
  const document = createDefaultChartWorkspace();
  chartWorkspaceCell(document, "cell-4").linkGroup = "B";
  const coordinator = new ChartLinkCoordinator(document);
  const cell1 = recordingSurface();
  const cell2 = recordingSurface();
  const cell3 = recordingSurface();
  const cell4 = recordingSurface();
  coordinator.register("cell-1", cell1.surface);
  coordinator.register("cell-2", cell2.surface);
  coordinator.register("cell-3", cell3.surface);
  coordinator.register("cell-4", cell4.surface);

  coordinator.publishCrosshair("cell-1", 1_700_000_000);
  coordinator.publishDateRange("cell-1", { from: 200, to: 100 });

  assert.deepEqual(cell1.crosshair, []);
  assert.deepEqual(cell2.crosshair, [1_700_000_000]);
  assert.deepEqual(cell3.crosshair, [1_700_000_000]);
  assert.deepEqual(cell4.crosshair, []);
  assert.deepEqual(cell2.ranges, [{ from: 100, to: 200 }]);
  assert.deepEqual(cell3.ranges, [{ from: 100, to: 200 }]);
  assert.deepEqual(cell4.ranges, []);
});

test("direction roles route viewport events only from publishers to receivers", () => {
  const document = createDefaultChartWorkspace();
  document.linkGroups.A.dateRange = false;
  document.linkGroups.A.timeAnchor = true;
  chartWorkspaceCell(document, "cell-1").linkRole = "source";
  chartWorkspaceCell(document, "cell-2").linkRole = "source";
  chartWorkspaceCell(document, "cell-3").linkRole = "destination";
  chartWorkspaceCell(document, "cell-4").linkRole = "bidirectional";
  const coordinator = new ChartLinkCoordinator(document);
  const cell1 = recordingSurface();
  const cell2 = recordingSurface();
  const cell3 = recordingSurface();
  const cell4 = recordingSurface();
  coordinator.register("cell-1", cell1.surface);
  coordinator.register("cell-2", cell2.surface);
  coordinator.register("cell-3", cell3.surface);
  coordinator.register("cell-4", cell4.surface);

  coordinator.publishTimeAnchor("cell-1", 1_700_000_000);
  assert.deepEqual(cell2.anchors, []);
  assert.deepEqual(cell3.anchors, [1_700_000_000]);
  assert.deepEqual(cell4.anchors, [1_700_000_000]);

  coordinator.publishTimeAnchor("cell-3", 1_800_000_000);
  assert.deepEqual(cell1.anchors, []);
  assert.deepEqual(cell4.anchors, [1_700_000_000]);
});

test("viewport mapping failures are isolated and reported without blocking healthy targets", () => {
  const document = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(document);
  const healthy = recordingSurface();
  const unsupported = recordingSurface();
  unsupported.surface.setLinkedVisibleTimeRange = () => false;
  coordinator.register("cell-2", healthy.surface);
  coordinator.register("cell-3", unsupported.surface);
  const issues: Array<ReturnType<typeof coordinator.getViewportIssue>> = [];
  coordinator.subscribeViewportIssue((issue) => issues.push(issue));

  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });

  assert.deepEqual(healthy.ranges, [{ from: 100, to: 200 }]);
  assert.deepEqual(coordinator.getViewportIssue(), {
    group: "A",
    kind: "dateRange",
    sourceCellId: "cell-1",
    failedCellIds: ["cell-3"],
  });
  assert.equal(issues.length, 1);
});

test("disabled links, unregister, and reentrant publications fail closed", () => {
  const document = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(document);
  const target = recordingSurface();
  target.surface.setLinkedCrosshairTime = (time) => {
    target.crosshair.push(time);
    coordinator.publishCrosshair("cell-2", time);
    return true;
  };
  const unregister = coordinator.register("cell-2", target.surface);

  coordinator.publishCrosshair("cell-1", 123);
  assert.deepEqual(target.crosshair, [123]);

  document.linkGroups.A.crosshair = false;
  coordinator.updateDocument(document);
  coordinator.publishCrosshair("cell-1", 456);
  assert.deepEqual(target.crosshair, [123]);

  unregister();
  assert.deepEqual(coordinator.registeredCellIds(), []);
});

test("an unmounted target catches up to only the latest retained viewport on remount", () => {
  const document = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(document, "workspace-1");
  const firstMount = recordingSurface();
  const unregister = coordinator.register("cell-2", firstMount.surface, "workspace-1");

  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });
  assert.deepEqual(firstMount.ranges, [{ from: 100, to: 200 }]);

  unregister();
  coordinator.publishDateRange("cell-1", { from: 300, to: 400 });
  coordinator.publishDateRange("cell-1", { from: 500, to: 600 });

  const remount = recordingSurface();
  coordinator.register("cell-2", remount.surface, "workspace-1");
  assert.deepEqual(remount.ranges, [{ from: 500, to: 600 }]);
});

test("a loading target retries retained viewport on readiness without an early warning", () => {
  const document = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(document, "workspace-1");
  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });

  const target = recordingSurface();
  let ready = false;
  target.surface.setLinkedVisibleTimeRange = (range) => {
    if (!ready) return false;
    target.ranges.push(range);
    return true;
  };
  coordinator.register("cell-2", target.surface, "workspace-1");
  assert.equal(coordinator.getViewportIssue(), null);
  assert.deepEqual(target.ranges, []);

  target.signalReady();
  assert.deepEqual(coordinator.getViewportIssue(), {
    group: "A",
    kind: "dateRange",
    sourceCellId: "cell-1",
    failedCellIds: ["cell-2"],
  });

  ready = true;
  target.signalReady();
  assert.deepEqual(target.ranges, [{ from: 100, to: 200 }]);
  assert.equal(coordinator.getViewportIssue(), null);
});

test("a new surface readiness generation reapplies an event delivered to the prior surface", () => {
  const document = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(document, "workspace-1");
  const target = recordingSurface();
  coordinator.register("cell-2", target.surface, "workspace-1");

  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });
  assert.deepEqual(target.ranges, [{ from: 100, to: 200 }]);

  target.signalReady();
  assert.deepEqual(target.ranges, [
    { from: 100, to: 200 },
    { from: 100, to: 200 },
  ]);
});

test("retained viewports stay isolated by workspace and survive switching away and back", () => {
  const workspace1 = createDefaultChartWorkspace();
  const workspace2 = createDefaultChartWorkspace();
  const coordinator = new ChartLinkCoordinator(workspace1, "workspace-1");

  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });
  coordinator.updateDocument(workspace2, "workspace-2");
  const workspace2Target = recordingSurface();
  const unregisterWorkspace2 = coordinator.register(
    "cell-2",
    workspace2Target.surface,
    "workspace-2",
  );
  assert.deepEqual(workspace2Target.ranges, []);

  coordinator.publishDateRange("cell-1", { from: 300, to: 400 });
  assert.deepEqual(workspace2Target.ranges, [{ from: 300, to: 400 }]);
  unregisterWorkspace2();

  coordinator.updateDocument(workspace1, "workspace-1");
  const workspace1Target = recordingSurface();
  coordinator.register("cell-2", workspace1Target.surface, "workspace-1");
  assert.deepEqual(workspace1Target.ranges, [{ from: 100, to: 200 }]);
});

test("role and link-setting changes invalidate an ineligible retained viewport", () => {
  const roleDocument = createDefaultChartWorkspace();
  const roleCoordinator = new ChartLinkCoordinator(roleDocument, "workspace-role");
  roleCoordinator.publishDateRange("cell-1", { from: 100, to: 200 });
  chartWorkspaceCell(roleDocument, "cell-1").linkRole = "destination";
  roleCoordinator.updateDocument(roleDocument, "workspace-role");
  const roleTarget = recordingSurface();
  roleCoordinator.register("cell-2", roleTarget.surface, "workspace-role");
  assert.deepEqual(roleTarget.ranges, []);

  const settingDocument = createDefaultChartWorkspace();
  const settingCoordinator = new ChartLinkCoordinator(settingDocument, "workspace-setting");
  settingCoordinator.publishDateRange("cell-1", { from: 300, to: 400 });
  settingDocument.linkGroups.A.dateRange = false;
  settingCoordinator.updateDocument(settingDocument, "workspace-setting");
  const settingTarget = recordingSurface();
  settingCoordinator.register("cell-2", settingTarget.surface, "workspace-setting");
  assert.deepEqual(settingTarget.ranges, []);
});

test("link diagnostics separate publish attempts, deliveries, and failures", () => {
  const document = createDefaultChartWorkspace();
  document.linkGroups.A.timeAnchor = true;
  const coordinator = new ChartLinkCoordinator(document, "workspace-diagnostics");
  const target = recordingSurface();
  coordinator.register("cell-2", target.surface, "workspace-diagnostics");

  coordinator.publishCrosshair("cell-1", 123);
  coordinator.publishTimeAnchor("cell-1", 456);
  coordinator.publishDateRange("cell-1", { from: 100, to: 200 });

  const snapshot = coordinator.snapshot();
  assert.deepEqual(snapshot.registeredCellIds, ["cell-2"]);
  assert.equal(snapshot.counts.crosshairPublishes, 1);
  assert.equal(snapshot.counts.crosshairTargetAttempts, 1);
  assert.equal(snapshot.counts.crosshairTargetDeliveries, 1);
  assert.equal(snapshot.counts.timeAnchorPublishes, 1);
  assert.equal(snapshot.counts.dateRangePublishes, 1);
  assert.equal(snapshot.counts.viewportTargetAttempts, 2);
  assert.equal(snapshot.counts.viewportTargetDeliveries, 2);
  assert.equal(snapshot.counts.viewportTargetFailures, 0);
  assert.deepEqual(snapshot.retainedViewportGroups, [{
    group: "A",
    kind: "dateRange",
    sourceCellId: "cell-1",
    failedCellIds: [],
  }]);
});
