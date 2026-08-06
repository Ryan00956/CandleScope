import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  applyChartLinkSettingsPatch,
  applyLinkedSessionUpdate,
  assignCellLinkGroup,
  assignCellLinkRole,
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

test("source, destination, and bidirectional roles constrain session propagation", () => {
  const workspace = createDefaultChartWorkspace();
  workspace.cells["cell-1"].linkRole = "source";
  workspace.cells["cell-2"].linkRole = "source";
  workspace.cells["cell-3"].linkRole = "destination";
  workspace.cells["cell-4"].linkRole = "bidirectional";

  const fromSource = applyLinkedSessionUpdate(workspace, "cell-1", {
    ...workspace.cells["cell-1"].session,
    symbol: "ETHUSDT",
  });
  assert.notEqual(fromSource.cells["cell-2"].session.symbol, "ETHUSDT");
  assert.equal(fromSource.cells["cell-3"].session.symbol, "ETHUSDT");
  assert.equal(fromSource.cells["cell-4"].session.symbol, "ETHUSDT");

  const fromDestination = applyLinkedSessionUpdate(fromSource, "cell-3", {
    ...fromSource.cells["cell-3"].session,
    symbol: "SOLUSDT",
  });
  assert.equal(fromDestination.cells["cell-3"].session.symbol, "SOLUSDT");
  assert.equal(fromDestination.cells["cell-1"].session.symbol, "ETHUSDT");
  assert.equal(fromDestination.cells["cell-4"].session.symbol, "ETHUSDT");
});

test("a cell becoming a destination aligns from the group's explicit source", () => {
  const workspace = createDefaultChartWorkspace();
  workspace.cells["cell-1"].linkRole = "source";
  workspace.cells["cell-1"].session = {
    ...workspace.cells["cell-1"].session,
    symbol: "ETHUSDT",
  };
  workspace.cells["cell-2"].session = {
    ...workspace.cells["cell-2"].session,
    symbol: "SOLUSDT",
  };

  const next = assignCellLinkRole(workspace, "cell-2", "destination");
  assert.equal(next.cells["cell-2"].linkRole, "destination");
  assert.equal(next.cells["cell-2"].session.symbol, "ETHUSDT");
  assert.equal(next.cells["cell-2"].session.interval, workspace.cells["cell-2"].session.interval);
});

test("time-anchor and date-range settings remain mutually exclusive", () => {
  const workspace = createDefaultChartWorkspace();
  const anchor = applyChartLinkSettingsPatch(workspace.linkGroups.A, { timeAnchor: true });
  assert.equal(anchor.timeAnchor, true);
  assert.equal(anchor.dateRange, false);

  const range = applyChartLinkSettingsPatch(anchor, { dateRange: true });
  assert.equal(range.dateRange, true);
  assert.equal(range.timeAnchor, false);
});
