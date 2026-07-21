import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ReplayCapabilitySurface from "../components/ReplayCapabilitySurface.js";
import { buildReplayCapabilityModel } from "../replayCapabilityModel.js";
import {
  loadReplayWorkspacePreferences,
  saveReplayWorkspacePreferences,
} from "../replayWorkspacePreferences.js";


const testDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDirectory, "../../../..");

function source(path: string): string {
  return readFileSync(resolve(frontendRoot, path), "utf8");
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("v2 workspace owns the same source-neutral market slots without legacy replacements", () => {
  const workspace = [
    "src/features/replay/ReplayTrainingPageShell.tsx",
    "src/features/replay/components/ReplayRightMarketRail.tsx",
  ].map(source).join("\n");
  const live = [
    "src/app/AppShell.tsx",
    "src/app/TopBar.tsx",
    "src/app/ChartWorkspace.tsx",
    "src/app/StatusBar.tsx",
    "src/app/RightMarketRail.tsx",
  ].map(source).join("\n");
  for (const owner of [
    "MarketPageFrame",
    "MarketTopBarFrame",
    "IntervalSelector",
    "MarketChartWorkspace",
    "MarketStatusBar",
    "MarketRightRailFrame",
  ]) {
    assert.match(workspace, new RegExp(owner));
    assert.match(live, new RegExp(owner));
  }
  assert.match(workspace, /DrawingToolbar/);
  assert.match(workspace, /ReplayRightMarketRail/);
  assert.match(workspace, /ReplayBottomControlDock/);
  assert.doesNotMatch(workspace, /ReplayRightRail/);
  assert.doesNotMatch(workspace, /replay-chart-toolbar/);
  assert.doesNotMatch(workspace, /<header\s+className="top-bar replay-top-bar"/);
});

test("v2 session route is flag-gated and leaves the v1 shell as the rollback path", () => {
  const composition = source("src/features/replay/ReplayApp.tsx");
  assert.match(composition, /REPLAY_PRODUCT_V2_ENABLED/);
  assert.match(composition, /ReplayTrainingPageShell/);
  assert.match(composition, /ReplayPageShell/);
  assert.match(composition, /entry\.kind === "session"/);
});

test("Phase 3 workspace projects ViewerState and exposes only source-valid replay grains", () => {
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const composition = source("src/features/replay/ReplayApp.tsx");
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  assert.match(composition, /useReplayViewerRuntime\(replay\)/);
  assert.match(composition, /useReplayIndicatorRuntime\(replay, viewer\.seriesStore\)/);
  assert.match(workspace, /seriesStore=\{viewer\.seriesStore\}/);
  assert.match(workspace, /setDisplayInterval/);
  assert.doesNotMatch(workspace, /Phase 2 interval is read-only|Phase 3 才开放重采样/);
  assert.match(controls, /data-replay-action="step-display"/);
  assert.match(controls, /data-replay-action="step-base"/);
  assert.match(controls, /viewer !== undefined && tradeTape/);
  assert.match(controls, /data-replay-action="step-event"/);
  assert.match(controls, /data-replay-action="cancel-advance"/);
});

test("capability surface never renders unsupported history as numeric zero or stale precision", () => {
  const model = buildReplayCapabilityModel("BAR");
  assert.equal(model.OHLCV.state, "AVAILABLE_EXACT");
  assert.equal(model.SIMULATED_LIQUIDATION.state, "AVAILABLE_APPROX");
  assert.equal(model.ORDER_BOOK.state, "UNSUPPORTED_NO_HISTORY");
  assert.equal(model.ORDER_BOOK.value, "--");
  const html = renderToStaticMarkup(<ReplayCapabilitySurface capabilities={model} />);
  assert.match(html, /UNSUPPORTED_NO_HISTORY/);
  assert.doesNotMatch(html, />0(?:\.0+)?</);

  const tape = buildReplayCapabilityModel("AGG_TRADE");
  assert.equal(tape.AGG_TRADE_TAPE.state, "AVAILABLE_EXACT");
  assert.equal(tape.ORDER_FLOW.state, "AVAILABLE_APPROX");
});

test("workspace preferences inherit live layout once and then persist only inside the run scope", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-sidebar-width", "410");
  storage.setItem("candlescope-sidebar-collapsed", "true");
  storage.setItem("candlescope-order-book-height", "430");
  const initial = loadReplayWorkspacePreferences("adapter-1", storage);
  assert.equal(initial.railWidth, 410);
  assert.equal(initial.railCollapsed, true);
  assert.equal(initial.dockHeight, 430);

  saveReplayWorkspacePreferences("adapter-1", {
    ...initial,
    railWidth: 360,
    railCollapsed: false,
    activeDock: "paper",
  }, storage);
  assert.equal(storage.getItem("candlescope-sidebar-width"), "410");
  assert.equal(storage.getItem("candlescope-sidebar-collapsed"), "true");
  assert.match(storage.getItem("candlescope-replay-workspace:adapter-1") ?? "", /"railWidth":360/);

  const restored = loadReplayWorkspacePreferences("adapter-1", storage);
  assert.equal(restored.railWidth, 360);
  assert.equal(restored.railCollapsed, false);
  assert.equal(restored.activeDock, "paper");
});
