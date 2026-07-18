export const COLLAPSED_PANE_HEIGHT = 36;

export type PaneMoveDirection = "up" | "down";

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function reconcilePaneOrder(
  currentOrder: readonly string[] = [],
  incomingPaneIds: readonly string[] = [],
): string[] {
  const incoming = new Set(incomingPaneIds);
  const seen = new Set<string>();
  const next = currentOrder.filter((paneId) => {
    if (!incoming.has(paneId) || seen.has(paneId)) return false;
    seen.add(paneId);
    return true;
  });
  for (const paneId of incomingPaneIds) {
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    next.push(paneId);
  }
  return sameStringArray(currentOrder, next) ? [...currentOrder] : next;
}

export function movePaneInOrder(
  currentOrder: readonly string[],
  paneId: string,
  direction: PaneMoveDirection,
): string[] {
  const index = currentOrder.indexOf(paneId);
  if (index < 0) return [...currentOrder];
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= currentOrder.length) return [...currentOrder];
  const next = [...currentOrder];
  const target = next[targetIndex];
  if (target === undefined) return next;
  next[targetIndex] = paneId;
  next[index] = target;
  return next;
}

function positiveHeight(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export interface PaneHeightPlanOptions {
  paneIds: readonly string[];
  currentHeights: readonly number[];
  expandedHeights?: ReadonlyMap<string, number> | null;
  collapsedPaneIds?: readonly string[];
  maximizedPaneId?: string | null;
  collapsedHeight?: number;
}

/**
 * Builds deterministic pane stretch weights for collapsed/maximized layouts.
 * The weights sum to the currently materialized pane height, so LWC can apply
 * them without introducing cumulative setHeight redistribution drift.
 */
export function buildPaneHeightPlan({
  paneIds,
  currentHeights,
  expandedHeights = null,
  collapsedPaneIds = [],
  maximizedPaneId = null,
  collapsedHeight = COLLAPSED_PANE_HEIGHT,
}: PaneHeightPlanOptions): number[] | null {
  if (paneIds.length === 0 || currentHeights.length !== paneIds.length) return null;
  const minimum = positiveHeight(collapsedHeight, COLLAPSED_PANE_HEIGHT);
  const normalizedCurrent = currentHeights.map((height) => positiveHeight(height, minimum));
  const totalHeight = normalizedCurrent.reduce((sum, height) => sum + height, 0);
  const maximizedIndex = maximizedPaneId ? paneIds.indexOf(maximizedPaneId) : -1;

  if (maximizedIndex >= 0 && paneIds.length > 1) {
    const dominantHeight = Math.max(minimum, totalHeight - minimum * (paneIds.length - 1));
    return paneIds.map((_paneId, index) => index === maximizedIndex ? dominantHeight : minimum);
  }

  const collapsed = new Set(collapsedPaneIds.filter((paneId) => paneIds.includes(paneId)));
  if (collapsed.size === 0) return null;

  // A chart cannot meaningfully collapse every pane. Keep the main pane (or
  // the first pane when used outside this chart)
  // expanded if a stale external state ever requests that impossible layout.
  if (collapsed.size === paneIds.length) {
    collapsed.delete(paneIds.includes("main") ? "main" : paneIds[0]!);
  }
  const expandedIds = paneIds.filter((paneId) => !collapsed.has(paneId));
  const fixedHeight = minimum * collapsed.size;
  const expandedBudget = Math.max(minimum * expandedIds.length, totalHeight - fixedHeight);
  const expandedWeights = expandedIds.map((paneId) => positiveHeight(
    expandedHeights?.get(paneId),
    normalizedCurrent[paneIds.indexOf(paneId)] ?? minimum,
  ));
  const weightTotal = expandedWeights.reduce((sum, height) => sum + height, 0) || expandedIds.length;
  const weightById = new Map(expandedIds.map((paneId, index) => [
    paneId,
    expandedWeights[index] ?? minimum,
  ]));

  return paneIds.map((paneId) => {
    if (collapsed.has(paneId)) return minimum;
    return expandedBudget * ((weightById.get(paneId) ?? minimum) / weightTotal);
  });
}
