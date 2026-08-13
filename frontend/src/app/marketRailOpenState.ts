import {
  DEFAULT_LIVE_OPEN_VIEW_IDS,
  LIVE_RAIL_VIEW_IDS,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
} from "../shared/marketRailLayout.js";
import type { StorageLike } from "../shared/browserStorage.js";

const LAYOUT_STORAGE_KEY = "candlescope-market-rail-layout-v2";
const LEGACY_LAYOUT_STORAGE_KEY = "candlescope-market-rail-layout-v1";
const LEGACY_SIDEBAR_COLLAPSED_KEY = "candlescope-sidebar-collapsed";
const LEGACY_ORDER_BOOK_COLLAPSED_KEY = "candlescope-order-book-collapsed";
const LEGACY_TRADE_FLOW_PREFS_KEY = "candlescope-trade-flow-preferences-v1";

export interface PersistedMarketRailLayout {
  readonly openViewIds: readonly string[];
  /**
   * Hides the content panel without clearing openViewIds.
   * Distinct from closing individual views (which mutates openViewIds).
   */
  readonly panelCollapsed: boolean;
  readonly viewHeights: Readonly<Record<string, number>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOpenViewIds(
  ids: readonly string[],
  knownIds?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) continue;
    if (knownIds && !knownIds.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function normalizeViewHeights(
  heights: Readonly<Record<string, number>> | null | undefined,
): Record<string, number> {
  if (!heights || typeof heights !== "object") return {};
  const next: Record<string, number> = {};
  for (const [id, value] of Object.entries(heights)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    next[id] = clamp(Math.round(value), MARKET_DOCK_MIN_HEIGHT, MARKET_DOCK_MAX_HEIGHT);
  }
  return next;
}

export function toggleOpenViewId(openViewIds: readonly string[], viewId: string): string[] {
  return openViewIds.includes(viewId)
    ? openViewIds.filter((id) => id !== viewId)
    : [...openViewIds, viewId];
}

function migrateLegacyOpenViewIds(storage: StorageLike): string[] {
  try {
    const sidebarCollapsed = storage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY) === "true";
    const orderBookCollapsed = storage.getItem(LEGACY_ORDER_BOOK_COLLAPSED_KEY) === "true";
    let dockView: string = LIVE_RAIL_VIEW_IDS.orderBook;
    const rawTrade = storage.getItem(LEGACY_TRADE_FLOW_PREFS_KEY);
    if (rawTrade) {
      const parsed: unknown = JSON.parse(rawTrade);
      if (isRecord(parsed) && typeof parsed.dockView === "string") {
        dockView = parsed.dockView;
      }
    }

    // Legacy collapse hid the entire rail (watchlist + dock).
    if (sidebarCollapsed) return [];

    const open: string[] = [LIVE_RAIL_VIEW_IDS.watchlist];
    if (!orderBookCollapsed) {
      if (dockView === "tape") open.push(LIVE_RAIL_VIEW_IDS.tape);
      else if (dockView === "profile") open.push(LIVE_RAIL_VIEW_IDS.profile);
      else open.push(LIVE_RAIL_VIEW_IDS.orderBook);
    }
    return open;
  } catch {
    return [...DEFAULT_LIVE_OPEN_VIEW_IDS];
  }
}

function parseStoredLayout(
  raw: string,
  { migrateEmptyToCollapsed = false }: { migrateEmptyToCollapsed?: boolean } = {},
): PersistedMarketRailLayout | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const storedOpenViewIds = Array.isArray(parsed.openViewIds)
      ? normalizeOpenViewIds(parsed.openViewIds.filter((id): id is string => typeof id === "string"))
      : [...DEFAULT_LIVE_OPEN_VIEW_IDS];
    const migrateCollapsedEmpty = migrateEmptyToCollapsed && storedOpenViewIds.length === 0;
    const openViewIds = migrateCollapsedEmpty
      ? [...DEFAULT_LIVE_OPEN_VIEW_IDS]
      : storedOpenViewIds;
    return {
      openViewIds,
      panelCollapsed: migrateCollapsedEmpty || parsed.panelCollapsed === true,
      viewHeights: normalizeViewHeights(
        isRecord(parsed.viewHeights)
          ? parsed.viewHeights as Record<string, number>
          : {},
      ),
    };
  } catch {
    return null;
  }
}

export function loadMarketRailLayout(
  storage?: StorageLike | null,
): PersistedMarketRailLayout {
  if (!storage) {
    return {
      openViewIds: [...DEFAULT_LIVE_OPEN_VIEW_IDS],
      panelCollapsed: false,
      viewHeights: {},
    };
  }
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const current = parseStoredLayout(raw);
      if (current) return current;
    }

    const legacyRaw = storage.getItem(LEGACY_LAYOUT_STORAGE_KEY);
    if (legacyRaw) {
      // v1 used an empty open set for whole-rail collapse. In v2 an empty set
      // means the user explicitly closed every view, so migrate v1 once.
      const migrated = parseStoredLayout(legacyRaw, { migrateEmptyToCollapsed: true });
      if (migrated) {
        saveMarketRailLayout(migrated, storage);
        return migrated;
      }
    }
  } catch {
    // fall through to legacy migration
  }

  // Legacy "sidebar collapsed" hid the whole rail; migrate to panelCollapsed
  // while restoring default open views so expand brings content back.
  const legacyCollapsed = storage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY) === "true";
  if (legacyCollapsed) {
    const openViewIds = migrateLegacyOpenViewIds({
      getItem(key: string) {
        if (key === LEGACY_SIDEBAR_COLLAPSED_KEY) return "false";
        return storage.getItem(key);
      },
      setItem: storage.setItem.bind(storage),
    });
    const migrated = {
      openViewIds: openViewIds.length > 0 ? openViewIds : [...DEFAULT_LIVE_OPEN_VIEW_IDS],
      panelCollapsed: true,
      viewHeights: {},
    };
    saveMarketRailLayout(migrated, storage);
    return migrated;
  }

  const migrated = {
    openViewIds: migrateLegacyOpenViewIds(storage),
    panelCollapsed: false,
    viewHeights: {},
  };
  saveMarketRailLayout(migrated, storage);
  return migrated;
}

export function saveMarketRailLayout(
  layout: PersistedMarketRailLayout,
  storage?: StorageLike | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      openViewIds: layout.openViewIds,
      panelCollapsed: layout.panelCollapsed === true,
      viewHeights: layout.viewHeights,
    }));
  } catch {
    // Preferences remain valid in memory when storage is unavailable or full.
  }
}
