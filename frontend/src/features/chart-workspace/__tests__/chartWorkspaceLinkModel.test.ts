import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import { chartWorkspaceCell } from "../chartWorkspaceDocument.js";
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

  assert.equal(chartWorkspaceCell(next, "cell-1").session.interval, "30m");
  for (const cellId of ["cell-2", "cell-3", "cell-4"] as const) {
    assert.equal(chartWorkspaceCell(next, cellId).session.symbol, "ETHUSDT");
    assert.equal(chartWorkspaceCell(next, cellId).session.marketType, "futures");
    assert.equal(chartWorkspaceCell(next, cellId).session.interval, previousIntervals[cellId]);
  }
});

test("interval linking propagates only inside the source group", () => {
  const workspace = createDefaultChartWorkspace();
  workspace.linkGroups.A.interval = true;
  chartWorkspaceCell(workspace, "cell-4").linkGroup = "B";
  const cell4Interval = chartWorkspaceCell(workspace, "cell-4").session.interval;
  const next = applyLinkedSessionUpdate(workspace, "cell-1", {
    ...chartWorkspaceCell(workspace, "cell-1").session,
    interval: "30m",
  });

  assert.equal(chartWorkspaceCell(next, "cell-2").session.interval, "30m");
  assert.equal(chartWorkspaceCell(next, "cell-3").session.interval, "30m");
  assert.equal(chartWorkspaceCell(next, "cell-4").session.interval, cell4Interval);
});

test("joining a populated group aligns enabled fields without overwriting independent fields", () => {
  const workspace = createDefaultChartWorkspace();
  chartWorkspaceCell(workspace, "cell-4").linkGroup = null;
  chartWorkspaceCell(workspace, "cell-4").session = {
    exchange: "okx",
    marketType: "futures",
    symbol: "SOLUSDT",
    interval: "1d",
  };
  const next = assignCellLinkGroup(workspace, "cell-4", "A");

  assert.equal(chartWorkspaceCell(next, "cell-4").linkGroup, "A");
  assert.equal(chartWorkspaceCell(next, "cell-4").session.symbol, chartWorkspaceCell(workspace, "cell-1").session.symbol);
  assert.equal(chartWorkspaceCell(next, "cell-4").session.exchange, chartWorkspaceCell(workspace, "cell-1").session.exchange);
  assert.equal(chartWorkspaceCell(next, "cell-4").session.interval, "1d");
});

test("source, destination, and bidirectional roles constrain session propagation", () => {
  const workspace = createDefaultChartWorkspace();
  chartWorkspaceCell(workspace, "cell-1").linkRole = "source";
  chartWorkspaceCell(workspace, "cell-2").linkRole = "source";
  chartWorkspaceCell(workspace, "cell-3").linkRole = "destination";
  chartWorkspaceCell(workspace, "cell-4").linkRole = "bidirectional";

  const fromSource = applyLinkedSessionUpdate(workspace, "cell-1", {
    ...chartWorkspaceCell(workspace, "cell-1").session,
    symbol: "ETHUSDT",
  });
  assert.notEqual(chartWorkspaceCell(fromSource, "cell-2").session.symbol, "ETHUSDT");
  assert.equal(chartWorkspaceCell(fromSource, "cell-3").session.symbol, "ETHUSDT");
  assert.equal(chartWorkspaceCell(fromSource, "cell-4").session.symbol, "ETHUSDT");

  const fromDestination = applyLinkedSessionUpdate(fromSource, "cell-3", {
    ...chartWorkspaceCell(fromSource, "cell-3").session,
    symbol: "SOLUSDT",
  });
  assert.equal(chartWorkspaceCell(fromDestination, "cell-3").session.symbol, "SOLUSDT");
  assert.equal(chartWorkspaceCell(fromDestination, "cell-1").session.symbol, "ETHUSDT");
  assert.equal(chartWorkspaceCell(fromDestination, "cell-4").session.symbol, "ETHUSDT");
});

test("a cell becoming a destination aligns from the group's explicit source", () => {
  const workspace = createDefaultChartWorkspace();
  chartWorkspaceCell(workspace, "cell-1").linkRole = "source";
  chartWorkspaceCell(workspace, "cell-1").session = {
    ...chartWorkspaceCell(workspace, "cell-1").session,
    symbol: "ETHUSDT",
  };
  chartWorkspaceCell(workspace, "cell-2").session = {
    ...chartWorkspaceCell(workspace, "cell-2").session,
    symbol: "SOLUSDT",
  };

  const next = assignCellLinkRole(workspace, "cell-2", "destination");
  assert.equal(chartWorkspaceCell(next, "cell-2").linkRole, "destination");
  assert.equal(chartWorkspaceCell(next, "cell-2").session.symbol, "ETHUSDT");
  assert.equal(chartWorkspaceCell(next, "cell-2").session.interval, chartWorkspaceCell(workspace, "cell-2").session.interval);
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
