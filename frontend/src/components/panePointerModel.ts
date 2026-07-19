export interface PanePointerBoundary {
  paneId: string;
  top: number;
  bottom: number;
}

export interface PanePointerLayout {
  boundaries: readonly PanePointerBoundary[];
}

export function buildPanePointerLayout(
  paneIds: readonly string[],
  paneHeights: readonly number[],
  rootTop: number,
): PanePointerLayout | null {
  if (paneIds.length === 0
    || paneIds.length !== paneHeights.length
    || !Number.isFinite(rootTop)) {
    return null;
  }

  const boundaries: PanePointerBoundary[] = [];
  let top = rootTop;
  for (const [index, paneId] of paneIds.entries()) {
    const height = paneHeights[index];
    if (!paneId || height == null || !Number.isFinite(height) || height < 0) return null;
    const bottom = top + height;
    boundaries.push({ paneId, top, bottom });
    top = bottom;
  }
  return { boundaries };
}

export function paneIdAtClientY(
  layout: PanePointerLayout | null | undefined,
  clientY: number,
): string | null {
  if (!layout || !Number.isFinite(clientY)) return null;
  for (const [index, boundary] of layout.boundaries.entries()) {
    const isLast = index === layout.boundaries.length - 1;
    if (clientY >= boundary.top && (clientY < boundary.bottom || (isLast && clientY <= boundary.bottom))) {
      return boundary.paneId;
    }
  }
  return null;
}
