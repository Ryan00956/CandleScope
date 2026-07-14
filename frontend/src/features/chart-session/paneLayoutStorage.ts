import type { PaneHeights } from "./chartSessionTypes.js";

const PANE_HEIGHTS_KEY = "candlescope-pane-heights";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizePaneHeights(value: unknown): PaneHeights {
  if (!isRecord(value)) return {};
  const normalized: PaneHeights = {};
  for (const [key, heights] of Object.entries(value)) {
    if (!Array.isArray(heights) || heights.length === 0) continue;
    const candidates: unknown[] = heights;
    if (!candidates.every(isPositiveFiniteNumber)) continue;
    normalized[key] = [...candidates];
  }
  return normalized;
}

export function buildPaneConfigKey(subPaneIds: readonly string[]): string {
  return [...subPaneIds].sort().join(",");
}

export function loadPaneHeights(): PaneHeights {
  try {
    const raw = localStorage.getItem(PANE_HEIGHTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return normalizePaneHeights(parsed);
  } catch {
    return {};
  }
}

export function savePaneHeights(heights: unknown): void {
  localStorage.setItem(PANE_HEIGHTS_KEY, JSON.stringify(normalizePaneHeights(heights)));
}
