import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_DEFAULT_WIDTH,
  MARKET_RAIL_MAX_WIDTH,
  MARKET_RAIL_MIN_WIDTH,
} from "../../shared/marketRailLayout.js";


export type ReplayDockView = "capabilities" | "paper" | "activity";

export interface ReplayWorkspacePreferences {
  readonly railWidth: number;
  readonly railCollapsed: boolean;
  readonly dockHeight: number;
  readonly dockCollapsed: boolean;
  readonly activeDock: ReplayDockView;
}

export interface ReplayPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ReplayWorkspacePreferenceActions {
  setRailWidth(value: number): void;
  setRailCollapsed(value: boolean): void;
  setDockHeight(value: number): void;
  setDockCollapsed(value: boolean): void;
  setActiveDock(value: ReplayDockView): void;
}

const LIVE_RAIL_WIDTH_KEY = "candlescope-sidebar-width";
const LIVE_RAIL_COLLAPSED_KEY = "candlescope-sidebar-collapsed";
const LIVE_DOCK_HEIGHT_KEY = "candlescope-order-book-height";
const LIVE_DOCK_COLLAPSED_KEY = "candlescope-order-book-collapsed";
const SCOPED_PREFIX = "candlescope-replay-workspace:";
const DOCKS = new Set<ReplayDockView>(["capabilities", "paper", "activity"]);

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
      railCollapsed: false,
      dockHeight: MARKET_DOCK_DEFAULT_HEIGHT,
      dockCollapsed: false,
      activeDock: "capabilities",
    };
  }
  return {
    railWidth: clamp(
      storage.getItem(LIVE_RAIL_WIDTH_KEY),
      MARKET_RAIL_DEFAULT_WIDTH,
      MARKET_RAIL_MIN_WIDTH,
      MARKET_RAIL_MAX_WIDTH,
    ),
    railCollapsed: bool(storage.getItem(LIVE_RAIL_COLLAPSED_KEY)),
    dockHeight: clamp(
      storage.getItem(LIVE_DOCK_HEIGHT_KEY),
      MARKET_DOCK_DEFAULT_HEIGHT,
      MARKET_DOCK_MIN_HEIGHT,
      MARKET_DOCK_MAX_HEIGHT,
    ),
    dockCollapsed: bool(storage.getItem(LIVE_DOCK_COLLAPSED_KEY)),
    activeDock: "capabilities",
  };
}

function normalize(value: unknown, fallback: ReplayWorkspacePreferences): ReplayWorkspacePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  const activeDock = typeof source.activeDock === "string" && DOCKS.has(source.activeDock as ReplayDockView)
    ? source.activeDock as ReplayDockView
    : fallback.activeDock;
  return {
    railWidth: clamp(source.railWidth, fallback.railWidth, MARKET_RAIL_MIN_WIDTH, MARKET_RAIL_MAX_WIDTH),
    railCollapsed: bool(source.railCollapsed, fallback.railCollapsed),
    dockHeight: clamp(source.dockHeight, fallback.dockHeight, MARKET_DOCK_MIN_HEIGHT, MARKET_DOCK_MAX_HEIGHT),
    dockCollapsed: bool(source.dockCollapsed, fallback.dockCollapsed),
    activeDock,
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
    return raw === null ? fallback : normalize(JSON.parse(raw), fallback);
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
    storage.setItem(scopedKey(sessionId), JSON.stringify(normalize(preferences, inherited(storage))));
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
    setRailCollapsed: (value) => update({ railCollapsed: value }),
    setDockHeight: (value) => update({ dockHeight: value }),
    setDockCollapsed: (value) => update({ dockCollapsed: value }),
    setActiveDock: (value) => update({ activeDock: value }),
  }), [update]);
  return { preferences, actions };
}
