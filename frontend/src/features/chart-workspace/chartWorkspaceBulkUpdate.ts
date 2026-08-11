import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";
import { chartWorkspaceCell } from "./chartWorkspaceDocument.js";
import type { ChartCellId, ChartWorkspaceDocument } from "./chartWorkspaceTypes.js";

export interface ChartWorkspaceCellConfiguration {
  cellId: ChartCellId;
  session: ChartSession;
  indicators: IndicatorDefinition[];
}

function sameSession(left: ChartSession, right: ChartSession): boolean {
  return left.exchange === right.exchange
    && left.marketType === right.marketType
    && left.symbol === right.symbol
    && left.interval === right.interval;
}

function sameIndicators(
  left: readonly IndicatorDefinition[],
  right: readonly IndicatorDefinition[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Applies a capacity scenario as one document mutation and one revision. */
export function configureChartWorkspaceCellsCandidate(
  document: ChartWorkspaceDocument,
  configurations: readonly ChartWorkspaceCellConfiguration[],
): ChartWorkspaceDocument {
  const seen = new Set<ChartCellId>();
  let cells = document.cells;
  for (const configuration of configurations) {
    if (seen.has(configuration.cellId)) {
      throw new TypeError(`Duplicate chart cell configuration: ${configuration.cellId}`);
    }
    seen.add(configuration.cellId);
    const cell = chartWorkspaceCell(document, configuration.cellId);
    if (cell.linkGroupId === null
      && sameSession(cell.session, configuration.session)
      && sameIndicators(cell.indicators, configuration.indicators)) continue;
    if (cells === document.cells) cells = { ...document.cells };
    cells[configuration.cellId] = {
      ...cell,
      linkGroupId: null,
      session: { ...configuration.session },
      indicators: configuration.indicators.map((indicator) => ({
        ...indicator,
        params: { ...(indicator.params || {}) },
      })),
    };
  }
  return cells === document.cells ? document : { ...document, cells };
}
