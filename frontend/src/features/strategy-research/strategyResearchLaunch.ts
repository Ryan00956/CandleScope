import {
  backtestCompareRunIdFromSearch,
  parseBacktestResearchEntry,
  type BacktestResearchEntry,
} from "../backtest/backtestDeepLink.js";

export type StrategyResearchPage = "strategy" | "local" | "backtest";

export type StrategyResearchVisualState = "first" | "import" | "chart" | "edit" | "completed";

export type StrategyResearchLaunchIntent =
  | { kind: "restore"; page: "strategy" }
  | { kind: "imported"; page: "local" | "strategy" }
  | { kind: "import"; page: "strategy" | "local" }
  | { kind: "advanced"; page: "backtest" | "strategy" }
  | {
      kind: "deep-link";
      page: StrategyResearchPage;
      entry: Extract<BacktestResearchEntry, { kind: "context" | "run" | "study" }>;
      compareRunId: string | null;
    }
  | { kind: "invalid"; page: StrategyResearchPage; message: string };

export function strategyResearchPageFromPathname(pathname: string): StrategyResearchPage {
  const file = pathname.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (file === "local.html") return "local";
  if (file === "backtest.html") return "backtest";
  return "strategy";
}

export function parseStrategyResearchLaunch(location: {
  pathname: string;
  search: string;
}): StrategyResearchLaunchIntent {
  const page = strategyResearchPageFromPathname(location.pathname);
  const search = location.search.startsWith("?") ? location.search : `?${location.search}`;
  const params = new URLSearchParams(search);
  const deep = parseBacktestResearchEntry(search);
  if (deep.kind === "invalid") {
    return { kind: "invalid", page, message: deep.message };
  }
  if (deep.kind !== "home") {
    return {
      kind: "deep-link",
      page,
      entry: deep,
      compareRunId: backtestCompareRunIdFromSearch(search),
    };
  }
  const action = params.get("action")?.trim() ?? "";
  const source = params.get("source")?.trim() ?? "";
  if (action === "import") return { kind: "import", page: page === "backtest" ? "strategy" : page };
  if (source === "imported") return { kind: "imported", page: page === "backtest" ? "local" : page };
  if (page === "local") return { kind: "imported", page: "local" };
  if (page === "backtest") return { kind: "advanced", page: "backtest" };
  return { kind: "restore", page: "strategy" };
}

export function strategyResearchDeepLinkSearch(intent: StrategyResearchLaunchIntent): string | null {
  if (intent.kind !== "deep-link") return null;
  if (intent.entry.kind === "context") return `?context=${encodeURIComponent(intent.entry.contextId)}`;
  if (intent.entry.kind === "run") {
    const compare = intent.compareRunId ? `&compare=${encodeURIComponent(intent.compareRunId)}` : "";
    return `?run=${encodeURIComponent(intent.entry.runId)}${compare}`;
  }
  return `?study=${encodeURIComponent(intent.entry.studyId)}`;
}

export function resolveStrategyResearchBootstrap(input: {
  libraryEnabled: boolean;
  page: StrategyResearchPage;
}): "unified" | "local-legacy" | "backtest-legacy" {
  if (input.libraryEnabled) return "unified";
  if (input.page === "local") return "local-legacy";
  if (input.page === "backtest") return "backtest-legacy";
  return "unified";
}

export function strategyResearchLaunchActions(
  intent: StrategyResearchLaunchIntent,
): Array<
  | { type: "source/libraryOpen"; open: true }
  | { type: "result/setRun"; runId: string }
> {
  if (intent.kind === "imported" || intent.kind === "import") {
    return [{ type: "source/libraryOpen", open: true }];
  }
  if (intent.kind === "deep-link" && intent.entry.kind === "run") {
    return [{ type: "result/setRun", runId: intent.entry.runId }];
  }
  return [];
}

export function strategyResearchVisualState(
  intent: StrategyResearchLaunchIntent,
  state: {
    source: { source: unknown; libraryOpen: boolean };
    script: { draftId: string | null };
    result: { runId: string | null; stale: boolean };
  },
): StrategyResearchVisualState {
  if (intent.kind === "invalid") return "first";
  if (state.result.runId !== null && !state.result.stale) return "completed";
  if (intent.kind === "import" || (intent.kind === "imported" && state.source.source == null)) return "import";
  if (intent.kind === "advanced" || state.script.draftId !== null) return "edit";
  if (state.source.source != null) return "chart";
  return "first";
}
