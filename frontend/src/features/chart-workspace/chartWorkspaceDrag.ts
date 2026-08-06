import {
  CHART_CELL_IDS,
  type ChartCellId,
} from "./chartWorkspaceTypes.js";

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
  return CHART_CELL_IDS.includes(value as ChartCellId)
    ? value as ChartCellId
    : null;
}

export function hasChartCellDragData(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(CHART_CELL_DRAG_MIME);
}
