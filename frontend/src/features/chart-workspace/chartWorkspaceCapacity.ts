export const MAX_CELLS_PER_WINDOW = 16;
export const MAX_WINDOWS_PER_WORKSPACE = 4;
export const MAX_CELLS_PER_APP = 64;
export const LEGACY_VISIBLE_CELLS_PER_WINDOW = 4;

export interface ChartWorkspaceFeatureFlags {
  multiChart16Enabled: boolean;
  multiWindowEnabled: boolean;
  multiChart64Enabled: boolean;
}

export interface ChartWorkspaceRuntimeLimits {
  maxCellsPerWindow: number;
  maxWindowsPerWorkspace: number;
  maxCellsPerApp: number;
}

export interface ChartWorkspaceFlagEnvironment {
  MULTI_CHART_16_ENABLED?: unknown;
  MULTI_WINDOW_ENABLED?: unknown;
  MULTI_CHART_64_ENABLED?: unknown;
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function resolveChartWorkspaceFeatureFlags(
  environment: ChartWorkspaceFlagEnvironment = {},
): ChartWorkspaceFeatureFlags {
  const multiChart16Enabled = enabled(environment.MULTI_CHART_16_ENABLED);
  const multiWindowEnabled = enabled(environment.MULTI_WINDOW_ENABLED);
  return {
    multiChart16Enabled,
    multiWindowEnabled,
    multiChart64Enabled: multiChart16Enabled
      && multiWindowEnabled
      && enabled(environment.MULTI_CHART_64_ENABLED),
  };
}

export function chartWorkspaceRuntimeLimits(
  flags: ChartWorkspaceFeatureFlags,
): ChartWorkspaceRuntimeLimits {
  const maxCellsPerWindow = flags.multiChart16Enabled
    ? MAX_CELLS_PER_WINDOW
    : LEGACY_VISIBLE_CELLS_PER_WINDOW;
  const maxWindowsPerWorkspace = flags.multiWindowEnabled
    ? MAX_WINDOWS_PER_WORKSPACE
    : 1;
  return {
    maxCellsPerWindow,
    maxWindowsPerWorkspace,
    maxCellsPerApp: flags.multiChart64Enabled
      ? MAX_CELLS_PER_APP
      : Math.min(MAX_CELLS_PER_APP, maxCellsPerWindow * maxWindowsPerWorkspace),
  };
}

function viteFlagEnvironment(): ChartWorkspaceFlagEnvironment {
  try {
    return {
      MULTI_CHART_16_ENABLED: import.meta.env?.VITE_MULTI_CHART_16_ENABLED,
      MULTI_WINDOW_ENABLED: import.meta.env?.VITE_MULTI_WINDOW_ENABLED,
      MULTI_CHART_64_ENABLED: import.meta.env?.VITE_MULTI_CHART_64_ENABLED,
    };
  } catch {
    return {};
  }
}

export const CHART_WORKSPACE_FEATURE_FLAGS = Object.freeze(
  resolveChartWorkspaceFeatureFlags(viteFlagEnvironment()),
);

export const CHART_WORKSPACE_RUNTIME_LIMITS = Object.freeze(
  chartWorkspaceRuntimeLimits(CHART_WORKSPACE_FEATURE_FLAGS),
);
