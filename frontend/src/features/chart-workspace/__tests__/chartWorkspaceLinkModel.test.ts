import assert from "node:assert/strict";
import test from "node:test";

import type { IndicatorDefinition } from "../../indicators/indicatorTypes.js";
import { chartWorkspaceCell } from "../chartWorkspaceDocument.js";
import {
  applyChartLinkSettingsPatch,
  applyLinkedIndicatorUpdate,
  applyLinkedSessionUpdate,
  cloneChartLinkSettings,
  resolveChartLinkTargets,
  resolveChartLinkTargetsForChannel,
} from "../chartWorkspaceLinkModel.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  DEFAULT_CHART_LINK_GROUP_ID,
  DEFAULT_CHART_LINK_GROUP_SETTINGS,
  type ChartWorkspaceDocument,
} from "../chartWorkspaceTypes.js";

function hierarchicalWorkspace(): ChartWorkspaceDocument {
  const document = createDefaultChartWorkspace();
  document.linkGroups["group-child"] = {
    id: "group-child",
    name: "确认组",
    color: "#8b5cf6",
    parentId: DEFAULT_CHART_LINK_GROUP_ID,
    peerPolicy: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
    receiveFromParent: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
  };
  chartWorkspaceCell(document, "cell-3").linkGroupId = "group-child";
  chartWorkspaceCell(document, "cell-4").linkGroupId = "group-child";
  return document;
}

test("parent events reach peers and descendants while child events never reach the parent", () => {
  const document = hierarchicalWorkspace();
  const fromParent = applyLinkedSessionUpdate(document, "cell-1", {
    ...chartWorkspaceCell(document, "cell-1").session,
    symbol: "ETHUSDT",
  });

  for (const cellId of ["cell-1", "cell-2", "cell-3", "cell-4"]) {
    assert.equal(chartWorkspaceCell(fromParent, cellId).session.symbol, "ETHUSDT");
  }

  const fromChild = applyLinkedSessionUpdate(fromParent, "cell-3", {
    ...chartWorkspaceCell(fromParent, "cell-3").session,
    symbol: "SOLUSDT",
  });
  assert.equal(chartWorkspaceCell(fromChild, "cell-3").session.symbol, "SOLUSDT");
  assert.equal(chartWorkspaceCell(fromChild, "cell-4").session.symbol, "SOLUSDT");
  assert.equal(chartWorkspaceCell(fromChild, "cell-1").session.symbol, "ETHUSDT");
  assert.equal(chartWorkspaceCell(fromChild, "cell-2").session.symbol, "ETHUSDT");
});

test("descendant policies compose across every parent-child edge", () => {
  const document = hierarchicalWorkspace();
  document.linkGroups["group-grandchild"] = {
    id: "group-grandchild",
    name: "执行组",
    color: "#0f9f8f",
    parentId: "group-child",
    peerPolicy: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
    receiveFromParent: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
  };
  document.linkGroups["group-child"]!.receiveFromParent.market = false;
  chartWorkspaceCell(document, "cell-4").linkGroupId = "group-grandchild";

  const targets = resolveChartLinkTargets(document, "cell-1");
  const grandchild = targets.find((target) => target.cellId === "cell-4");
  assert.equal(grandchild?.relationship, "descendant");
  assert.equal(grandchild?.policy.market, false);
  assert.equal(grandchild?.policy.crosshair, true);
});

test("drawing documents stay peer-only so child edits cannot mutate a parent scope", () => {
  const document = hierarchicalWorkspace();
  document.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.peerPolicy.drawings = true;
  document.linkGroups["group-child"]!.receiveFromParent.drawings = true;
  const targets = resolveChartLinkTargetsForChannel(document, "cell-1", "drawings");
  assert.deepEqual(targets.map((target) => target.cellId), ["cell-2"]);
});

test("indicator linking uses stable bindings and keeps target visuals and pane layout by default", () => {
  const document = hierarchicalWorkspace();
  const source: IndicatorDefinition[] = [{
    id: "sma",
    bindingId: "trend-fast",
    name: "SMA",
    params: { length: 21 },
    visible: true,
    paneTarget: "pane-2",
  }];
  chartWorkspaceCell(document, "cell-3").indicators = [{
    id: "sma-local",
    bindingId: "trend-fast",
    name: "Local SMA",
    params: { length: 7 },
    visible: false,
    paneTarget: "main",
  }];

  const next = applyLinkedIndicatorUpdate(document, "cell-1", source);
  const childIndicator = chartWorkspaceCell(next, "cell-3").indicators[0]!;
  assert.equal(childIndicator.bindingId, "trend-fast");
  assert.equal(childIndicator.params?.length, 21);
  assert.equal(childIndicator.visible, false);
  assert.equal(childIndicator.paneTarget, "main");
});

test("time-anchor and date-range settings remain mutually exclusive", () => {
  const anchor = applyChartLinkSettingsPatch(DEFAULT_CHART_LINK_GROUP_SETTINGS, {
    timeAnchor: true,
  });
  assert.equal(anchor.timeAnchor, true);
  assert.equal(anchor.dateRange, false);

  const range = applyChartLinkSettingsPatch(anchor, { dateRange: true });
  assert.equal(range.dateRange, true);
  assert.equal(range.timeAnchor, false);
});
