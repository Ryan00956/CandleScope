import type { PaneHeights } from "./chartSessionTypes.js";

const PANE_HEIGHTS_KEY = "candlescope-pane-heights";
const PANE_ORDER_KEY = "candlescope-pane-order-v1";

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

function normalizePaneOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const paneId of value.slice(0, 100)) {
    if (typeof paneId !== "string" || paneId.length === 0 || paneId.length > 200 || seen.has(paneId)) {
      continue;
    }
    seen.add(paneId);
    normalized.push(paneId);
  }
  return normalized;
}

export function loadPaneOrder(): string[] {
  try {
    const raw = localStorage.getItem(PANE_ORDER_KEY);
    return raw ? normalizePaneOrder(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function savePaneOrder(order: unknown): void {
  localStorage.setItem(PANE_ORDER_KEY, JSON.stringify(normalizePaneOrder(order)));
}
