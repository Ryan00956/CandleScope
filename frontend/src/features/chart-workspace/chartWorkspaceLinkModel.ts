import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartLinkGroupSettings,
  ChartLinkIndicatorSettings,
  ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";
import { chartWorkspaceCell } from "./chartWorkspaceDocument.js";

export type ChartLinkChannel =
  | "market"
  | "interval"
  | "crosshair"
  | "timeAnchor"
  | "dateRange"
  | "drawings"
  | "indicators";

export type ChartLinkGroupSettingsPatch = Omit<Partial<ChartLinkGroupSettings>, "indicators"> & {
  indicators?: Partial<ChartLinkIndicatorSettings>;
};

export interface ResolvedChartLinkTarget {
  cellId: ChartCellId;
  groupId: ChartLinkGroupId;
  relationship: "peer" | "descendant";
  policy: ChartLinkGroupSettings;
}

function cloneIndicatorSettings(
  settings: ChartLinkIndicatorSettings,
): ChartLinkIndicatorSettings {
  return { ...settings };
}

export function cloneChartLinkSettings(
  settings: ChartLinkGroupSettings,
): ChartLinkGroupSettings {
  return { ...settings, indicators: cloneIndicatorSettings(settings.indicators) };
}

export function combineChartLinkSettings(
  left: ChartLinkGroupSettings,
  right: ChartLinkGroupSettings,
): ChartLinkGroupSettings {
  return {
    market: left.market && right.market,
    interval: left.interval && right.interval,
    crosshair: left.crosshair && right.crosshair,
    timeAnchor: left.timeAnchor && right.timeAnchor,
    dateRange: left.dateRange && right.dateRange,
    drawings: left.drawings && right.drawings,
    indicators: {
      definitions: left.indicators.definitions && right.indicators.definitions,
      parameters: left.indicators.parameters && right.indicators.parameters,
      visual: left.indicators.visual && right.indicators.visual,
      paneLayout: left.indicators.paneLayout && right.indicators.paneLayout,
    },
  };
}

export function chartLinkPolicyEnables(
  policy: ChartLinkGroupSettings,
  channel: ChartLinkChannel,
): boolean {
  if (channel !== "indicators") return policy[channel];
  return Object.values(policy.indicators).some(Boolean);
}

function sameSession(left: ChartSession, right: ChartSession): boolean {
  return left.exchange === right.exchange
    && left.marketType === right.marketType
    && left.symbol === right.symbol
    && left.interval === right.interval;
}

function linkedSession(
  target: ChartSession,
  source: ChartSession,
  policy: ChartLinkGroupSettings,
): ChartSession {
  return {
    exchange: policy.market ? source.exchange : target.exchange,
    marketType: policy.market ? source.marketType : target.marketType,
    symbol: policy.market ? source.symbol : target.symbol,
    interval: policy.interval ? source.interval : target.interval,
  };
}

function childGroups(
  document: ChartWorkspaceDocument,
  parentId: ChartLinkGroupId,
) {
  return Object.values(document.linkGroups)
    .filter((group) => group.parentId === parentId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/**
 * Resolve the directed link graph once for a user-originated event.
 * Peers use the source group's peer policy. Descendants compose every
 * receive-from-parent policy along the path, so no applied event needs to be
 * re-published by a target chart.
 */
export function resolveChartLinkTargets(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
): ResolvedChartLinkTarget[] {
  const sourceCell = document.cells[sourceCellId];
  const sourceGroupId = sourceCell?.linkGroupId ?? null;
  if (!sourceCell || !sourceGroupId) return [];
  const sourceGroup = document.linkGroups[sourceGroupId];
  if (!sourceGroup) return [];

  const targets: ResolvedChartLinkTarget[] = [];
  for (const cell of Object.values(document.cells)) {
    if (cell.id === sourceCellId || cell.linkGroupId !== sourceGroupId) continue;
    targets.push({
      cellId: cell.id,
      groupId: sourceGroupId,
      relationship: "peer",
      policy: cloneChartLinkSettings(sourceGroup.peerPolicy),
    });
  }

  const visited = new Set<ChartLinkGroupId>([sourceGroupId]);
  const queue = childGroups(document, sourceGroupId).map((group) => ({
    group,
    policy: cloneChartLinkSettings(group.receiveFromParent),
  }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.group.id)) continue;
    visited.add(current.group.id);
    for (const cell of Object.values(document.cells)) {
      if (cell.linkGroupId !== current.group.id) continue;
      targets.push({
        cellId: cell.id,
        groupId: current.group.id,
        relationship: "descendant",
        policy: cloneChartLinkSettings(current.policy),
      });
    }
    for (const child of childGroups(document, current.group.id)) {
      queue.push({
        group: child,
        policy: combineChartLinkSettings(current.policy, child.receiveFromParent),
      });
    }
  }
  return targets.sort((left, right) => left.cellId.localeCompare(right.cellId));
}

export function resolveChartLinkTargetsForChannel(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
  channel: ChartLinkChannel,
): ResolvedChartLinkTarget[] {
  return resolveChartLinkTargets(document, sourceCellId)
    .filter((target) => (
      // A child must never write into a parent's shared drawing document.
      // Until inherited drawings have a dedicated read-only projection,
      // drawing documents remain a same-group peer channel.
      (channel !== "drawings" || target.relationship === "peer")
      && chartLinkPolicyEnables(target.policy, channel)
    ));
}

export function applyChartLinkSettingsPatch(
  previous: ChartLinkGroupSettings,
  patch: ChartLinkGroupSettingsPatch,
): ChartLinkGroupSettings {
  const next: ChartLinkGroupSettings = {
    ...previous,
    ...patch,
    indicators: patch.indicators
      ? { ...previous.indicators, ...patch.indicators }
      : { ...previous.indicators },
  };
  // A viewport can either preserve each target's zoom around the shared right
  // edge, or reproduce the source date span. Both would issue competing writes.
  if (patch.timeAnchor === true) next.dateRange = false;
  if (patch.dateRange === true) next.timeAnchor = false;
  return next;
}

export function applyLinkedSessionUpdate(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
  session: ChartSession,
): ChartWorkspaceDocument {
  chartWorkspaceCell(document, sourceCellId);
  const policies = new Map(resolveChartLinkTargets(document, sourceCellId)
    .map((target) => [target.cellId, target.policy] as const));
  let changed = false;
  const cells = { ...document.cells };

  for (const [cellId, cell] of Object.entries(document.cells) as Array<[
    ChartCellId,
    ChartWorkspaceDocument["cells"][ChartCellId],
  ]>) {
    const policy = policies.get(cellId);
    const nextSession = cellId === sourceCellId
      ? session
      : policy ? linkedSession(cell.session, session, policy) : cell.session;
    if (sameSession(cell.session, nextSession)) continue;
    cells[cellId] = { ...cell, session: nextSession };
    changed = true;
  }

  return changed ? { ...document, cells } : document;
}

function bindingId(indicator: IndicatorDefinition): string {
  return indicator.bindingId?.trim() || `indicator:${indicator.id}`;
}

function withBinding(indicator: IndicatorDefinition): IndicatorDefinition {
  const nextBindingId = bindingId(indicator);
  return indicator.bindingId === nextBindingId
    ? structuredClone(indicator)
    : { ...structuredClone(indicator), bindingId: nextBindingId };
}

function mergeIndicatorDefinition(
  target: IndicatorDefinition | null,
  source: IndicatorDefinition,
  settings: ChartLinkIndicatorSettings,
): IndicatorDefinition {
  if (!target) return withBinding(source);
  const next = settings.definitions ? withBinding(source) : withBinding(target);
  next.bindingId = bindingId(source);
  if (settings.parameters) next.params = structuredClone(source.params ?? {});
  else if (settings.definitions) next.params = structuredClone(target.params ?? source.params ?? {});
  const copyVisual = (from: IndicatorDefinition) => {
    if (from.visible === undefined) delete next.visible;
    else next.visible = from.visible;
    if (from.lines === undefined) delete next.lines;
    else next.lines = structuredClone(from.lines);
    if (from.renderHints === undefined) delete next.renderHints;
    else next.renderHints = structuredClone(from.renderHints);
  };
  if (settings.visual) {
    copyVisual(source);
  } else if (settings.definitions) {
    copyVisual(target);
  }
  const paneTarget = settings.paneLayout
    ? source.paneTarget
    : settings.definitions ? target.paneTarget : next.paneTarget;
  if (paneTarget === undefined) delete next.paneTarget;
  else next.paneTarget = paneTarget;
  return next;
}

export function mergeLinkedIndicators(
  target: readonly IndicatorDefinition[],
  source: readonly IndicatorDefinition[],
  settings: ChartLinkIndicatorSettings,
): IndicatorDefinition[] {
  const sourceDefinitions = source.map(withBinding);
  const targetDefinitions = target.map(withBinding);
  const sourceByBinding = new Map(sourceDefinitions.map((indicator) => [bindingId(indicator), indicator]));
  const targetByBinding = new Map(targetDefinitions.map((indicator) => [bindingId(indicator), indicator]));

  if (settings.definitions) {
    return sourceDefinitions.map((indicator) => mergeIndicatorDefinition(
      targetByBinding.get(bindingId(indicator)) ?? null,
      indicator,
      settings,
    ));
  }
  return targetDefinitions.map((indicator) => {
    const linkedSource = sourceByBinding.get(bindingId(indicator));
    return linkedSource
      ? mergeIndicatorDefinition(indicator, linkedSource, settings)
      : indicator;
  });
}

export function applyLinkedIndicatorUpdate(
  document: ChartWorkspaceDocument,
  sourceCellId: ChartCellId,
  indicators: readonly IndicatorDefinition[],
): ChartWorkspaceDocument {
  const sourceCell = chartWorkspaceCell(document, sourceCellId);
  const sourceIndicators = indicators.map(withBinding);
  const targets = resolveChartLinkTargetsForChannel(document, sourceCellId, "indicators");
  const cells = {
    ...document.cells,
    [sourceCellId]: { ...sourceCell, indicators: sourceIndicators },
  };
  for (const target of targets) {
    const cell = cells[target.cellId];
    if (!cell) continue;
    cells[target.cellId] = {
      ...cell,
      indicators: mergeLinkedIndicators(cell.indicators, sourceIndicators, target.policy.indicators),
    };
  }
  return { ...document, cells };
}

export function assignCellLinkGroup(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  groupId: ChartLinkGroupId | null,
): ChartWorkspaceDocument {
  const cell = chartWorkspaceCell(document, cellId);
  const normalizedGroupId = groupId && document.linkGroups[groupId] ? groupId : null;
  if (cell.linkGroupId === normalizedGroupId) return document;
  return {
    ...document,
    cells: {
      ...document.cells,
      [cellId]: { ...cell, linkGroupId: normalizedGroupId },
    },
  };
}

export function chartLinkGroupDepth(
  document: ChartWorkspaceDocument,
  groupId: ChartLinkGroupId,
): number {
  let depth = 1;
  let current = document.linkGroups[groupId] ?? null;
  const visited = new Set<ChartLinkGroupId>();
  while (current?.parentId) {
    if (visited.has(current.id)) return Number.POSITIVE_INFINITY;
    visited.add(current.id);
    current = document.linkGroups[current.parentId] ?? null;
    depth += 1;
  }
  return depth;
}

export function isChartLinkGroupDescendant(
  document: ChartWorkspaceDocument,
  candidateId: ChartLinkGroupId,
  ancestorId: ChartLinkGroupId,
): boolean {
  let current = document.linkGroups[candidateId] ?? null;
  const visited = new Set<ChartLinkGroupId>();
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    current = document.linkGroups[current.parentId] ?? null;
  }
  return false;
}
