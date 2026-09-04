import { chartCellStorageScope } from "./chartWorkspaceLibrary.js";
import { chartWorkspaceCell } from "./chartWorkspaceDocument.js";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type {
  ChartCellId,
  ChartCellState,
  ChartLinkGroup,
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
export function chartCellDrawingScopeBaseFromCell(
  workspaceId: ChartWorkspaceId,
  cell: ChartCellState,
  group: ChartLinkGroup | null,
  session: ChartSession,
): string {
  if (!group || !group.peerPolicy.drawings) {
    const parts = [
      "workspace",
      chartCellStorageScope(workspaceId, cell.id),
      session.exchange,
      session.marketType,
      session.symbol,
    ];
    // Keep the original default-layer scope readable while making alternate
    // layers genuinely independent for unlinked cells as well.
    if (cell.drawingLayerSet !== "1") parts.push(`layer-${cell.drawingLayerSet}`);
    return parts.join(":");
  }
  return [
    "workspace-link",
    scopeSegment(workspaceId),
    cell.linkGroupId,
    `layer-${cell.drawingLayerSet}`,
    session.exchange,
    session.marketType,
    session.symbol,
  ].join(":");
}

export function chartCellDrawingScopeBase(
  workspaceId: ChartWorkspaceId,
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  session?: ChartSession,
): string {
  const cell = chartWorkspaceCell(document, cellId);
  const groupId = cell.linkGroupId;
  const group = groupId === null ? null : document.linkGroups[groupId] ?? null;
  return chartCellDrawingScopeBaseFromCell(
    workspaceId,
    cell,
    group,
    session ?? cell.session,
  );
}

export function summarizeChartDrawingLink(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  candidateCellIds: readonly ChartCellId[],
): ChartDrawingLinkSummary {
  const cell = chartWorkspaceCell(document, cellId);
  const groupId = cell.linkGroupId;
  const group = groupId === null ? null : document.linkGroups[groupId];
  if (!group) {
    return { state: "independent", linkedPeerCount: 0, groupPeerCount: 0 };
  }
  if (!group.peerPolicy.drawings) {
    return { state: "disabled", linkedPeerCount: 0, groupPeerCount: 0 };
  }
  const peers = candidateCellIds
    .filter((candidateId) => candidateId !== cellId)
    .map((candidateId) => chartWorkspaceCell(document, candidateId))
    .filter((candidate) => candidate.linkGroupId === groupId);
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
