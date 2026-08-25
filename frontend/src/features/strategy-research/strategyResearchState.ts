import type { ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";
import { parseResearchSourceRef, ResearchDataError } from "../research-data/researchDataSourceModel.js";

export const STRATEGY_RESEARCH_WORKSPACE_KEY = "candlescope:strategy-research:v1";

export type StrategyResearchStaleReason =
  | "DATA_REVISION_CHANGED"
  | "SOURCE_CHANGED"
  | "RANGE_CHANGED"
  | "SCRIPT_CHANGED"
  | null;

export type StrategyResearchSourceSlice = {
  source: ResearchSourceRefV1 | null;
  previewFrozen: boolean;
  libraryOpen: boolean;
};

export type StrategyResearchScriptSlice = {
  draftId: string | null;
};

export type StrategyResearchResultSlice = {
  runId: string | null;
  stale: boolean;
  staleReason: StrategyResearchStaleReason;
};

export type StrategyResearchState = {
  source: StrategyResearchSourceSlice;
  script: StrategyResearchScriptSlice;
  result: StrategyResearchResultSlice;
};

export type StrategyResearchAction =
  | { type: "source/select"; source: ResearchSourceRefV1 }
  | { type: "source/clear" }
  | { type: "source/revisionChanged"; source: ResearchSourceRefV1 }
  | { type: "source/libraryOpen"; open: boolean }
  | { type: "source/frozenPreview"; frozen: boolean }
  | { type: "script/setDraft"; draftId: string | null }
  | { type: "result/setRun"; runId: string | null }
  | { type: "result/clear" };

export const EMPTY_STRATEGY_RESEARCH_STATE: StrategyResearchState = {
  source: { source: null, previewFrozen: false, libraryOpen: false },
  script: { draftId: null },
  result: { runId: null, stale: false, staleReason: null },
};

export function strategyResearchReducer(
  state: StrategyResearchState,
  action: StrategyResearchAction,
): StrategyResearchState {
  switch (action.type) {
    case "source/select":
      return {
        ...state,
        source: { ...state.source, source: action.source, previewFrozen: false },
        result: state.result.runId
          ? { ...state.result, stale: true, staleReason: "SOURCE_CHANGED" }
          : state.result,
      };
    case "source/clear":
      return {
        ...state,
        source: { ...state.source, source: null, previewFrozen: false },
      };
    case "source/revisionChanged":
      return {
        source: { ...state.source, source: action.source, previewFrozen: false },
        script: state.script,
        result: {
          ...state.result,
          stale: state.result.runId !== null,
          staleReason: state.result.runId !== null ? "DATA_REVISION_CHANGED" : null,
        },
      };
    case "source/libraryOpen":
      return { ...state, source: { ...state.source, libraryOpen: action.open } };
    case "source/frozenPreview":
      return { ...state, source: { ...state.source, previewFrozen: action.frozen } };
    case "script/setDraft":
      return {
        ...state,
        script: { draftId: action.draftId },
        result: state.result.runId
          ? { ...state.result, stale: true, staleReason: "SCRIPT_CHANGED" }
          : state.result,
      };
    case "result/setRun":
      return { ...state, result: { runId: action.runId, stale: false, staleReason: null } };
    case "result/clear":
      return { ...state, result: { runId: null, stale: false, staleReason: null } };
    default:
      return state;
  }
}

export function persistStrategyResearchWorkspace(state: StrategyResearchState): void {
  const payload = {
    schemaVersion: 1,
    source: state.source.source,
    libraryOpen: state.source.libraryOpen,
    draftId: state.script.draftId,
    runId: state.result.runId,
  };
  try {
    window.localStorage.setItem(STRATEGY_RESEARCH_WORKSPACE_KEY, JSON.stringify(payload));
  } catch {
    // Persistence is optional; in-memory state remains.
  }
}

export function loadStrategyResearchWorkspace(): StrategyResearchState {
  try {
    const raw = window.localStorage.getItem(STRATEGY_RESEARCH_WORKSPACE_KEY);
    if (raw == null) return EMPTY_STRATEGY_RESEARCH_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_STRATEGY_RESEARCH_STATE;
    }
    const record = parsed as Record<string, unknown>;
    let source: ResearchSourceRefV1 | null = null;
    if (record.source != null) {
      try {
        source = parseResearchSourceRef(record.source);
      } catch (error) {
        if (!(error instanceof ResearchDataError)) throw error;
        return EMPTY_STRATEGY_RESEARCH_STATE;
      }
    }
    return {
      source: {
        source,
        previewFrozen: false,
        libraryOpen: record.libraryOpen === true,
      },
      script: { draftId: typeof record.draftId === "string" ? record.draftId : null },
      result: {
        runId: typeof record.runId === "string" ? record.runId : null,
        stale: false,
        staleReason: null,
      },
    };
  } catch {
    return EMPTY_STRATEGY_RESEARCH_STATE;
  }
}
