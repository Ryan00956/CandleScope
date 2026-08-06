import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";

function sameSession(left: ChartSession, right: ChartSession): boolean {
  return left.exchange === right.exchange
    && left.marketType === right.marketType
    && left.symbol === right.symbol
    && left.interval === right.interval;
}

function linkedSession(
  target: ChartSession,
  source: ChartSession,
  document: ChartWorkspaceDocument,
  group: ChartLinkGroupId,
): ChartSession {
  const settings = document.linkGroups[group];
  return {
    exchange: settings.market ? source.exchange : target.exchange,
    marketType: settings.market ? source.marketType : target.marketType,
    symbol: settings.market ? source.symbol : target.symbol,
    interval: settings.interval ? source.interval : target.interval,
  };
}

export function applyLinkedSessionUpdate(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
  session: ChartSession,
): ChartWorkspaceDocument {
  const sourceCell = document.cells[sourceCellId];
  const group = sourceCell.linkGroup;
  let changed = false;
  const cells = { ...document.cells };

  for (const [cellId, cell] of Object.entries(document.cells) as Array<[
    ChartCellId,
    ChartWorkspaceDocument["cells"][ChartCellId],
  ]>) {
    const nextSession = cellId === sourceCellId
      ? session
      : group !== null && cell.linkGroup === group
        ? linkedSession(cell.session, session, document, group)
        : cell.session;
    if (sameSession(cell.session, nextSession)) continue;
    cells[cellId] = { ...cell, session: nextSession };
    changed = true;
  }

  return changed ? { ...document, cells } : document;
}

export function assignCellLinkGroup(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  group: ChartLinkGroupId | null,
): ChartWorkspaceDocument {
  const cell = document.cells[cellId];
  if (cell.linkGroup === group) return document;
  const anchor = group === null
    ? null
    : Object.values(document.cells).find((candidate) => (
        candidate.id !== cellId && candidate.linkGroup === group
      )) ?? null;
  const session = anchor && group
    ? linkedSession(cell.session, anchor.session, document, group)
    : cell.session;
  return {
    ...document,
    cells: {
      ...document.cells,
      [cellId]: { ...cell, linkGroup: group, session },
    },
  };
}
