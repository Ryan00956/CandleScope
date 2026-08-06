import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartLinkCoordinator,
  type ChartLinkSurface,
} from "../chartLinkCoordinator.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";

function recordingSurface() {
  const crosshair: Array<number | null> = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const surface: ChartLinkSurface = {
    setLinkedCrosshairTime: (time) => {
      crosshair.push(time);
      return true;
    },
    setLinkedVisibleTimeRange: (range) => {
      ranges.push(range);
      return true;
    },
  };
  return { surface, crosshair, ranges };
}

test("crosshair and time ranges fan out only to registered cells in the same enabled group", () => {
  const document = createDefaultChartWorkspace();
  document.cells["cell-4"].linkGroup = "B";
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
  coordinator.publishTimeRange("cell-1", { from: 200, to: 100 });

  assert.deepEqual(cell1.crosshair, []);
  assert.deepEqual(cell2.crosshair, [1_700_000_000]);
  assert.deepEqual(cell3.crosshair, [1_700_000_000]);
  assert.deepEqual(cell4.crosshair, []);
  assert.deepEqual(cell2.ranges, [{ from: 100, to: 200 }]);
  assert.deepEqual(cell3.ranges, [{ from: 100, to: 200 }]);
  assert.deepEqual(cell4.ranges, []);
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
