import type { DrawingExportLease } from "../features/drawings/drawingInteractionController.js";

export function drawingPaneScopeKey(base: string, paneId: string): string {
  return `${base}__${paneId}`;
}

/** Resolve the one pane that owns idle drawing-tool input. */
export function resolveDrawingInteractionPaneId({
  drawingToolActive,
  hoveredPaneId,
  paneIds,
}: Readonly<{
  drawingToolActive: boolean;
  hoveredPaneId: string | null;
  paneIds: readonly string[];
}>): string | null {
  if (!drawingToolActive || paneIds.length === 0) return null;
  const availablePaneIds = new Set(paneIds);
  if (hoveredPaneId && availablePaneIds.has(hoveredPaneId)) return hoveredPaneId;
  return availablePaneIds.has("main") ? "main" : paneIds[0] ?? null;
}

/** Keep an active drawing owner stable while the pointer is outside the chart. */
export function drawingPaneIdAfterPointerLeave(
  currentPaneId: string | null,
  drawingToolActive: boolean,
): string | null {
  return drawingToolActive ? currentPaneId : null;
}

/** Route engine tools to one host; passive cursor tools have no exclusive owner. */
export function drawingToolForPane<T>(
  tool: T | null,
  interactionPaneId: string | null,
  paneId: string,
): T | null {
  if (interactionPaneId === null) return tool;
  return interactionPaneId === paneId ? tool : null;
}

/** Retain admitted hosts until their pane/scope genuinely leaves the chart surface. */
export function reconcileDrawingPaneHostMountKeys({
  admittedKeys,
  availableKeys,
  retainedKeys,
}: Readonly<{
  admittedKeys: ReadonlySet<string>;
  availableKeys: ReadonlySet<string>;
  retainedKeys: ReadonlySet<string>;
}>): ReadonlySet<string> {
  const next = new Set<string>();
  for (const key of retainedKeys) {
    if (availableKeys.has(key)) next.add(key);
  }
  for (const key of admittedKeys) {
    if (availableKeys.has(key)) next.add(key);
  }
  if (next.size === retainedKeys.size
    && [...next].every((key) => retainedKeys.has(key))) return retainedKeys;
  return next;
}

function compositeDrawingRevision(leases: readonly DrawingExportLease[]): number {
  // FNV-1a keeps the public export target within Number's safe integer range
  // while making every pane scope/revision participate in preview freshness.
  let hash = 0x811c9dc5;
  for (const lease of leases) {
    const token = `${lease.receipt.scopeKey}\u0000${lease.receipt.documentRevision}\u0001`;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash;
}

/** Present several pane-local export barriers as one chart-surface lease. */
export function composeDrawingPaneExportLeases(
  leases: readonly DrawingExportLease[],
): DrawingExportLease | null {
  if (leases.length === 0) return null;
  const first = leases[0];
  if (!first) return null;
  if (leases.length === 1) return first;

  const scopeKey = `drawing-pane-set:${leases
    .map((lease) => encodeURIComponent(lease.receipt.scopeKey))
    .join(",")}`;
  const documentRevision = compositeDrawingRevision(leases);
  let restorePromise: Promise<void> | null = null;

  return Object.freeze({
    leaseId: first.leaseId,
    receipt: Object.freeze({
      ...first.receipt,
      scopeKey,
      documentRevision,
    }),
    async revalidate(): Promise<boolean> {
      const results = await Promise.all(leases.map((lease) => lease.revalidate()));
      return results.every((result) => result === true);
    },
    restore(): Promise<void> {
      if (!restorePromise) {
        restorePromise = Promise.allSettled(leases.map((lease) => lease.restore()))
          .then((results) => {
            const failures: unknown[] = [];
            for (const result of results) {
              if (result.status === "rejected") failures.push(result.reason as unknown);
            }
            if (failures.length > 0) {
              throw new AggregateError(failures, "Failed to restore drawing pane export leases");
            }
          });
      }
      return restorePromise;
    },
  });
}
