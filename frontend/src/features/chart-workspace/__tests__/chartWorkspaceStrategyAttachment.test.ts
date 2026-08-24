import assert from "node:assert/strict";
import test from "node:test";

import {
  chartWorkspaceCell,
  updateChartWorkspaceCellStrategyAttachment,
} from "../chartWorkspaceDocument.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import type { ChartStrategyAttachmentRecord } from "../chartWorkspaceTypes.js";

const createAttachment = (): ChartStrategyAttachmentRecord => ({
  schemaVersion: 1,
  strategyDraftId: "draft-12345678",
  strategyRevisionId: null,
  displayName: "SMA Cross",
  language: "pyne",
  parameters: { fast: 3, slow: 5 },
  rangeMode: "ALL_AVAILABLE",
  customRange: null,
  fidelityPreference: "FAST",
  quickPresetId: "CRYPTO_PERP_STANDARD_V1",
  autoRun: false,
});

test("strategy attachment updates only the requested cell and clones nested parameters", () => {
  const attachment = createAttachment();
  const document = createDefaultChartWorkspace();
  const updated = updateChartWorkspaceCellStrategyAttachment(document, "cell-2", attachment);

  assert.equal(chartWorkspaceCell(updated, "cell-1").strategyAttachment, null);
  assert.deepEqual(chartWorkspaceCell(updated, "cell-2").strategyAttachment, attachment);
  assert.notEqual(chartWorkspaceCell(updated, "cell-2").strategyAttachment, attachment);
  assert.notEqual(chartWorkspaceCell(updated, "cell-2").strategyAttachment?.parameters, attachment.parameters);

  (attachment.parameters as { fast: number }).fast = 99;
  assert.equal(chartWorkspaceCell(updated, "cell-2").strategyAttachment?.parameters.fast, 3);
});

test("unchanged attachment preserves document identity and detach remains cell-local", () => {
  const attachment = createAttachment();
  const document = createDefaultChartWorkspace();
  const attached = updateChartWorkspaceCellStrategyAttachment(document, "cell-1", attachment);
  assert.equal(
    updateChartWorkspaceCellStrategyAttachment(attached, "cell-1", chartWorkspaceCell(attached, "cell-1").strategyAttachment),
    attached,
  );
  const detached = updateChartWorkspaceCellStrategyAttachment(attached, "cell-1", null);
  assert.equal(chartWorkspaceCell(detached, "cell-1").strategyAttachment, null);
  assert.equal(chartWorkspaceCell(detached, "cell-2").strategyAttachment, null);
});
