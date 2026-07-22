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
  assert.equal(model.AGG_TRADE_TAPE.state, "UNSUPPORTED_SOURCE_MODE");
  assert.equal(model.ORDER_FLOW.state, "UNSUPPORTED_SOURCE_MODE");
  assert.equal(model.ORDER_BOOK.value, "--");
  assert.match(model.FUNDING.detail, /交易所历史 funding\/mark/);
  assert.match(model.FUNDING.detail, /近似账户模拟/);
  const html = renderToStaticMarkup(<ReplayCapabilitySurface capabilities={model} />);
  assert.match(html, /UNSUPPORTED_NO_HISTORY/);
  assert.doesNotMatch(html, />0(?:\.0+)?</);

  const tape = buildReplayCapabilityModel("AGG_TRADE");
  assert.equal(tape.AGG_TRADE_TAPE.state, "AVAILABLE_EXACT");
  assert.equal(tape.ORDER_FLOW.state, "AVAILABLE_APPROX");
  assert.match(tape.AGG_TRADE_TAPE.detail, /不是交易所 raw fills/);
  assert.match(tape.ORDER_FLOW.detail, /buyer-maker/);

  const book = buildReplayCapabilityModel("AGG_TRADE", {
    mode: "BOOK_ASSISTED_REQUIRED",
    capability_state: "AVAILABLE_EXACT",
    status: "READY",
    execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
    queue_exact: false,
    as_of_virtual_time_ms: 1_700_000_000_000,
    last_update_id: 42,
    bids: [["99", "1"]],
    asks: [["101", "1"]],
    book_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "连续历史 L2 已验证",
  });
  assert.equal(book.ORDER_BOOK.state, "AVAILABLE_EXACT");
  assert.equal(book.ORDER_BOOK.value, "EXACT_L2");
  assert.match(book.ORDER_BOOK.detail, /不含真实盘口排队/);
});

test("Phase 8 workspace exposes explainable plans and fail-closed aggregate trade flow", () => {
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const rail = source("src/features/replay/components/ReplayRightRail.tsx");
  const hook = source("src/features/replay/useReplayTradeFlow.ts");
  assert.match(controls, /data-replay-fast-forward-plan/);
  assert.match(controls, /data-replay-equivalence/);
  assert.match(rail, /\["flow", "订单流"\]/);
  assert.match(rail, /AGGREGATE_TRADE_NOT_RAW_TRADE|tradeFlow\.fidelity/);
  assert.match(rail, /UNSUPPORTED_SOURCE_MODE/);
  assert.match(hook, /CLEARED_FAIL_CLOSED/);
  assert.doesNotMatch(`${rail}\n${hook}`, /useMarketDataRuntime|SeriesDataFeed|WebSocket/);
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
