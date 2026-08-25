import { Component, useCallback, useMemo, useReducer, useRef, type ErrorInfo, type ReactNode } from "react";

import { t } from "../../i18n/index.js";
import { ResearchDataDrawer } from "../research-data/ResearchDataDrawer.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "../research-data/researchDataFlags.js";
import type { ResearchSourceKind } from "../research-data/researchDataTypes.js";
import { useChartSettingsRuntime } from "../settings/chartAppearanceSettings.js";
import { StrategyResearchRuntime } from "./StrategyResearchRuntime.js";
import { StrategyResearchShell } from "./StrategyResearchShell.js";
import {
  parseStrategyResearchLaunch,
  strategyResearchLaunchActions,
  strategyResearchVisualState,
  type StrategyResearchLaunchIntent,
} from "./strategyResearchLaunch.js";
import type { StrategyResearchState } from "./strategyResearchState.js";

class StrategyResearchDrawerBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Strategy research data drawer failed", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function currentChartSource() {
  return {
    schemaVersion: "candlescope.research-source/1" as const,
    kind: "CURRENT_CHART" as const,
    workspaceId: "current",
    cellId: "current",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };
}

export default function StrategyResearchApp({
  intent,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
}: {
  intent: StrategyResearchLaunchIntent;
  libraryEnabled?: boolean;
}) {
  const { settings } = useChartSettingsRuntime();
  const runtimeRef = useRef<StrategyResearchRuntime | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = new StrategyResearchRuntime({
      libraryEnabled,
      restoreWorkspace: intent.kind === "restore",
    });
    for (const action of strategyResearchLaunchActions(intent)) {
      runtimeRef.current.dispatch(action);
    }
  }
  const runtime = runtimeRef.current;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const state: StrategyResearchState = runtime.state;
  const visualState = strategyResearchVisualState(intent, state);
  const dispatch = useCallback((action: Parameters<StrategyResearchRuntime["dispatch"]>[0]) => {
    runtime.dispatch(action);
    bump();
  }, [runtime]);

  const onSelectKind = useCallback((kind: ResearchSourceKind) => {
    if (kind === "CURRENT_CHART") {
      dispatch({ type: "source/select", source: currentChartSource() });
      return;
    }
    dispatch({ type: "source/libraryOpen", open: true });
  }, [dispatch]);

  const capabilities = useMemo(
    () => (state.source.source ? runtime.capabilitiesFor(state.source.source.kind) : runtime.capabilitiesFor("IMPORTED_DATASET")),
    [runtime, state.source.source],
  );

  const scriptDraft = state.script.draftId;

  return (
    <StrategyResearchShell
      visualState={visualState}
      source={state.source.source}
      libraryEnabled={runtime.libraryEnabled}
      libraryOpen={state.source.libraryOpen}
      onOpenLibrary={() => dispatch({ type: "source/libraryOpen", open: true })}
      drawer={(
        <StrategyResearchDrawerBoundary
          fallback={<p className="strategy-research-error" role="alert">{t("strategy.drawerFailed")}</p>}
        >
          <ResearchDataDrawer
            open={state.source.libraryOpen}
            runtimeMode={runtime.runtimeMode}
            capabilities={capabilities}
            libraryEnabled={runtime.libraryEnabled}
            settings={settings}
            events={[]}
            onSelectKind={onSelectKind}
            onClose={() => dispatch({ type: "source/libraryOpen", open: false })}
          />
        </StrategyResearchDrawerBoundary>
      )}
      chart={<p>{t("strategy.chartSlot")}</p>}
      script={<p data-strategy-draft={scriptDraft ?? ""}>{t("strategy.scriptSlot")}</p>}
      result={<p>{state.result.runId ?? t("strategy.resultSlot")}</p>}
    />
  );
}

export { parseStrategyResearchLaunch };
