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
import { createReplayViewerProjectionScheduler } from "../useReplayViewerRuntime.js";


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
  assert.match(workspace, /ReviewMode 只读图表工具/);
  assert.match(workspace, /review === null \? viewer\.seriesStore : reviewSeriesStore/);
  assert.match(workspace, /aria-controls="replay-integrity-drawer"/);
  assert.match(workspace, /integrityOpen &&/);
  assert.match(workspace, /event\.key !== "Escape"/);
  assert.doesNotMatch(workspace, /<header\s+className="top-bar replay-top-bar"/);
});

test("v2 session route is flag-gated and leaves the v1 shell as the rollback path", () => {
  const composition = source("src/features/replay/ReplayApp.tsx");
  assert.match(composition, /REPLAY_PRODUCT_V2_ENABLED/);
  assert.match(composition, /ReplayTrainingPageShell/);
  assert.match(composition, /ReplayPageShell/);
  assert.match(composition, /entry\.kind === "session"/);
});

test("Phase 13 workspace projects ViewerState and exposes capability-driven advance bases", () => {
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const composition = source("src/features/replay/ReplayApp.tsx");
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const viewerRuntime = source("src/features/replay/useReplayViewerRuntime.ts");
  assert.match(composition, /useReplayViewerRuntime\(replay\)/);
  assert.match(composition, /useReplaySharedIndicatorRuntime\(/);
  assert.match(workspace, /<IndicatorPanel/);
  assert.doesNotMatch(workspace, /ReplayIndicatorPanel/);
  for (const prop of [
    "indicatorMarkers",
    "indicatorFills",
    "indicatorHlines",
    "indicatorBgcolors",
    "indicatorBarcolors",
  ]) {
    assert.match(workspace, new RegExp(`${prop}=\\{`));
  }
  assert.match(workspace, /seriesStore=\{displayedSeriesStore\}/);
  assert.match(workspace, /review === null \? viewer\.seriesStore : reviewSeriesStore/);
  assert.match(workspace, /setDisplayInterval/);
  assert.match(workspace, /buildReplayIntervalCatalog/);
  assert.match(workspace, /useCustomIntervals/);
  assert.match(workspace, /customIntervalRecords=\{customIntervalRecords\}/);
  assert.match(workspace, /savedCustomIntervals=\{savedCustomIntervals\}/);
  assert.doesNotMatch(workspace, /\[base, "1m", "5m", "15m", "1h"\]/);
  assert.doesNotMatch(workspace, /Phase 2 interval is read-only|Phase 3 才开放重采样/);
  assert.match(controls, /globalClock\?\.supported_bases/);
  assert.match(controls, /globalClock\?\.playback_bases/);
  assert.match(controls, /data-replay-action="advance-display"/);
  assert.match(controls, /data-replay-action="advance-base"/);
  assert.match(controls, /data-replay-action="advance-source-event"/);
  assert.match(controls, /phase3Command\("advance"/);
  assert.match(controls, /下一聚合成交/);
  assert.doesNotMatch(controls, /phase3Command\("step_(?:display|base|event)"/);
  assert.match(controls, /data-replay-action="cancel-advance"/);
  assert.match(viewerRuntime, /type === "advance"/);
  assert.match(viewerRuntime, /export function replayAdvanceIsCancelable/);
  assert.match(viewerRuntime, /command\.payload\.basis === "VIRTUAL_TIME"/);
  assert.match(viewerRuntime, /if \(!replayAdvanceIsCancelable\(active\)\) return/);
  assert.match(controls, /const cancelableAdvancePending = replayAdvanceIsCancelable/);
  assert.match(viewerRuntime, /payload\.basis === "DISPLAY_BAR"/);
  assert.match(viewerRuntime, /defaultReplayV2Api\.advanceProgress/);
  assert.match(viewerRuntime, /"cancel_advance"/);
  assert.match(workspace, /const effectiveState = replayEffectiveTrainingState\(/);
  assert.match(controls, /const effectiveState = replayEffectiveTrainingState\(/);
  assert.match(workspace, /viewer\.actions\.submitControl\("play", \{/);
  assert.match(workspace, /basis: globalClock\.basis/);
  assert.match(workspace, /viewer\.actions\.submitControl\("advance", \{/);
  assert.doesNotMatch(workspace, /submitControl\("step_display"|submitControl\("advance_by"/);
  assert.match(workspace, /viewer\.actions\.submitControl\("pause", \{\}\)/);
  assert.match(workspace, /"data-replay-session-state": review === null \? effectiveState/);
  assert.match(workspace, /"data-replay-adapter-state": review === null \? runtime\.store\.state/);
  assert.match(workspace, /"data-replay-generation": runtime\.store\.generation/);
  assert.match(workspace, /"data-replay-clock-basis": review === null \? globalClock\?\.basis/);
  assert.match(workspace, /"data-replay-clock-rate": review === null \? globalClock\?\.rate/);
  assert.match(workspace, /"data-replay-control-pending": review === null/);
});

test("capability surface never renders unsupported history as numeric zero or stale precision", () => {
  const model = buildReplayCapabilityModel("BAR");
  assert.equal(model.OHLCV.state, "AVAILABLE_EXACT");
  assert.equal(model.SIMULATED_LIQUIDATION.state, "AVAILABLE_APPROX");
  assert.equal(model.ORDER_BOOK.state, "UNSUPPORTED_NO_HISTORY");
  assert.equal(model.AGG_TRADE_TAPE.state, "UNSUPPORTED_SOURCE_MODE");
  assert.equal(model.ORDER_FLOW.state, "AVAILABLE_APPROX");
  assert.equal(model.ORDER_FLOW.value, "KLINE_TAKER_PROXY");
  assert.match(model.ORDER_FLOW.detail, /taker buy volume/);
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

test("paper trading dock owns a complete readable surface in both app themes", () => {
  const rail = source("src/features/replay/components/ReplayRightRail.tsx");
  const marketRail = source("src/features/replay/components/ReplayRightMarketRail.tsx");
  const styles = source("src/index.css");
  assert.match(rail, /className="replay-paper-trading"/);
  assert.match(rail, /role="tablist"/);
  assert.match(rail, /role="tabpanel"/);
  assert.match(rail, /handleRailTabKeyDown/);
  assert.match(marketRail, /data-active-dock=\{preferences\.activeDock\}/);
  assert.match(styles, /\[data-theme='light'\] \.replay-paper-trading/);
  assert.match(styles, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /--replay-rail-text-muted: #5f7086/);
});

test("Phase 15 workspace exposes explicit bounded summary preparation and proof status", () => {
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const runtime = source("src/features/replay/useReplayViewerRuntime.ts");
  const api = source("src/features/replay/replayV2Api.ts");
  assert.match(controls, /data-replay-period-summary/);
  assert.match(controls, /data-replay-action="prepare-period-summaries"/);
  assert.match(controls, /build_wall_ms/);
  assert.match(controls, /summaryStatus/);
  assert.match(runtime, /preparePeriodSummariesRun/);
  assert.match(runtime, /periodSummaryStatusRun/);
  assert.match(api, /fast-forward-summaries\/prepare/);
  assert.doesNotMatch(`${controls}\n${runtime}\n${api}`, /useMarketDataRuntime|\/market\//);
});

test("viewer projection subscription is stable across equivalent runtime snapshots", () => {
  const runtime = source("src/features/replay/useReplayViewerRuntime.ts");
  assert.match(runtime, /const baseInterval = config\?\.base_interval \?\? null/);
  assert.match(runtime, /const displayInterval = viewerState\?\.display_interval \?\? null/);
  assert.match(
    runtime,
    /\[baseInterval, displayInterval, seriesStore, sourceStore\]/,
  );
  assert.doesNotMatch(runtime, /\[config, seriesStore, sourceStore, viewerState\]/);
});

test("history paging stays non-blocking and uses viewer delta projection", () => {
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const runtime = source("src/features/replay/useReplayViewerRuntime.ts");
  assert.doesNotMatch(
    workspace,
    /loading=\{review === null\s*&&\s*\([^)]*history\.loading/s,
  );
  assert.match(workspace, /history\.loading && <span>Loading older replay data/);
  assert.match(runtime, /applyReplayViewerSeriesDelta/);
  assert.match(runtime, /pendingSourceDeltas\.push\(delta\)/);
});

test("viewer projection coalesces source bursts to one rebuild per browser frame", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  const canceled: number[] = [];
  let nextHandle = 1;
  let rebuilds = 0;
  const scheduler = createReplayViewerProjectionScheduler(
    () => { rebuilds += 1; },
    (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    (handle) => {
      canceled.push(handle);
      callbacks.delete(handle);
    },
  );

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  assert.deepEqual([...callbacks.keys()], [1]);
  assert.equal(rebuilds, 0);
  callbacks.get(1)?.(0);
  callbacks.delete(1);
  assert.equal(rebuilds, 1);

  scheduler.schedule();
  assert.deepEqual([...callbacks.keys()], [2]);
  scheduler.cancel();
  assert.deepEqual(canceled, [2]);
  assert.equal(callbacks.size, 0);
  scheduler.cancel();
  assert.deepEqual(canceled, [2]);
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

test("Phase 10 release surface exposes soak telemetry and an accessible danger dialog", () => {
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const integrity = source("src/features/replay/components/ReplayIntegrityReviewPanel.tsx");
  const styles = source("src/index.css");

  assert.match(workspace, /data-replay-order-count/);
  assert.match(workspace, /data-replay-fill-count/);
  assert.match(controls, /data-replay-focus-trap="active"/);
  assert.match(controls, /aria-describedby="replay-end-description"/);
  assert.match(controls, /event\.key === "Escape"/);
  assert.match(controls, /event\.key !== "Tab"/);
  assert.match(controls, /requestAnimationFrame\(\(\) => restore\?\.focus\(\)\)/);
  assert.match(integrity, /data-replay-panel="report"/);
  assert.match(integrity, /downloadReplayTrainingReport\(report, "json"\)/);
  assert.match(integrity, /downloadReplayTrainingReport\(report, "csv"\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.replay-loading-spinner \{ animation: none !important; \}/);
});
