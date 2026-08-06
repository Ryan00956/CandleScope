import type { ChartCellId, ChartWindowId } from "./chartWorkspaceTypes.js";

const CHART_CELL_ID_PATTERN = /^cell-[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/;
const CHART_WINDOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isChartCellId(value: unknown): value is ChartCellId {
  return typeof value === "string" && CHART_CELL_ID_PATTERN.test(value);
}

export function isChartWindowId(value: unknown): value is ChartWindowId {
  return typeof value === "string" && CHART_WINDOW_ID_PATTERN.test(value);
}

export function normalizeChartCellId(value: unknown): ChartCellId | null {
  return isChartCellId(value) ? value : null;
}

export function normalizeChartWindowId(value: unknown): ChartWindowId | null {
  return isChartWindowId(value) ? value : null;
}

function randomIdentityStem(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // The local fallback remains opaque and collision checked by the caller.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createChartCellId(
  occupied: ReadonlySet<ChartCellId> = new Set(),
  createStem: () => string = randomIdentityStem,
): ChartCellId | null {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const stem = createStem().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 91);
    const candidate = `cell-${stem}`;
    if (isChartCellId(candidate) && !occupied.has(candidate)) return candidate;
  }
  return null;
}
