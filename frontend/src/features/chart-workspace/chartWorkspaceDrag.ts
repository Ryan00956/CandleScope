import type { ChartCellId } from "./chartWorkspaceTypes.js";
import { isChartCellId } from "./chartWorkspaceIdentity.js";

export const CHART_CELL_DRAG_MIME = "application/x-candlescope-chart-cell";

export function writeChartCellDragData(
  transfer: DataTransfer,
  cellId: ChartCellId,
): void {
  transfer.effectAllowed = "move";
  transfer.setData(CHART_CELL_DRAG_MIME, cellId);
  transfer.setData("text/plain", cellId);
}

export function readChartCellDragData(transfer: DataTransfer): ChartCellId | null {
  const value = transfer.getData(CHART_CELL_DRAG_MIME).trim();
  return isChartCellId(value) ? value : null;
}

export function hasChartCellDragData(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(CHART_CELL_DRAG_MIME);
}
