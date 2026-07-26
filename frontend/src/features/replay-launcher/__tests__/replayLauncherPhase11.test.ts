import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enabledCapabilities } from "../../replay/__tests__/fixtures.js";
import { parseReplayCapabilities, parseReplayCatalog } from "../../replay/replayParser.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
} from "../../replay/trainingHubModel.js";
import { buildLiveReplayLaunchContext } from "../replayLaunchContext.js";


function blindCatalog() {
  const epoch = `sha256:${"a".repeat(64)}`;
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: epoch,
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: true,
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 50,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: epoch,
      bounds: null,
      eligible_ranges: [],
    }],
  });
}

test("Phase 11 snapshots live identity and structured watchlist without local persistence reads", () => {
  const context = buildLiveReplayLaunchContext({
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    displayInterval: "15m",
    watchlists: [
      {
        id: "majors",
        name: " 主流币 ",
        color: "#3b82f6",
        symbols: ["spot:BTCUSDT", "spot:ETHUSDT", "spot:ETHUSDT"],
      },
      {
        id: "unsafe group id",
        name: "跨市场",
        color: "#8b5cf6",
        symbols: ["okx:swap:BTC-USDT-SWAP"],
      },
    ],
  });

  assert.equal(context.source, "LIVE_PAGE");
  assert.equal(context.display_interval, "15m");
  assert.deepEqual(context.watchlist_snapshot.groups[0], {
    id: "majors",
    name: "主流币",
    color: "#3b82f6",
    items: [
      { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      { exchange: "binance", market_type: "spot", symbol: "ETHUSDT" },
    ],
  });
  assert.equal(context.watchlist_snapshot.groups[1]?.id, "live_group_2");
  assert.equal(
    context.watchlist_snapshot.groups[1]?.items[0]?.symbol,
    "BTC-USDT-SWAP",
  );

  const maximumId = "a".repeat(128);
  const duplicateIds = buildLiveReplayLaunchContext({
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    displayInterval: "1m",
    watchlists: [
      { id: maximumId, name: "一", color: "#111111", symbols: [] },
      { id: maximumId, name: "二", color: "#222222", symbols: [] },
    ],
  }).watchlist_snapshot.groups.map((group) => group.id);
  assert.deepEqual(duplicateIds, [maximumId, "live_group_2"]);
  assert.ok(duplicateIds.every((id) => id.length <= 128));

  const okxContext = buildLiveReplayLaunchContext({
    exchange: "okx",
    marketType: "futures",
    symbol: "BTC-USDT-SWAP",
    displayInterval: "15m",
    watchlists: [],
  });
  assert.equal(okxContext.symbol, "BTC-USDT-SWAP");
});

test("Phase 11 preselects the live chart and carries its snapshot only on create", () => {
  const catalog = blindCatalog();
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const context = buildLiveReplayLaunchContext({
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    displayInterval: "15m",
    watchlists: [{
      id: "default",
      name: "Watchlist",
      color: "#3b82f6",
      symbols: ["spot:ETHUSDT"],
    }],
  });
  const draft = createTrainingRunDraft(catalog, context);
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog);

  assert.equal(draft.symbol, "BTCUSDT");
  assert.equal(draft.baseInterval, "1m");
  assert.equal(draft.displayInterval, "15m");
  assert.equal(evaluation.canSubmit, true);
  const payload = buildTrainingRunCreateRequest(
    draft,
    evaluation,
    catalog,
    context,
  );
  assert.deepEqual(payload.launch_context, context);
  assert.equal(payload.symbol, context.symbol);
  assert.equal(payload.display_interval, context.display_interval);

  const directPayload = buildTrainingRunCreateRequest(draft, evaluation, catalog);
  assert.equal(Object.hasOwn(directPayload, "launch_context"), false);
});

test("Phase 11 live launcher is lazy, modal, and preserves the isolated v1 fallback", () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const frontendRoot = resolve(testDirectory, "../../../..");
  const source = (path: string) => readFileSync(resolve(frontendRoot, path), "utf8");
  const app = source("src/app/App.tsx");
  const topBar = source("src/app/TopBar.tsx");
  const launcher = source("src/features/replay-launcher/ReplayLauncherDialog.tsx");
  const trainingHub = source("src/features/replay/components/TrainingHubDialog.tsx");
  const watchlist = source("src/features/replay/components/ReplayWatchlistPanel.tsx");

  assert.match(app, /lazy\(loadReplayLauncherDialog\)/);
  assert.match(app, /showReplayLauncher\s*\?\s*buildLiveReplayLaunchContext/);
  assert.match(topBar, /REPLAY_PRODUCT_V2_ENABLED/);
  assert.match(topBar, /onClick=\{onOpenReplayLauncher\}/);
  assert.match(topBar, /href=\{replayEntry\.href\}/);
  assert.match(topBar, /target="_blank"/);
  assert.match(topBar, /rel="noopener noreferrer"/);
  assert.match(topBar, /K 线回放 ↗/);
  assert.match(launcher, /presentation="modal"/);
  assert.match(launcher, /window\.open\("about:blank", "_blank"\)/);
  assert.match(launcher, /pendingReplayWindowRef/);
  assert.match(launcher, /migrateLegacy: async/);
  assert.match(launcher, /reserveReplayWindow\(\)/);
  assert.match(launcher, /child\.opener = null/);
  assert.match(launcher, /location\.replace\(url\)/);
  assert.match(launcher, /previousFocus\?\.focus\(\)/);
  assert.doesNotMatch(
    launcher,
    /useMarketDataRuntime|useWatchlistRuntime|ReplayRuntime|replayBars|WebSocket/,
  );
  assert.match(trainingHub, /replayCatalogIdentity\(candidate\) === identity/);
  assert.match(trainingHub, /value=\{`\$\{draft\.exchange\}:\$\{draft\.marketType\}:\$\{draft\.symbol\}`\}/);
  assert.match(watchlist, /launch_context\.watchlist_snapshot\.groups/);
  assert.doesNotMatch(watchlist, /localStorage|candlescope-watchlists/);
});
