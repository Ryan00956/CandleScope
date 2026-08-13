import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ReplayCapabilitySurface from "../components/ReplayCapabilitySurface.js";
import ReplayControlBar from "../components/ReplayControlBar.js";
import { boundedReplayAdvanceAmount } from "../replayAdvanceLimits.js";
import { buildReplayCapabilityModel } from "../replayCapabilityModel.js";
import {
  clearReplayWorkspacePreferences,
  loadReplayWorkspacePreferences,
  saveReplayWorkspacePreferences,
} from "../replayWorkspacePreferences.js";
import {
  createReplayMarketTracksRequestGate,
  createReplayViewerProjectionRequestGate,
  createReplayViewerProjectionRequestScheduler,
  createReplayViewerProjectionScheduler,
  REPLAY_STORE_REVISION_ACK_TIMEOUT_MS,
  runReplayMarketTracksRequest,
  waitForReplayStoreRevision,
} from "../useReplayViewerRuntime.js";


const testDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDirectory, "../../../..");

function source(path: string): string {
  return readFileSync(resolve(frontendRoot, path), "utf8");
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
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

test("every replay route stays on the v2 Hub or workspace", () => {
  const composition = source("src/features/replay/ReplayApp.tsx");
  assert.match(composition, /ReplayTrainingPageShell/);
  assert.match(composition, /entry\.kind === "configure"/);
  assert.match(composition, /entry\.kind === "run"/);
  assert.match(composition, /ReplayInitialMarketPicker/);
  assert.doesNotMatch(composition, /ReplayV1App|ReplayPageShell|resolveReplayProduct/);
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
  assert.match(workspace, /captureViewportTransfer/);
  assert.match(workspace, /datasetViewportTransfer=\{review === null \? activeIntervalViewportTransfer : null\}/);
  assert.match(workspace, /useReplayHistoryRuntime\(runtime, viewer, activeIntervalViewportTransfer\)/);
  assert.match(workspace, /intervalViewportTransfer\.targetInterval/);
  assert.match(workspace, /current\?\.snapshot === transfer/);
  assert.match(workspace, /data-replay-source-bar-count/);
  assert.match(workspace, /data-replay-viewer-bar-count/);
  assert.match(workspace, /data-replay-source-series-version/);
  assert.match(workspace, /data-replay-viewer-series-version/);
  assert.match(workspace, /data-replay-viewer-error/);
  assert.match(workspace, /data-replay-viewer-state-ready/);
  assert.match(workspace, /data-replay-source-interval-seconds/);
  assert.doesNotMatch(workspace, /\[\.\.\.indicators\.view\./);
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
  assert.match(
    viewerRuntime,
    /createReplayViewerProjectionRequestScheduler\(refresh\)/,
    "coarse projection I/O must not wait for a paint frame",
  );
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
  assert.equal(tape.OHLCV.state, "AVAILABLE_APPROX");
  assert.equal(tape.INDICATORS.state, "AVAILABLE_APPROX");
  assert.equal(tape.AGG_TRADE_TAPE.state, "AVAILABLE_EXACT");
  assert.match(tape.OHLCV.detail, /官方 K 线不同/);
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
  assert.match(marketRail, /data-active-dock=\{dockAttr\}/);
  assert.match(styles, /\[data-theme='light'\] \.replay-paper-trading/);
  assert.match(styles, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /--replay-rail-text-muted: #5f7086/);
});

test("order-size capacity is independent from draft preview failures", () => {
  const rail = source("src/features/replay/components/ReplayRightRail.tsx");

  assert.match(rail, /const \[maxQuantitySnapshot, setMaxQuantitySnapshot\] = useState/);
  assert.match(rail, /const \[capacityState, setCapacityState\] = useState/);
  assert.match(rail, /viewer\.actions\.orderCapacity/);
  assert.match(rail, /const \[sizeShareIntent, setSizeShareIntent\] = useState<number \| null>/);
  assert.match(rail, /setMaxQuantitySnapshot\(\{/);
  assert.match(rail, /replayOrderSizingAvailability\(estimatedMaxQuantity, quantity\)/);
  assert.match(rail, /rebaseReplayMaxQuantity\(\{/);
  assert.match(rail, /sizeShareIntent === null[\s\S]*derivedSizeShare/);
  assert.match(rail, /const resolvedSizeInput = sizeShareIntent !== null/);
  assert.match(rail, /value=\{resolvedSizeInput\}/);
  assert.match(rail, /aria-label="下单金额快速选择"/);
  assert.match(rail, /onLostPointerCapture=\{\(\) => setSliderDragging\(false\)\}/);
  assert.match(rail, /\|\| reduceOnlyUnavailableMessage !== null/);
  assert.match(rail, /notice\?\.message \?\? reduceOnlyUnavailableMessage/);
});

test("right-rail trading workstation keeps positions and account history out of the chart stack", () => {
  const rail = source("src/features/replay/components/ReplayRightRail.tsx");
  const marketRail = source("src/features/replay/components/ReplayRightMarketRail.tsx");
  const shell = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const styles = source("src/index.css");

  assert.doesNotMatch(shell, /bottomPanel=/);
  assert.doesNotMatch(shell, /ReplayTradingWorkbench/);
  assert.match(marketRail, /<ReplayTradingWorkbench/);
  assert.match(marketRail, /viewId === REPLAY_RAIL_VIEW_IDS\.account \? "仓位"/);
  assert.match(rail, /data-replay-workbench="rail"/);
  assert.match(rail, /\["open-orders", "当前"\]/);
  assert.match(rail, /\["order-history", "历史"\]/);
  assert.match(rail, /TERMINAL_ORDER_STATES\.has/);
  assert.match(rail, /defaultReplayV2Api\.reportRun/);
  assert.match(rail, /data-replay-action="close-partial"/);
  assert.match(rail, /aria-live="polite"/);
  assert.match(rail, /className="replay-position-card"/);
  assert.match(rail, /维持保证金\{maintenanceTierExtrapolated \? "（末档外推≈）" : ""\}/);
  assert.match(rail, /强平价格（模拟≈\{liquidationTierExtrapolated \? "，末档外推" : ""\}）/);
  assert.match(rail, /存在仓位超过历史末档，按末档费率和速算扣除数外推≈/);
  assert.match(rail, /标记价格（\{replayMarkFidelityLabel\(item\.mark_fidelity\)\}）/);
  assert.match(rail, /破产价格（模拟≈）/);
  assert.match(rail, /replayPositiveModelPrice\(item\.liquidation_price\)/);
  assert.match(rail, /className="replay-compact-record"/);
  assert.match(styles, /\.replay-trading-workbench\[data-replay-workbench="rail"\]/);
  assert.match(styles, /\.replay-rail-account-scroll \{/);
  assert.match(styles, /\.replay-position-card,/);
  assert.match(styles, /\.replay-submit-order\[data-side="BUY"\]/);
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
  assert.match(runtime, /requiresSourceBucketProjection/);
  assert.match(runtime, /displayProjectionBySession/);
  assert.match(runtime, /replaceReplayViewerSeriesFromServer/);
  assert.match(runtime, /sourceStore\.subscribe/);
  assert.match(
    runtime,
    /const projectionRequestScheduler = createReplayViewerProjectionRequestScheduler\(refresh\);\s*const unsubscribe = sourceStore\.subscribe[\s\S]*?refresh\(\);/,
  );
  assert.match(
    runtime,
    /const projectionScheduler = createReplayViewerProjectionScheduler\(rebuild\);\s*const unsubscribe = sourceStore\.subscribe[\s\S]*?rebuild\(\);/,
  );
  assert.doesNotMatch(runtime, /\[config, seriesStore, sourceStore, viewerState\]/);
});

test("history paging stays non-blocking and uses viewer delta projection", () => {
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const runtime = source("src/features/replay/useReplayViewerRuntime.ts");
  const historyRuntime = source("src/features/replay/useReplayHistoryRuntime.ts");
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  assert.doesNotMatch(
    workspace,
    /loading=\{review === null\s*&&\s*\([^)]*history\.loading/s,
  );
  assert.match(workspace, /history\.loading && <span>Loading older replay data/);
  assert.match(runtime, /applyReplayViewerSeriesDelta/);
  assert.match(runtime, /pendingSourceDeltas\.push\(delta\)/);
  assert.match(historyRuntime, /replayHistoryFirstPageBeforeMs/);
  assert.match(historyRuntime, /provider\.historyEpoch === null/);
  assert.match(historyRuntime, /usesSourceBucketProjection/);
  assert.match(historyRuntime, /historyState\.key === historyKey/);
  assert.match(historyRuntime, /latest\.generation !== runtimeGeneration/);
  assert.match(
    historyRuntime,
    /replayHistoryStoreBeforeMs\(\s*viewer\.seriesStore,\s*\)/s,
  );
  assert.match(historyRuntime, /applyReplayHistoryPage\(viewer\.seriesStore/);
  assert.match(historyRuntime, /contextHistory:\s*true/);
  assert.match(historyRuntime, /latestViewportBeforeMs !== pendingViewportBeforeMs/);
  assert.match(historyRuntime, /latestRepairBeforeMs !== pendingRepairBeforeMs/);
  assert.match(historyRuntime, /historyViewportTransfer = usesSourceBucketProjection/);
  assert.match(historyRuntime, /replayHistoryViewportBeforeMs\(viewer\.seriesStore/);
  assert.doesNotMatch(
    historyRuntime,
    /applyReplayHistoryPage\(runtime\.replayStore\.seriesStore/,
  );
  assert.match(historyRuntime, /expectedBeforeMs:\s*beforeMs/);
  assert.doesNotMatch(historyRuntime, /oldestLoadedTime/);
  assert.match(
    workspace,
    /history\.historyEpoch !== null && !history\.hasMore && !history\.loading/,
  );
  assert.match(controls, /训练已结束；获取复盘控制权后可揭示真实区间或添加日志/);
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

test("viewer projection requests are latest-boundary-wins and dedupe committed keys", () => {
  const created: AbortController[] = [];
  const gate = createReplayViewerProjectionRequestGate(() => {
    const request = new AbortController();
    created.push(request);
    return request;
  });

  const first = gate.begin("boundary-a");
  assert.ok(first);
  assert.equal(gate.begin("boundary-a"), null);
  const second = gate.begin("boundary-b");
  assert.ok(second);
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent("boundary-a", first), false);
  assert.equal(gate.isCurrent("boundary-b", second), true);
  assert.equal(gate.commit("boundary-a", first), false);
  assert.equal(gate.commit("boundary-b", second), true);
  assert.equal(gate.begin("boundary-b"), null);

  const third = gate.begin("boundary-c");
  assert.ok(third);
  gate.cancel();
  assert.equal(third.signal.aborted, true);
  assert.equal(created.length, 3);
});

test("MarketTrack polling is single-flight and command refreshes cannot be starved", async () => {
  const created: AbortController[] = [];
  const gate = createReplayMarketTracksRequestGate(() => {
    const request = new AbortController();
    created.push(request);
    return request;
  });

  const published: string[] = [];
  let resolvePoll!: (value: string) => void;
  const pollResponse = new Promise<string>((resolve) => { resolvePoll = resolve; });
  let resolveCommand!: (value: string) => void;
  const commandResponse = new Promise<string>((resolve) => { resolveCommand = resolve; });
  const poll = runReplayMarketTracksRequest(
    gate,
    "poll",
    () => pollResponse,
    (response) => { published.push(response); },
  );
  assert.equal(created.length, 1);
  assert.equal(await runReplayMarketTracksRequest(
    gate,
    "poll",
    async () => "UNREACHABLE",
    (response) => { published.push(response); },
  ), null);

  const command = runReplayMarketTracksRequest(
    gate,
    "authoritative",
    () => commandResponse,
    (response) => { published.push(response); },
  );
  assert.equal(created.length, 2);
  assert.equal(created[0]?.signal.aborted, true);
  assert.equal(created[1]?.signal.aborted, false);
  assert.equal(gate.begin("poll"), null);

  // Simulate a transport that still settles after cancellation. The stale
  // PLAYING projection must not publish or clear the PAUSED request's gate.
  resolvePoll("PLAYING");
  assert.equal(await poll, "PLAYING");
  assert.deepEqual(published, []);
  assert.equal(gate.begin("poll"), null);

  resolveCommand("PAUSED");
  assert.equal(await command, "PAUSED");
  assert.deepEqual(published, ["PAUSED"]);
  const nextPoll = gate.begin("poll");
  assert.ok(nextPoll);
  assert.equal(gate.isCurrent(nextPoll), true);
  gate.cancel();
  assert.equal(nextPoll.signal.aborted, true);
  assert.equal(created.length, 3);
});

test("source-bucket projection requests cross authority on a microtask without waiting for paint", () => {
  const callbacks: Array<() => void> = [];
  let refreshes = 0;
  const scheduler = createReplayViewerProjectionRequestScheduler(
    () => { refreshes += 1; },
    (callback) => { callbacks.push(callback); },
  );

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(callbacks.length, 1);
  assert.equal(refreshes, 0);
  callbacks.shift()?.();
  assert.equal(refreshes, 1);

  scheduler.schedule();
  assert.equal(callbacks.length, 1);
  scheduler.cancel();
  callbacks.shift()?.();
  assert.equal(refreshes, 1);

  scheduler.schedule();
  callbacks.shift()?.();
  assert.equal(refreshes, 2);
});

test("display advance acknowledgement waits for the authoritative stream revision", async () => {
  assert.equal(REPLAY_STORE_REVISION_ACK_TIMEOUT_MS, 1_000);
  let revision = 3;
  const listeners = new Set<() => void>();
  const store = {
    getAuthoritySnapshot: () => ({ revision }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const pending = waitForReplayStoreRevision(store, 4, 100);
  assert.equal(listeners.size, 1);
  revision = 4;
  for (const listener of listeners) listener();
  assert.equal(await pending, true);
  assert.equal(listeners.size, 0);
  assert.equal(await waitForReplayStoreRevision(store, 4), true);
});

test("workspace preferences inherit live layout once and then persist only inside the run scope", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-sidebar-width", "410");
  storage.setItem("candlescope-sidebar-collapsed", "true");
  storage.setItem("candlescope-order-book-height", "430");
  const initial = loadReplayWorkspacePreferences("adapter-1", storage);
  assert.equal(initial.railWidth, 410);
  // Legacy collapsed rail → hide panel while keeping open views restorable.
  assert.deepEqual(initial.openViewIds, ["replay-watchlist", "replay-capabilities"]);
  assert.equal(initial.panelCollapsed, true);
  assert.equal(initial.viewHeights["replay-paper"], 430);

  saveReplayWorkspacePreferences("adapter-1", {
    ...initial,
    railWidth: 360,
    openViewIds: ["replay-watchlist", "replay-paper", "replay-capabilities"],
    panelCollapsed: false,
    viewHeights: {
      ...initial.viewHeights,
      "replay-paper": 300,
      "replay-capabilities": 240,
    },
  }, storage);
  assert.equal(storage.getItem("candlescope-sidebar-width"), "410");
  assert.equal(storage.getItem("candlescope-sidebar-collapsed"), "true");
  assert.match(storage.getItem("candlescope-replay-workspace:adapter-1") ?? "", /"railWidth":360/);

  const restored = loadReplayWorkspacePreferences("adapter-1", storage);
  assert.equal(restored.railWidth, 360);
  assert.deepEqual(restored.openViewIds, ["replay-watchlist", "replay-paper", "replay-capabilities"]);
  assert.equal(restored.panelCollapsed, false);
  assert.equal(restored.viewHeights["replay-paper"], 300);
  assert.equal(restored.viewHeights["replay-capabilities"], 240);
});

test("workspace preferences migrate the pre-module replay rail without coupling panel heights", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-replay-workspace:legacy", JSON.stringify({
    railWidth: 400,
    railCollapsed: false,
    dockHeight: 430,
    dockCollapsed: false,
    activeDock: "activity",
  }));

  const migrated = loadReplayWorkspacePreferences("legacy", storage);
  assert.deepEqual(migrated.openViewIds, ["replay-watchlist", "replay-activity"]);
  assert.equal(migrated.viewHeights["replay-paper"], 430);
  assert.equal(migrated.viewHeights["replay-account"], 430);
  assert.equal(migrated.viewHeights["replay-activity"], 430);
  assert.equal(migrated.viewHeights["replay-capabilities"], 280);
});

test("workspace preferences migrate a legacy modular empty rail to restorable collapse state", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-replay-workspace:legacy-empty", JSON.stringify({
    railWidth: 380,
    openViewIds: [],
    viewHeights: { "replay-capabilities": 300 },
  }));

  const migrated = loadReplayWorkspacePreferences("legacy-empty", storage);

  assert.deepEqual(migrated.openViewIds, ["replay-watchlist", "replay-capabilities"]);
  assert.equal(migrated.panelCollapsed, true);
  assert.equal(migrated.viewHeights["replay-capabilities"], 300);
  assert.match(
    storage.getItem("candlescope-replay-workspace:legacy-empty") ?? "",
    /"schemaVersion":2/,
  );
});

test("workspace preferences preserve an intentional empty rail in schema v2", () => {
  const storage = new MemoryStorage();
  saveReplayWorkspacePreferences("current-empty", {
    railWidth: 360,
    openViewIds: [],
    panelCollapsed: false,
    viewHeights: {},
  }, storage);

  const restored = loadReplayWorkspacePreferences("current-empty", storage);

  assert.deepEqual(restored.openViewIds, []);
  assert.equal(restored.panelCollapsed, false);
  assert.match(
    storage.getItem("candlescope-replay-workspace:current-empty") ?? "",
    /"schemaVersion":2/,
  );
});

test("replay modular rail panels fill their host instead of overflowing stored heights", () => {
  const marketRail = source("src/features/replay/components/ReplayRightMarketRail.tsx");
  const styles = source("src/index.css");
  assert.match(marketRail, /style=\{\{ height: "100%" \}\}/);
  assert.doesNotMatch(marketRail, /style=\{\{ height \}\}/);
  assert.match(marketRail, /viewHeights=\{preferences\.viewHeights\}/);
  assert.match(marketRail, /openViewIds=\{preferences\.openViewIds\}/);
  assert.match(marketRail, /panelCollapsed=\{preferences\.panelCollapsed\}/);
  assert.match(marketRail, /onTogglePanelCollapsed=\{actions\.togglePanelCollapsed\}/);
  assert.match(styles, /\.replay-market-dock\[data-active-dock="paper"\] \.replay-market-dock-body \{\s*overflow: auto;/);
});

test("archive cleanup removes only deleted replay workspace scopes", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-sidebar-width", "410");
  storage.setItem("candlescope-replay-workspace:adapter-1", "{}");
  storage.setItem("candlescope-replay-workspace:adapter-2", "{}");

  clearReplayWorkspacePreferences(
    ["adapter-1", "adapter-1", "  "],
    storage,
  );

  assert.equal(storage.getItem("candlescope-replay-workspace:adapter-1"), null);
  assert.equal(storage.getItem("candlescope-replay-workspace:adapter-2"), "{}");
  assert.equal(storage.getItem("candlescope-sidebar-width"), "410");
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

test("toolbar keeps idle time visible and scopes progress to an active cancelable advance", () => {
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const styles = source("src/index.css");

  assert.match(controls, /const cancelableAdvancePending = replayAdvanceIsCancelable\(/);
  assert.match(controls, /\{cancelableAdvancePending && \(\s*<span className="replay-advance-progress"/s);
  assert.match(controls, /aria-label="本次推进进度"/);
  assert.match(controls, /advanceProgress === null \? "准备中…"/);
  assert.doesNotMatch(controls, /aria-label="回放进度"|持续训练|domainProgress/);
  assert.match(styles, /\.replay-advance-progress \{/);
});

test("toolbar bounds exact source-event advances to one interruptible batch", () => {
  const controls = source("src/features/replay/components/ReplayControlBar.tsx");
  const limits = source("src/features/replay/replayAdvanceLimits.ts");

  assert.match(limits, /SOURCE_EVENT_MAX_MANUAL_COUNT = 128/);
  assert.match(
    controls,
    /advanceBasis === "SOURCE_EVENT"\s*\? Math\.min\(globalMaxAdvanceCount, SOURCE_EVENT_MAX_MANUAL_COUNT\)/,
  );
  assert.match(controls, /const boundedAdvanceAmount = boundedReplayAdvanceAmount\(/);
  assert.match(controls, /value=\{boundedAdvanceAmount\}/);
  assert.match(controls, /submitCanonicalAdvance\(advanceBasis, boundedAdvanceAmount\)/);
  assert.doesNotMatch(controls, /value=\{advanceAmount\}/);
  assert.equal(boundedReplayAdvanceAmount(100_000, "SOURCE_EVENT", 100_000), 128);
  assert.equal(boundedReplayAdvanceAmount(100_000, "BASE_BAR", 100_000), 100_000);
  assert.equal(boundedReplayAdvanceAmount(0, "SOURCE_EVENT", 100_000), 1);
});

function replayControlBarMarkup({
  controlPending = null,
  progress = null,
}: {
  readonly controlPending?: Readonly<Record<string, unknown>> | null;
  readonly progress?: Readonly<Record<string, unknown>> | null;
} = {}): string {
  const runtime = {
    clientInstanceId: "browser-1",
    pendingCommand: null,
    commandError: null,
    commandRecoveryPending: false,
    commandRecoveryReady: false,
    commandRecoveryInFlight: false,
    store: {
      sessionConfig: {
        source_kind: "bar",
        base_interval: "1m",
        blind_mode: true,
      },
      controllerClientId: "browser-1",
      state: "PAUSED",
      connectionState: "connected",
      virtualTimeMs: 1_710_000_000_000,
      replayStartMs: 1_710_000_000_000,
      error: null,
    },
    actions: {},
  };
  const viewer = {
    controlPending,
    marketTracks: null,
    viewerState: null,
    viewerPending: false,
    progress,
    periodSummary: null,
    summaryPreparing: false,
    summaryError: null,
    actions: {},
  };
  return renderToStaticMarkup(
    <ReplayControlBar
      runtime={runtime as never}
      viewer={viewer as never}
      publicTimeLabel="D+0 T+00:00:00"
    />,
  );
}

test("idle toolbar renders no progressbar and active virtual-time advance renders only command progress", () => {
  const idle = replayControlBarMarkup();
  assert.match(idle, /data-replay-progress="hidden"/);
  assert.match(idle, /class="replay-public-time">D\+0 T\+00:00:00/);
  assert.doesNotMatch(idle, /<progress|本次推进|持续训练/);

  const controlPending = {
    type: "advance",
    payload: { basis: "VIRTUAL_TIME", duration_ms: 60_000 },
  };
  const preparing = replayControlBarMarkup({ controlPending });
  assert.match(preparing, /data-replay-progress="unknown"/);
  assert.match(preparing, /data-replay-command-progress="active"/);
  assert.match(preparing, /aria-label="本次推进进度"/);
  assert.match(preparing, /准备中…/);

  const running = replayControlBarMarkup({
    controlPending,
    progress: { ratio_ppm: 250_000 },
  });
  assert.match(running, /data-replay-progress="0\.2500"/);
  assert.match(running, /value="0\.25"/);
  assert.match(running, /25\.0%/);
});
