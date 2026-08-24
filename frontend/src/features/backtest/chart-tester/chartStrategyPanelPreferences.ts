export type ChartStrategyPanelTab = "script" | "overview" | "trades" | "settings";

export interface ChartStrategyPanelPreferences {
  height: number;
  activeTab: ChartStrategyPanelTab;
}

export const CHART_STRATEGY_MIN_PANEL_HEIGHT = 260;
export const CHART_STRATEGY_MAX_PANEL_HEIGHT = 520;

function panelPreferenceKey(cellScope: string): string {
  return `candlescope.chart-strategy-panel.v1.${encodeURIComponent(cellScope)}`;
}

export function clampChartStrategyPanelHeight(value: number): number {
  const viewportLimit = typeof window === "undefined"
    ? CHART_STRATEGY_MAX_PANEL_HEIGHT
    : Math.max(CHART_STRATEGY_MIN_PANEL_HEIGHT, Math.floor(window.innerHeight * 0.68));
  return Math.min(
    CHART_STRATEGY_MAX_PANEL_HEIGHT,
    viewportLimit,
    Math.max(CHART_STRATEGY_MIN_PANEL_HEIGHT, Math.round(value)),
  );
}

export function loadChartStrategyPanelPreferences(
  cellScope: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): ChartStrategyPanelPreferences {
  const fallback: ChartStrategyPanelPreferences = {
    height: clampChartStrategyPanelHeight(383),
    activeTab: "script",
  };
  if (!storage) return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(panelPreferenceKey(cellScope)) ?? "null") as Partial<ChartStrategyPanelPreferences> | null;
    const tab = parsed?.activeTab;
    return {
      height: clampChartStrategyPanelHeight(Number(parsed?.height ?? fallback.height)),
      activeTab: tab === "script" || tab === "overview" || tab === "trades" || tab === "settings"
        ? tab
        : fallback.activeTab,
    };
  } catch {
    return fallback;
  }
}

export function saveChartStrategyPanelPreferences(
  cellScope: string,
  preferences: ChartStrategyPanelPreferences,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(panelPreferenceKey(cellScope), JSON.stringify({
      height: clampChartStrategyPanelHeight(preferences.height),
      activeTab: preferences.activeTab,
    }));
  } catch {
    // Preference storage is best-effort and must not block a Run or its result.
  }
}
