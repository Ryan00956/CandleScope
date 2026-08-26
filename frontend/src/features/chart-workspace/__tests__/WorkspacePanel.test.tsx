import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createDefaultChartWorkspaceRecord } from "../chartWorkspaceLibrary.js";
import WorkspacePanel from "../WorkspacePanel.js";
import type { ChartWorkspaceRuntime } from "../useChartWorkspaceRuntime.js";

function createRuntime(): ChartWorkspaceRuntime {
  const record = createDefaultChartWorkspaceRecord(100);
  const document = record.document;
  const activeWindow = document.windows[document.activeWindowId]!;
  const activeCell = document.cells[activeWindow.activeCellId]!;
  activeCell.linkGroupId = null;

  return {
    view: {
      document,
      window: activeWindow,
      activeWorkspaceId: record.id,
      activeWorkspaceName: record.name,
      runtimeKey: "workspace-default:1",
      workspaces: [{
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        layout: "single",
      }],
      layout: "single",
      activeCellId: activeCell.id,
      activeCell,
      layoutCellIds: [activeCell.id],
      visibleCellIds: [activeCell.id],
      maxCellsPerWindow: 16,
      multiChart16Enabled: true,
      layoutLocked: false,
      canUndoLayout: false,
      canRedoLayout: false,
      ready: true,
    },
    actions: {
      switchWorkspace: () => undefined,
      createWorkspace: () => undefined,
      duplicateWorkspace: () => undefined,
      renameWorkspace: () => undefined,
      deleteWorkspace: () => undefined,
      setLayout: () => undefined,
      splitCell: () => undefined,
      closeCell: () => undefined,
      swapCells: () => undefined,
      resetLayout: () => undefined,
      setLayoutLocked: () => undefined,
      undoLayout: () => undefined,
      redoLayout: () => undefined,
      setActiveCell: () => undefined,
      toggleMaximize: () => undefined,
      setCellLinkGroup: () => undefined,
      createLinkGroup: () => undefined,
      updateLinkGroup: () => undefined,
      deleteLinkGroup: () => undefined,
      setCellDrawingLayerSet: () => undefined,
      updateLinkGroupPolicy: () => undefined,
      setLayoutRatio: () => undefined,
      updateCellSession: () => undefined,
      updateCellChartSettings: () => undefined,
      updateCellPriceScale: () => undefined,
      updateCellIndicators: () => undefined,
      updateCellStrategyAttachment: () => undefined,
      configureCells: () => undefined,
      createWindow: () => undefined,
      closeWindow: () => undefined,
      updateWindowPlacement: () => undefined,
    },
    status: {
      saveState: "saved",
      persistenceMode: "indexeddb",
      lastSavedAt: 100,
      error: null,
    },
  };
}

test("workspace panel stays absent while closed", () => {
  const html = renderToStaticMarkup(
    <WorkspacePanel
      isOpen={false}
      onClose={() => undefined}
      runtime={createRuntime()}
      desktop={{ mode: "web", multiWindowEnabled: false, displayCount: 1, error: null }}
      viewportIssue={null}
    />,
  );
  assert.equal(html, "");
});

test("workspace panel exposes workspace management in a dedicated dialog", () => {
  const html = renderToStaticMarkup(
    <WorkspacePanel
      isOpen
      onClose={() => undefined}
      runtime={createRuntime()}
      desktop={{ mode: "web", multiWindowEnabled: false, displayCount: 1, error: null }}
      viewportIssue={null}
    />,
  );

  assert.match(html, /class="workspace-panel-overlay/);
  assert.match(html, /class="right-drawer-resize-handle"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="图表工作区管理"/);
  assert.match(html, /图表工作区/);
  assert.match(html, /工作区/);
  assert.match(html, /布局与窗口/);
  assert.match(html, /联动/);
  assert.match(html, /已保存工作区/);
  assert.match(html, /新建工作区/);
  assert.match(html, /本地数据库自动保存/);
  assert.match(html, /data-save-state="saved"/);
});
