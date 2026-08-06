import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartLinkGroupSettings,
  ChartLinkRole,
  ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";
import { chartWorkspaceCell } from "./chartWorkspaceDocument.js";

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

export function canPublishChartLinks(role: ChartLinkRole): boolean {
  return role !== "destination";
}

export function canReceiveChartLinks(role: ChartLinkRole): boolean {
  return role !== "source";
}

export function preferredChartLinkPublisher(
  document: ChartWorkspaceDocument,
  group: ChartLinkGroupId,
  excludeCellId: ChartCellId | null = null,
): ChartWorkspaceDocument["cells"][ChartCellId] | null {
  const candidates = Object.values(document.cells).filter((cell) => (
    cell.id !== excludeCellId
    && cell.linkGroup === group
    && canPublishChartLinks(cell.linkRole)
  ));
  return candidates.find((cell) => cell.linkRole === "source")
    ?? candidates.find((cell) => cell.linkRole === "bidirectional")
    ?? null;
}

export function applyChartLinkSettingsPatch(
  previous: ChartLinkGroupSettings,
  patch: Partial<ChartLinkGroupSettings>,
): ChartLinkGroupSettings {
  const next = { ...previous, ...patch };
  // A viewport can either preserve each target's zoom around the shared right
  // edge, or reproduce the source date span. Applying both would issue two
  // competing imperative writes for every scroll gesture.
  if (patch.timeAnchor === true) next.dateRange = false;
  if (patch.dateRange === true) next.timeAnchor = false;
  return next;
}

export function applyLinkedSessionUpdate(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
  session: ChartSession,
): ChartWorkspaceDocument {
  const sourceCell = chartWorkspaceCell(document, sourceCellId);
  const group = sourceCell.linkGroup;
  const publish = group !== null && canPublishChartLinks(sourceCell.linkRole);
  let changed = false;
  const cells = { ...document.cells };

  for (const [cellId, cell] of Object.entries(document.cells) as Array<[
    ChartCellId,
    ChartWorkspaceDocument["cells"][ChartCellId],
  ]>) {
    const nextSession = cellId === sourceCellId
      ? session
      : publish && cell.linkGroup === group && canReceiveChartLinks(cell.linkRole)
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
  const cell = chartWorkspaceCell(document, cellId);
  if (cell.linkGroup === group) return document;
  const anchor = group === null
    ? null
    : preferredChartLinkPublisher(document, group, cellId);
  const session = anchor && group && canReceiveChartLinks(cell.linkRole)
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

export function assignCellLinkRole(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  role: ChartLinkRole,
): ChartWorkspaceDocument {
  const cell = chartWorkspaceCell(document, cellId);
  if (cell.linkRole === role) return document;
  let next: ChartWorkspaceDocument = {
    ...document,
    cells: {
      ...document.cells,
      [cellId]: { ...cell, linkRole: role },
    },
  };
  if (cell.linkGroup === null || !canReceiveChartLinks(role)) return next;
  const anchor = preferredChartLinkPublisher(next, cell.linkGroup, cellId);
  if (anchor) next = applyLinkedSessionUpdate(next, anchor.id, anchor.session);
  return next;
}
