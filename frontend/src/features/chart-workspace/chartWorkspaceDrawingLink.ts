import { chartCellStorageScope } from "./chartWorkspaceLibrary.js";
import { chartWorkspaceCell } from "./chartWorkspaceDocument.js";
import type {
  ChartCellId,
  ChartWorkspaceDocument,
  ChartWorkspaceId,
} from "./chartWorkspaceTypes.js";

export type ChartDrawingLinkState =
  | "independent"
  | "disabled"
  | "waiting"
  | "market-mismatch"
  | "layer-mismatch"
  | "linked";

export interface ChartDrawingLinkSummary {
  state: ChartDrawingLinkState;
  linkedPeerCount: number;
  groupPeerCount: number;
}

function sameMarketIdentity(
  left: ChartWorkspaceDocument["cells"][ChartCellId],
  right: ChartWorkspaceDocument["cells"][ChartCellId],
): boolean {
  return left.session.exchange === right.session.exchange
    && left.session.marketType === right.session.marketType
    && left.session.symbol === right.session.symbol;
}

function scopeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

/**
 * Drawings share the engine's session store only when all safety dimensions
 * encoded in this base match. A temporary market mismatch therefore cannot
 * expose or mutate another market's layer.
 */
export function chartCellDrawingScopeBase(
  workspaceId: ChartWorkspaceId,
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
): string {
  const cell = chartWorkspaceCell(document, cellId);
  const group = cell.linkGroup;
  if (group === null || !document.linkGroups[group].drawings) {
    return [
      "workspace",
      chartCellStorageScope(workspaceId, cellId),
      cell.session.exchange,
      cell.session.marketType,
      cell.session.symbol,
    ].join(":");
  }
  return [
    "workspace-link",
    scopeSegment(workspaceId),
    group,
    `layer-${cell.drawingLayerSet}`,
    cell.session.exchange,
    cell.session.marketType,
    cell.session.symbol,
  ].join(":");
}

export function summarizeChartDrawingLink(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  candidateCellIds: readonly ChartCellId[],
): ChartDrawingLinkSummary {
  const cell = chartWorkspaceCell(document, cellId);
  const group = cell.linkGroup;
  if (group === null) {
    return { state: "independent", linkedPeerCount: 0, groupPeerCount: 0 };
  }
  if (!document.linkGroups[group].drawings) {
    return { state: "disabled", linkedPeerCount: 0, groupPeerCount: 0 };
  }
  const peers = candidateCellIds
    .filter((candidateId) => candidateId !== cellId)
    .map((candidateId) => chartWorkspaceCell(document, candidateId))
    .filter((candidate) => candidate.linkGroup === group);
  if (peers.length === 0) {
    return { state: "waiting", linkedPeerCount: 0, groupPeerCount: 0 };
  }
  const sameMarket = peers.filter((candidate) => sameMarketIdentity(cell, candidate));
  const linked = sameMarket.filter((candidate) => (
    candidate.drawingLayerSet === cell.drawingLayerSet
  ));
  if (linked.length > 0) {
    return {
      state: "linked",
      linkedPeerCount: linked.length,
      groupPeerCount: peers.length,
    };
  }
  return {
    state: sameMarket.length > 0 ? "layer-mismatch" : "market-mismatch",
    linkedPeerCount: 0,
    groupPeerCount: peers.length,
  };
}
