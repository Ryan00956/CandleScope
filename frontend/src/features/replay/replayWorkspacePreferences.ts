import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_DEFAULT_WIDTH,
  MARKET_RAIL_MAX_WIDTH,
  MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
  MARKET_RAIL_MIN_WIDTH,
} from "../../shared/marketRailLayout.js";

export const REPLAY_RAIL_VIEW_IDS = {
  watchlist: "replay-watchlist",
  paper: "replay-paper",
  account: "replay-account",
  activity: "replay-activity",
  capabilities: "replay-capabilities",
} as const;

export type ReplayRailViewId = (typeof REPLAY_RAIL_VIEW_IDS)[keyof typeof REPLAY_RAIL_VIEW_IDS];

export interface ReplayWorkspacePreferences {
  readonly railWidth: number;
  readonly openViewIds: readonly ReplayRailViewId[];
  /** Hide content panel without clearing openViewIds (full restore on expand). */
  readonly panelCollapsed: boolean;
  readonly viewHeights: Readonly<Partial<Record<ReplayRailViewId, number>>>;
}

export interface ReplayPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ReplayWorkspacePreferenceActions {
  setRailWidth(value: number): void;
  toggleView(viewId: ReplayRailViewId): void;
  /** Close one view's content (does not only hide the panel). */
  closeView(viewId: ReplayRailViewId): void;
  setPanelCollapsed(collapsed: boolean): void;
  togglePanelCollapsed(): void;
  setViewHeight(viewId: ReplayRailViewId, value: number): void;
}

const LIVE_RAIL_WIDTH_KEY = "candlescope-sidebar-width";
const LIVE_RAIL_COLLAPSED_KEY = "candlescope-sidebar-collapsed";
const LIVE_DOCK_HEIGHT_KEY = "candlescope-order-book-height";
const LIVE_DOCK_COLLAPSED_KEY = "candlescope-order-book-collapsed";
const SCOPED_PREFIX = "candlescope-replay-workspace:";
const REPLAY_WORKSPACE_SCHEMA_VERSION = 2;
const REPLAY_RAIL_VIEW_ID_SET = new Set<ReplayRailViewId>(Object.values(REPLAY_RAIL_VIEW_IDS));
const REPLAY_VIEW_HEIGHT_LIMITS: Readonly<Record<ReplayRailViewId, readonly [number, number]>> = {
  [REPLAY_RAIL_VIEW_IDS.watchlist]: [MARKET_RAIL_MIN_SIDEBAR_HEIGHT, MARKET_DOCK_MAX_HEIGHT],
  [REPLAY_RAIL_VIEW_IDS.paper]: [MARKET_DOCK_MIN_HEIGHT, MARKET_DOCK_MAX_HEIGHT],
  [REPLAY_RAIL_VIEW_IDS.account]: [180, MARKET_DOCK_MAX_HEIGHT],
  [REPLAY_RAIL_VIEW_IDS.activity]: [MARKET_DOCK_MIN_HEIGHT, MARKET_DOCK_MAX_HEIGHT],
  [REPLAY_RAIL_VIEW_IDS.capabilities]: [160, MARKET_DOCK_MAX_HEIGHT],
};

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.round(parsed)))
    : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function scopedKey(sessionId: string): string {
  return `${SCOPED_PREFIX}${sessionId}`;
}

function defaultViewHeights(dockHeight: number): Record<ReplayRailViewId, number> {
  return {
    [REPLAY_RAIL_VIEW_IDS.watchlist]: MARKET_DOCK_DEFAULT_HEIGHT,
    [REPLAY_RAIL_VIEW_IDS.paper]: dockHeight,
    [REPLAY_RAIL_VIEW_IDS.account]: Math.max(dockHeight, 360),
    [REPLAY_RAIL_VIEW_IDS.activity]: dockHeight,
    [REPLAY_RAIL_VIEW_IDS.capabilities]: 280,
  };
}

function normalizeOpenViewIds(value: unknown, fallback: readonly ReplayRailViewId[]): ReplayRailViewId[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<ReplayRailViewId>();
  const open: ReplayRailViewId[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !REPLAY_RAIL_VIEW_ID_SET.has(candidate as ReplayRailViewId)) continue;
    const viewId = candidate as ReplayRailViewId;
    if (seen.has(viewId)) continue;
    seen.add(viewId);
    open.push(viewId);
  }
  return open;
}

function normalizeViewHeights(
  value: unknown,
  fallback: Readonly<Partial<Record<ReplayRailViewId, number>>>,
): Partial<Record<ReplayRailViewId, number>> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const next: Partial<Record<ReplayRailViewId, number>> = {};
  for (const viewId of Object.values(REPLAY_RAIL_VIEW_IDS)) {
    const candidate = source[viewId] ?? fallback[viewId];
    if (candidate === undefined) continue;
    const [minimum, maximum] = REPLAY_VIEW_HEIGHT_LIMITS[viewId];
    next[viewId] = clamp(candidate, minimum, minimum, maximum);
  }
  return next;
}

function legacyOpenViewIds(source: Record<string, unknown>, fallback: ReplayWorkspacePreferences): ReplayRailViewId[] {
  const open: ReplayRailViewId[] = [];
  const fallbackHasDock = fallback.openViewIds.some((id) => id !== REPLAY_RAIL_VIEW_IDS.watchlist);
  if (!bool(source.railCollapsed, !fallback.openViewIds.includes(REPLAY_RAIL_VIEW_IDS.watchlist))) {
    open.push(REPLAY_RAIL_VIEW_IDS.watchlist);
  }
  if (!bool(source.dockCollapsed, !fallbackHasDock)) {
    if (source.activeDock === "paper") open.push(REPLAY_RAIL_VIEW_IDS.paper);
    else if (source.activeDock === "activity") open.push(REPLAY_RAIL_VIEW_IDS.activity);
    else open.push(REPLAY_RAIL_VIEW_IDS.capabilities);
  }
  return open;
}

function browserStorage(): ReplayPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function inherited(storage: ReplayPreferenceStorage | null): ReplayWorkspacePreferences {
  if (storage === null) {
    return {
      railWidth: MARKET_RAIL_DEFAULT_WIDTH,
      openViewIds: [REPLAY_RAIL_VIEW_IDS.watchlist, REPLAY_RAIL_VIEW_IDS.capabilities],
      panelCollapsed: false,
      viewHeights: defaultViewHeights(MARKET_DOCK_DEFAULT_HEIGHT),
    };
  }
  const railCollapsed = bool(storage.getItem(LIVE_RAIL_COLLAPSED_KEY));
  const dockCollapsed = bool(storage.getItem(LIVE_DOCK_COLLAPSED_KEY));
  const dockHeight = clamp(
    storage.getItem(LIVE_DOCK_HEIGHT_KEY),
    MARKET_DOCK_DEFAULT_HEIGHT,
    MARKET_DOCK_MIN_HEIGHT,
    MARKET_DOCK_MAX_HEIGHT,
  );
  // Legacy live "sidebar collapsed" maps to hide-only panelCollapsed so expand
  // can restore the default open set instead of permanently clearing it.
  const openViewIds: ReplayRailViewId[] = [
    REPLAY_RAIL_VIEW_IDS.watchlist,
    ...(dockCollapsed ? [] : [REPLAY_RAIL_VIEW_IDS.capabilities]),
  ];
  return {
    railWidth: clamp(
      storage.getItem(LIVE_RAIL_WIDTH_KEY),
      MARKET_RAIL_DEFAULT_WIDTH,
      MARKET_RAIL_MIN_WIDTH,
      MARKET_RAIL_MAX_WIDTH,
    ),
    openViewIds: railCollapsed && openViewIds.length === 0
      ? [REPLAY_RAIL_VIEW_IDS.watchlist, REPLAY_RAIL_VIEW_IDS.capabilities]
      : openViewIds,
    panelCollapsed: railCollapsed,
    viewHeights: defaultViewHeights(dockHeight),
  };
}

function normalize(
  value: unknown,
  fallback: ReplayWorkspacePreferences,
  migrateLegacyEmpty = false,
): ReplayWorkspacePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  const legacyDockHeight = clamp(
    source.dockHeight,
    fallback.viewHeights[REPLAY_RAIL_VIEW_IDS.paper] ?? MARKET_DOCK_DEFAULT_HEIGHT,
    MARKET_DOCK_MIN_HEIGHT,
    MARKET_DOCK_MAX_HEIGHT,
  );
  const legacyHeights = defaultViewHeights(legacyDockHeight);
  const hasModularOpenState = Array.isArray(source.openViewIds);
  let openViewIds = hasModularOpenState
    ? normalizeOpenViewIds(source.openViewIds, fallback.openViewIds)
    : legacyOpenViewIds(source, fallback);
  const migrateCollapsedEmpty = migrateLegacyEmpty
    && hasModularOpenState
    && openViewIds.length === 0;
  if (migrateCollapsedEmpty) openViewIds = [...fallback.openViewIds];
  const panelCollapsed = migrateCollapsedEmpty
    ? openViewIds.length > 0
    : openViewIds.length === 0
      ? false
      : bool(source.panelCollapsed, fallback.panelCollapsed);
  return {
    railWidth: clamp(source.railWidth, fallback.railWidth, MARKET_RAIL_MIN_WIDTH, MARKET_RAIL_MAX_WIDTH),
    openViewIds,
    panelCollapsed,
    viewHeights: normalizeViewHeights(
      source.viewHeights,
      source.dockHeight === undefined ? fallback.viewHeights : legacyHeights,
    ),
  };
}

export function loadReplayWorkspacePreferences(
  sessionId: string,
  storage: ReplayPreferenceStorage | null = browserStorage(),
): ReplayWorkspacePreferences {
  const fallback = inherited(storage);
  if (storage === null) return fallback;
  try {
    const raw = storage.getItem(scopedKey(sessionId));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    const currentSchema = parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).schemaVersion === REPLAY_WORKSPACE_SCHEMA_VERSION;
    const normalized = normalize(parsed, fallback, !currentSchema);
    if (!currentSchema) saveReplayWorkspacePreferences(sessionId, normalized, storage);
    return normalized;
  } catch {
    return fallback;
  }
}

export function saveReplayWorkspacePreferences(
  sessionId: string,
  preferences: ReplayWorkspacePreferences,
  storage: ReplayPreferenceStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(scopedKey(sessionId), JSON.stringify({
      ...normalize(preferences, inherited(storage)),
      schemaVersion: REPLAY_WORKSPACE_SCHEMA_VERSION,
    }));
  } catch {
    // A storage failure keeps the in-memory run layout valid.
  }
}

export function clearReplayWorkspacePreferences(
  sessionIds: readonly string[],
  storage: ReplayPreferenceStorage | null = browserStorage(),
): void {
  if (storage?.removeItem === undefined) return;
  for (const sessionId of new Set(sessionIds.map((value) => value.trim()))) {
    if (!sessionId) continue;
    try {
      storage.removeItem(scopedKey(sessionId));
    } catch {
      // Archive deletion remains authoritative when browser storage is blocked.
    }
  }
}

export function useReplayWorkspacePreferences(sessionId: string): {
  readonly preferences: ReplayWorkspacePreferences;
  readonly actions: ReplayWorkspacePreferenceActions;
} {
  const [storage] = useState<ReplayPreferenceStorage | null>(browserStorage);
  const [preferences, setPreferences] = useState<ReplayWorkspacePreferences>(() => (
    loadReplayWorkspacePreferences(sessionId, storage)
  ));
  useEffect(() => {
    setPreferences(loadReplayWorkspacePreferences(sessionId, storage));
  }, [sessionId, storage]);
  const update = useCallback((patch: Partial<ReplayWorkspacePreferences>) => {
    setPreferences((current) => {
      const next = normalize({ ...current, ...patch }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    });
  }, [sessionId, storage]);
  const actions = useMemo<ReplayWorkspacePreferenceActions>(() => ({
    setRailWidth: (value) => update({ railWidth: value }),
    toggleView: (viewId) => setPreferences((current) => {
      // Hidden panel: activity click restores full selection (open missing view if needed).
      if (current.panelCollapsed) {
        const openViewIds = current.openViewIds.includes(viewId)
          ? [...current.openViewIds]
          : [...current.openViewIds, viewId];
        const next = normalize({ ...current, openViewIds, panelCollapsed: false }, current);
        saveReplayWorkspacePreferences(sessionId, next, storage);
        return next;
      }
      const openViewIds = current.openViewIds.includes(viewId)
        ? current.openViewIds.filter((id) => id !== viewId)
        : [...current.openViewIds, viewId];
      const next = normalize({
        ...current,
        openViewIds,
        panelCollapsed: openViewIds.length === 0 ? false : current.panelCollapsed,
      }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    }),
    closeView: (viewId) => setPreferences((current) => {
      if (!current.openViewIds.includes(viewId)) return current;
      const openViewIds = current.openViewIds.filter((id) => id !== viewId);
      const next = normalize({
        ...current,
        openViewIds,
        panelCollapsed: openViewIds.length === 0 ? false : current.panelCollapsed,
      }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    }),
    setPanelCollapsed: (collapsed) => setPreferences((current) => {
      const panelCollapsed = collapsed && current.openViewIds.length > 0;
      if (panelCollapsed === current.panelCollapsed) return current;
      const next = normalize({ ...current, panelCollapsed }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    }),
    togglePanelCollapsed: () => setPreferences((current) => {
      if (current.openViewIds.length === 0) {
        if (!current.panelCollapsed) return current;
        const next = normalize({ ...current, panelCollapsed: false }, current);
        saveReplayWorkspacePreferences(sessionId, next, storage);
        return next;
      }
      const next = normalize({ ...current, panelCollapsed: !current.panelCollapsed }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    }),
    setViewHeight: (viewId, value) => setPreferences((current) => {
      const next = normalize({
        ...current,
        viewHeights: { ...current.viewHeights, [viewId]: value },
      }, current);
      saveReplayWorkspacePreferences(sessionId, next, storage);
      return next;
    }),
  }), [sessionId, storage, update]);
  return { preferences, actions };
}
