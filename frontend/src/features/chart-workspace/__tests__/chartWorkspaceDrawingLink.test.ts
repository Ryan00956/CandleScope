import assert from "node:assert/strict";
import test from "node:test";

import {
  chartCellDrawingScopeBase,
  summarizeChartDrawingLink,
} from "../chartWorkspaceDrawingLink.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import { chartWorkspaceCell } from "../chartWorkspaceDocument.js";
import { DEFAULT_CHART_LINK_GROUP_ID } from "../chartWorkspaceTypes.js";

const visibleCells = ["cell-1", "cell-2", "cell-3"] as const;

test("drawing scopes preserve independent storage until drawing linking is enabled", () => {
  const document = createDefaultChartWorkspace();
  assert.equal(
    chartCellDrawingScopeBase("workspace-default", document, "cell-1"),
    "workspace:cell-1:binance:spot:BTCUSDT",
  );
  assert.notEqual(
    chartCellDrawingScopeBase("workspace-default", document, "cell-1"),
    chartCellDrawingScopeBase("workspace-default", document, "cell-2"),
  );

  document.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.peerPolicy.drawings = true;
  assert.equal(
    chartCellDrawingScopeBase("workspace-default", document, "cell-1"),
    chartCellDrawingScopeBase("workspace-default", document, "cell-2"),
  );
});

test("linked drawings require both full market identity and the same layer set", () => {
  const document = createDefaultChartWorkspace();
  document.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.peerPolicy.drawings = true;
  assert.deepEqual(summarizeChartDrawingLink(document, "cell-1", visibleCells), {
    state: "linked",
    linkedPeerCount: 2,
    groupPeerCount: 2,
  });

  chartWorkspaceCell(document, "cell-2").drawingLayerSet = "2";
  chartWorkspaceCell(document, "cell-3").session = {
    ...chartWorkspaceCell(document, "cell-3").session,
    exchange: "okx",
  };
  assert.deepEqual(summarizeChartDrawingLink(document, "cell-1", visibleCells), {
    state: "layer-mismatch",
    linkedPeerCount: 0,
    groupPeerCount: 2,
  });
  assert.notEqual(
    chartCellDrawingScopeBase("workspace-default", document, "cell-1"),
    chartCellDrawingScopeBase("workspace-default", document, "cell-2"),
  );
  assert.notEqual(
    chartCellDrawingScopeBase("workspace-default", document, "cell-1"),
    chartCellDrawingScopeBase("workspace-default", document, "cell-3"),
  );
});
