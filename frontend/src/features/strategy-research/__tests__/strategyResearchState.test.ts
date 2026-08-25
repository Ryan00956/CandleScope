import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ResearchSourceRefV1 } from "../../research-data/researchDataTypes.js";
import { ResearchDataSourceBar } from "../../research-data/ResearchDataSourceBar.js";
import { resolveResearchDataLibraryEnabled } from "../../research-data/researchDataFlags.js";
import { ResearchDataDrawer } from "../../research-data/ResearchDataDrawer.js";
import { StrategyResearchRuntime } from "../StrategyResearchRuntime.js";
import {
  EMPTY_STRATEGY_RESEARCH_STATE,
  loadStrategyResearchWorkspace,
  persistStrategyResearchWorkspace,
  STRATEGY_RESEARCH_WORKSPACE_KEY,
  strategyResearchReducer,
} from "../strategyResearchState.js";

const imported: ResearchSourceRefV1 = {
  schemaVersion: "candlescope.research-source/1",
  kind: "IMPORTED_DATASET",
  datasetId: "local-0123456789abcdef0123456789abcdef",
  dataEpoch: `sha256:${"a".repeat(64)}`,
  interval: "15m",
};

const settings = {
  upColor: "#0f0",
  downColor: "#f00",
  chartType: "candles",
} as never;

test("source, script, and result stay independent slices", () => {
  let state = EMPTY_STRATEGY_RESEARCH_STATE;
  state = strategyResearchReducer(state, { type: "source/select", source: imported });
  assert.equal(state.script.draftId, null);
  assert.equal(state.result.runId, null);
  state = strategyResearchReducer(state, { type: "script/setDraft", draftId: "draft-1" });
  assert.equal(state.source.source?.kind, "IMPORTED_DATASET");
  assert.equal(state.result.runId, null);
});

test("editor content revision stales a completed run without rewriting the draft id", () => {
  let state = EMPTY_STRATEGY_RESEARCH_STATE;
  state = strategyResearchReducer(state, { type: "script/setDraft", draftId: "draft-1" });
  state = strategyResearchReducer(state, { type: "result/setRun", runId: "bt_1" });
  const sameDraft = strategyResearchReducer(state, { type: "script/setDraft", draftId: "draft-1" });
  assert.equal(sameDraft.result.stale, false);
  const edited = strategyResearchReducer(state, { type: "script/setContentRevision", revision: 42 });
  assert.equal(edited.script.draftId, "draft-1");
  assert.equal(edited.script.contentRevision, 42);
  assert.equal(edited.result.stale, true);
  assert.equal(edited.result.staleReason, "SCRIPT_CHANGED");
});

test("viewing data does not create a run", () => {
  const runtime = new StrategyResearchRuntime({ restoreWorkspace: false, libraryEnabled: true });
  runtime.dispatch({ type: "source/select", source: imported });
  runtime.dispatch({ type: "source/libraryOpen", open: true });
  assert.equal(runtime.state.result.runId, null);
  assert.equal(runtime.state.source.previewFrozen, false);
});

test("revision change emits DATA_REVISION_CHANGED and stales the previous run in one update", () => {
  let state = EMPTY_STRATEGY_RESEARCH_STATE;
  state = strategyResearchReducer(state, { type: "source/select", source: imported });
  state = strategyResearchReducer(state, { type: "result/setRun", runId: "bt_1" });
  const nextEpoch = `sha256:${"b".repeat(64)}`;
  const next = strategyResearchReducer(state, {
    type: "source/revisionChanged",
    source: { ...imported, dataEpoch: nextEpoch },
  });
  assert.equal(next.source.source && next.source.source.kind === "IMPORTED_DATASET" ? next.source.source.dataEpoch : "", nextEpoch);
  assert.equal(next.source.previewFrozen, false);
  assert.equal(next.result.stale, true);
  assert.equal(next.result.staleReason, "DATA_REVISION_CHANGED");
  assert.equal(next.result.runId, "bt_1");
});

test("malformed localStorage fails closed without clearing the key", () => {
  const store = new Map<string, string>();
  const original = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string) { return store.get(key) ?? null; },
        setItem(key: string, value: string) { store.set(key, value); },
        removeItem(key: string) { store.delete(key); },
      },
    },
  });
  try {
    store.set(STRATEGY_RESEARCH_WORKSPACE_KEY, "{not-json");
    const loaded = loadStrategyResearchWorkspace();
    assert.deepEqual(loaded, EMPTY_STRATEGY_RESEARCH_STATE);
    assert.equal(store.get(STRATEGY_RESEARCH_WORKSPACE_KEY), "{not-json");
    persistStrategyResearchWorkspace(EMPTY_STRATEGY_RESEARCH_STATE);
    assert.equal(store.has(STRATEGY_RESEARCH_WORKSPACE_KEY), true);
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  }
});

test("this workspace never treats current chart as runnable", () => {
  const live = new StrategyResearchRuntime({
    restoreWorkspace: false,
    runtimeMode: "LIVE",
    libraryEnabled: true,
  });
  assert.equal(live.currentChartRunnable(), false);
  const runtime = new StrategyResearchRuntime({
    restoreWorkspace: false,
    runtimeMode: "LOCAL_OFFLINE",
    libraryEnabled: true,
  });
  assert.equal(runtime.currentChartRunnable(), false);
  const html = renderToStaticMarkup(
    React.createElement(ResearchDataDrawer, {
      open: true,
      runtimeMode: "LOCAL_OFFLINE",
      capabilities: runtime.capabilitiesFor("CURRENT_CHART"),
      libraryEnabled: true,
      settings,
      events: [],
      onSelectKind() {},
      onClose() {},
    }),
  );
  assert.match(html, /research-source-card-CURRENT_CHART/);
  assert.match(html, /disabled/);
  const liveDrawer = renderToStaticMarkup(
    React.createElement(ResearchDataDrawer, {
      open: true,
      runtimeMode: "LIVE",
      capabilities: live.capabilitiesFor("CURRENT_CHART"),
      libraryEnabled: true,
      settings,
      events: [],
      onSelectKind() {},
      onClose() {},
    }),
  );
  assert.match(liveDrawer, /disabled/);
  assert.doesNotMatch(html.toLowerCase(), /dataset id|data epoch|snapshot hash/);
});

test("default-on flag keeps explicit rollback for the import entry", () => {
  assert.equal(resolveResearchDataLibraryEnabled({}), true);
  assert.equal(resolveResearchDataLibraryEnabled({ VITE_RESEARCH_DATA_LIBRARY_ENABLED: "0" }), false);
  assert.equal(resolveResearchDataLibraryEnabled({ VITE_RESEARCH_DATA_LIBRARY_ENABLED: "1" }), true);
  const hidden = renderToStaticMarkup(
    React.createElement(ResearchDataSourceBar, {
      source: null,
      libraryEnabled: false,
      onOpenLibrary() {},
      onSelectCurrentChart() {},
    }),
  );
  assert.match(hidden, /research-data-source-bar/);
  assert.match(hidden, /research-source-use-current-chart/);
  assert.doesNotMatch(hidden, /research.source.openLibrary|Open local library|打开本地资料库/);
  const chartOnly = renderToStaticMarkup(
    React.createElement(ResearchDataDrawer, {
      open: true,
      runtimeMode: "LIVE",
      capabilities: null,
      libraryEnabled: false,
      settings,
      events: [],
      onSelectKind() {},
      onClose() {},
    }),
  );
  assert.doesNotMatch(chartOnly, /research-source-card-IMPORTED_DATASET/);
  assert.match(chartOnly, /research-source-card-CURRENT_CHART/);
});

test("selecting a source does not mention internal identity in ordinary copy", () => {
  const html = renderToStaticMarkup(
    React.createElement(ResearchDataSourceBar, {
      source: imported,
      libraryEnabled: true,
      onOpenLibrary() {},
    }),
  );
  assert.match(html, /research-data-source-bar/);
  assert.doesNotMatch(html.toLowerCase(), /dataset id|data epoch|snapshot hash|local profile/);
});
