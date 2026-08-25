export interface ResearchDataLibraryFlagEnvironment {
  VITE_RESEARCH_DATA_LIBRARY_ENABLED?: unknown;
}

export function resolveResearchDataLibraryEnabled(
  environment: ResearchDataLibraryFlagEnvironment = {},
): boolean {
  const raw = environment.VITE_RESEARCH_DATA_LIBRARY_ENABLED;
  if (raw === undefined) {
    return true;
  }
  return raw === true || raw === 1 || raw === "1";
}

function viteEnvironment(): ResearchDataLibraryFlagEnvironment {
  try {
    return {
      VITE_RESEARCH_DATA_LIBRARY_ENABLED: import.meta.env?.VITE_RESEARCH_DATA_LIBRARY_ENABLED,
    };
  } catch {
    return {};
  }
}

export const RESEARCH_DATA_LIBRARY_ENABLED = resolveResearchDataLibraryEnabled(viteEnvironment());
