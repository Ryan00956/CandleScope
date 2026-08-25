import {
  projectResearchCapabilities,
} from "../research-data/researchDataSourceModel.js";
import type {
  ResearchCapabilitySummaryV1,
  ResearchRuntimeMode,
  ResearchSourceKind,
} from "../research-data/researchDataTypes.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "../research-data/researchDataFlags.js";
import {
  EMPTY_STRATEGY_RESEARCH_STATE,
  loadStrategyResearchWorkspace,
  persistStrategyResearchWorkspace,
  strategyResearchReducer,
  type StrategyResearchAction,
  type StrategyResearchState,
} from "./strategyResearchState.js";

export class StrategyResearchRuntime {
  state: StrategyResearchState;
  readonly libraryEnabled: boolean;
  runtimeMode: ResearchRuntimeMode;

  constructor(options: {
    libraryEnabled?: boolean;
    runtimeMode?: ResearchRuntimeMode;
    restoreWorkspace?: boolean;
  } = {}) {
    this.libraryEnabled = options.libraryEnabled ?? RESEARCH_DATA_LIBRARY_ENABLED;
    this.runtimeMode = options.runtimeMode ?? "LIVE";
    this.state = options.restoreWorkspace === false
      ? EMPTY_STRATEGY_RESEARCH_STATE
      : loadStrategyResearchWorkspace();
  }

  dispatch(action: StrategyResearchAction): StrategyResearchState {
    this.state = strategyResearchReducer(this.state, action);
    persistStrategyResearchWorkspace(this.state);
    return this.state;
  }

  capabilitiesFor(kind: ResearchSourceKind): ResearchCapabilitySummaryV1 {
    return projectResearchCapabilities({
      sourceKind: kind,
      runtimeMode: this.runtimeMode,
    });
  }

  currentChartRunnable(): boolean {
    if (this.runtimeMode === "LOCAL_OFFLINE") return false;
    return this.capabilitiesFor("CURRENT_CHART").capabilities.barApprox?.available === true;
  }
}
