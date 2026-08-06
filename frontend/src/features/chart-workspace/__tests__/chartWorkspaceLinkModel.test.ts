import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  applyLinkedSessionUpdate,
  assignCellLinkGroup,
} from "../chartWorkspaceLinkModel.js";

test("market linking preserves each target interval when interval linking is disabled", () => {
  const workspace = createDefaultChartWorkspace();
  const previousIntervals = Object.fromEntries(
    Object.values(workspace.cells).map((cell) => [cell.id, cell.session.interval]),
  );
  const next = applyLinkedSessionUpdate(workspace, "cell-1", {
    exchange: "binance",
    marketType: "futures",
    symbol: "ETHUSDT",
    interval: "30m",
  });

  assert.equal(next.cells["cell-1"].session.interval, "30m");
  for (const cellId of ["cell-2", "cell-3", "cell-4"] as const) {
    assert.equal(next.cells[cellId].session.symbol, "ETHUSDT");
    assert.equal(next.cells[cellId].session.marketType, "futures");
    assert.equal(next.cells[cellId].session.interval, previousIntervals[cellId]);
  }
});

test("interval linking propagates only inside the source group", () => {
  const workspace = createDefaultChartWorkspace();
  workspace.linkGroups.A.interval = true;
  workspace.cells["cell-4"].linkGroup = "B";
  const cell4Interval = workspace.cells["cell-4"].session.interval;
  const next = applyLinkedSessionUpdate(workspace, "cell-1", {
    ...workspace.cells["cell-1"].session,
    interval: "30m",
  });

  assert.equal(next.cells["cell-2"].session.interval, "30m");
  assert.equal(next.cells["cell-3"].session.interval, "30m");
  assert.equal(next.cells["cell-4"].session.interval, cell4Interval);
});

test("joining a populated group aligns enabled fields without overwriting independent fields", () => {
  const workspace = createDefaultChartWorkspace();
  workspace.cells["cell-4"].linkGroup = null;
  workspace.cells["cell-4"].session = {
    exchange: "okx",
    marketType: "futures",
    symbol: "SOLUSDT",
    interval: "1d",
  };
  const next = assignCellLinkGroup(workspace, "cell-4", "A");

  assert.equal(next.cells["cell-4"].linkGroup, "A");
  assert.equal(next.cells["cell-4"].session.symbol, workspace.cells["cell-1"].session.symbol);
  assert.equal(next.cells["cell-4"].session.exchange, workspace.cells["cell-1"].session.exchange);
  assert.equal(next.cells["cell-4"].session.interval, "1d");
});
