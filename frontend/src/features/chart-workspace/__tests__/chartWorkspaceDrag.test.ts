import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_CELL_DRAG_MIME,
  hasChartCellDragData,
  readChartCellDragData,
  writeChartCellDragData,
} from "../chartWorkspaceDrag.js";

function dataTransferFixture(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: "none",
    get types() {
      return [...values.keys()];
    },
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => { values.set(type, value); },
  };
  return transfer as unknown as DataTransfer;
}

test("chart-cell drag payload round-trips only stable cell identities", () => {
  const transfer = dataTransferFixture();
  writeChartCellDragData(transfer, "cell-3");
  assert.equal(transfer.effectAllowed, "move");
  assert.equal(hasChartCellDragData(transfer), true);
  assert.equal(transfer.getData(CHART_CELL_DRAG_MIME), "cell-3");
  assert.equal(readChartCellDragData(transfer), "cell-3");
});

test("malformed drag payloads fail closed", () => {
  const transfer = dataTransferFixture();
  transfer.setData(CHART_CELL_DRAG_MIME, "cell-99");
  assert.equal(readChartCellDragData(transfer), null);
});
