import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TrainingHubDialog, {
  TrainingRunDeleteConfirmation,
} from "../components/TrainingHubDialog.js";
import { ReplayV2ApiClient, ReplayV2ApiError } from "../replayV2Api.js";
import { selectReplayInitialMarketWithEpochRetry } from "../replayInitialMarket.js";
import {
  buildTrainingRunCreateRequest,
  buildTrainingRunPreparationRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
  evaluateTrainingRunSetupDraft,
} from "../trainingHubModel.js";
import { returnToTrainingHub } from "../trainingHubNavigation.js";
import {
  TrainingHubLifecycle,
  type TrainingHubRuntime,
} from "../useTrainingHub.js";
import {
  parseTrainingRunDeleteResponse,
  parseTrainingRunListResponse,
  parseTrainingRunMarketSelectionResponse,
  parseTrainingRunMutationResponse,
  parseTrainingRunReturnResponse,
} from "../replayV2Types.js";
import { parseReplaySegmentPreparePlan } from "../replaySegmentTypes.js";
import { parseReplayCapabilities, parseReplayCatalog } from "../replayParser.js";
import { enabledCapabilities } from "./fixtures.js";


function runCard(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-1",
    kind: "V2",
    name: "BTC 手动训练",
    state: "PAUSED",
    source_kind: "BAR",
    integrity_mode: "CHALLENGE",
    time_disclosure_policy: "HIDE_ALL",
    last_symbol: "BTCUSDT",
    subscribed_track_count: 1,
    progress: { source_sequence: 12 },
    equity: "10000",
    equity_status: "CURRENT",
    settlement_asset: "USDT",
    updated_at_ms: 1_800_000_000_000,
    compatibility: "READY",
    resume_action: "OPEN_ADAPTER",
    adapter_session_id: "adapter-1",
    status: { code: "READY", message: "训练可继续" },
    report_available: false,
    review_available: false,
    ...overrides,
  };
}

function listResponse(items = [runCard()], nextCursor: string | null = null) {
  return {
    protocol: "replay.v3",
    schema_version: "replay.training.v2",
    items,
    next_cursor: nextCursor,
  };
}

function mutationResponse() {
  return {
    protocol: "replay.v3",
    created: true,
    run: runCard(),
  };
}

function segmentPlanResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "replay.data.prepare.v1",
    state: "PREPARE_ON_CREATE",
    source_kind: "BAR",
    identity: {
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      base_interval: "1m",
    },
    estimated_size_bytes: 394_560,
    estimated_rows: 1_641,
    history_policy: {
      schema_version: "replay.data-policy.v1",
      indicator_warmup_bars: 200,
      visible_history_lookback: {
        mode: "DURATION",
        duration_ms: 12_000_000,
      },
      visible_history_rows_estimate: 200,
      effective_warmup_bars_estimate: 200,
      forward_cache_ms: 86_400_000,
      forward_rows_estimate: 1_440,
      estimate_kind: "EXACT",
      max_dataset_rows: 250_000,
      accepted: true,
      blocked_reason: null,
    },
    prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE",
    existing_ready_segments: 1,
    existing_ready_bytes: 380_000,
    selection_loads_history: false,
    create_loads_only_selected_range: true,
    download_worker_enabled: false,
    auto_gc_enabled: false,
    failure_policy: "QUARANTINE_AND_FAIL_CLOSED",
    historical_book: {
      feature_enabled: false,
      requested_mode: "OFF",
      capability_state: "UNSUPPORTED_NO_HISTORY",
      reason: "FEATURE_DISABLED",
      source: "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1",
      snapshot_and_ordered_deltas: false,
      continuity_contract: "SNAPSHOT_BRIDGE_AND_U_u_pu",
      pinnable: false,
      queue_exact: false,
      execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
      ready_archive_bytes: 0,
      max_archive_bytes: 1_099_511_627_776,
    },
    account_history: {
      protocol: "replay.account-history.archive.v1",
      feature_enabled: false,
      requested_mode: "APPROX_PROXY",
      capability_state: "UNSUPPORTED_NO_HISTORY",
      reason: "FEATURE_DISABLED",
      fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      supported_contract_model: "LINEAR_QUOTE_SETTLED_V1",
      supported_position_mode: "ONE_WAY",
      supported_margin_asset_mode: "SINGLE_QUOTE",
      historical_funding_exact: false,
      public_kline_proxy_accepted: false,
      ready_archive_bytes: 0,
      max_archive_bytes: 137_438_953_472,
      coverage: null,
      account_history_ref: null,
    },
    hedge_inputs: {
      schema_version: "replay.hedge-input-plan.v1",
      feature_enabled: true,
      requested_position_mode: "ONE_WAY",
      capability_state: "NOT_REQUIRED",
      reason: "POSITION_MODE_ONE_WAY",
      public_fidelity: "PINNED_HISTORICAL_PUBLIC_INPUT",
      private_fidelity: "VERSIONED_DETERMINISTIC_SIMULATION",
      historical_exchange_private_state: false,
      fallback_applied: false,
      coverage: null,
      historical_l2_ref: null,
      hedge_public_history_ref: null,
      simulation_manifest_ref: null,
    },
    ...overrides,
  };
}

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

function hedgeCatalog() {
  const epoch = `sha256:${"a".repeat(64)}`;
  const startMs = 1_710_000_000_000;
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: epoch,
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: false,
    entries: [{
      identity: { exchange: "binance", market_type: "futures", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 1,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: epoch,
      bounds: {
        earliest_open_ms: startMs - 200 * 60_000,
        latest_source_open_ms: startMs + 1_440 * 60_000,
        latest_closed_open_ms: startMs + 1_440 * 60_000,
        total_count: 1_641,
      },
      gap_summary: {
        gaps: [],
        gap_count: 0,
        missing_bars: 0,
        scanned_bars: 1_641,
        scan_calls: 1,
        calendar_id: "continuous",
      },
      source_fingerprint: `sha256:${"b".repeat(64)}`,
      eligible_ranges: [{
        interval: "1m",
        interval_ms: 60_000,
        first_start_ms: startMs,
        last_start_ms: startMs,
        count: 1,
        warmup_bars: 200,
        replay_bars: 1_440,
      }],
    }],
  });
}

test("initial market selection replans exactly once after capability epoch drift", async () => {
  const initialCatalog = blindCatalog();
  const refreshedEpoch: `sha256:${string}` = `sha256:${"b".repeat(64)}`;
  const refreshedCatalog = {
    ...initialCatalog,
    catalog_epoch: refreshedEpoch,
    entries: initialCatalog.entries.map((entry) => ({
      ...entry,
      catalog_epoch: refreshedEpoch,
    })),
  };
  const plannedEpochs: string[] = [];
  const selectedEpochs: string[] = [];
  let catalogRefreshes = 0;
  const result = await selectReplayInitialMarketWithEpochRetry({
    runId: "run-1",
    catalog: initialCatalog,
    entry: initialCatalog.entries[0]!,
    api: {
      async marketCatalog() {
        catalogRefreshes += 1;
        return refreshedCatalog;
      },
      async planInitialMarket(_runId, selection) {
        plannedEpochs.push(selection.catalog_epoch);
        return parseReplaySegmentPreparePlan(segmentPlanResponse());
      },
      async selectInitialMarket(_runId, selection) {
        selectedEpochs.push(selection.catalog_epoch);
        if (selectedEpochs.length === 1) {
          throw new ReplayV2ApiError(
            "CATALOG_EPOCH_MISMATCH",
            "data capability changed after validation; refresh and try again",
            { status: 409 },
          );
        }
        return parseTrainingRunMarketSelectionResponse({
          protocol: "replay.v3",
          initialized: true,
          run: runCard(),
        });
      },
    },
  });

  assert.equal(result.catalogRefreshes, 1);
  assert.equal(result.catalog.catalog_epoch, refreshedEpoch);
  assert.equal(result.response.run.run_id, "run-1");
  assert.equal(catalogRefreshes, 1);
  assert.deepEqual(plannedEpochs, [initialCatalog.catalog_epoch, refreshedEpoch]);
  assert.deepEqual(selectedEpochs, [initialCatalog.catalog_epoch, refreshedEpoch]);
});

function exactHedgeInputPlan() {
  return {
    schema_version: "replay.hedge-input-plan.v1",
    feature_enabled: true,
    requested_position_mode: "HEDGE",
    capability_state: "AVAILABLE_EXACT",
    reason: "CROSS_VERIFIED_PINNED_PUBLIC_AND_SIMULATION_INPUTS",
    public_fidelity: "PINNED_HISTORICAL_PUBLIC_INPUT",
    private_fidelity: "VERSIONED_DETERMINISTIC_SIMULATION",
    historical_exchange_private_state: false,
    fallback_applied: false,
    coverage: {
      range_start_ms: 1_710_000_000_000,
      range_end_ms: 1_710_086_400_000,
    },
    historical_l2_ref: {
      archive_id: "book-btc-202403",
      dataset_epoch: `sha256:${"b".repeat(64)}`,
      checksum_sha256: `sha256:${"c".repeat(64)}`,
    },
    hedge_public_history_ref: {
      schema_version: "replay.hedge-public-history-ref.v1",
      archive_id: "public-btc-202403",
      dataset_epoch: `sha256:${"d".repeat(64)}`,
      checksum_sha256: `sha256:${"e".repeat(64)}`,
    },
    simulation_manifest_ref: {
      schema_version: "replay.hedge-simulation-manifest-ref.v1",
      manifest_id: "simulation-btc-202403",
      dataset_epoch: `sha256:${"f".repeat(64)}`,
      checksum_sha256: `sha256:${"1".repeat(64)}`,
      contract_hash: `sha256:${"2".repeat(64)}`,
      model_version: "BINANCE_USDM_LINEAR_HEDGE_DETERMINISTIC_SIMULATION_V1",
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Phase 1 run list and mutation parsers reject unknown fields and blind history leaks", () => {
  const parsed = parseTrainingRunListResponse(listResponse());
  assert.equal(parsed.items[0]?.run_id, "run-1");
  assert.equal(parseTrainingRunMutationResponse(mutationResponse()).run.adapter_session_id, "adapter-1");
  assert.equal(
    parseTrainingRunListResponse(listResponse([runCard({ equity: "-11.434960416" })]))
      .items[0]?.equity,
    "-11.434960416",
  );

  assert.throws(() => parseTrainingRunListResponse({ ...listResponse(), future: true }));
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ dataset_epoch: `sha256:${"b".repeat(64)}` }),
  ])));
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ progress: { source_sequence: 12, actual_start_ms: 1_710_000_000_000 } }),
  ])));
});

test("run-list API is bounded to /runs and never requests sessions or datasets", async () => {
  const urls: string[] = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(listResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const listed = await client.listRuns({ limit: 50, compatibility: "READY" });
  assert.equal(listed.items.length, 1);
  assert.deepEqual(urls, ["/api/v1/replay/runs?limit=50&compatibility=READY"]);
  assert.doesNotMatch(urls.join("\n"), /sessions|dataset|catalog/);
});

test("run-delete API uses the bounded archive route and strict response parser", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({
        protocol: "replay.v3",
        deleted: true,
        run_id: "run-1",
        session_ids: ["adapter-1", "adapter-track-2"],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const deleted = await client.deleteRun("run-1");
  assert.deepEqual(deleted, parseTrainingRunDeleteResponse({
    protocol: "replay.v3",
    deleted: true,
    run_id: "run-1",
    session_ids: ["adapter-1", "adapter-track-2"],
  }));
  assert.deepEqual(requests, [{ url: "/api/v1/replay/runs/run-1", method: "DELETE" }]);
  assert.throws(() => parseTrainingRunDeleteResponse({
    protocol: "replay.v3",
    deleted: true,
    run_id: "run-1",
  }));
  assert.throws(() => parseTrainingRunDeleteResponse({
    protocol: "replay.v3",
    deleted: true,
    run_id: "run-1",
    session_ids: ["adapter-1", "adapter-1"],
  }));
});

test("Hub clears the run and every server-returned session scope after a matching archive delete", async (context) => {
  const cleared: Array<{ runId: string; sessionIds: string[] }> = [];
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        return parseTrainingRunListResponse(listResponse());
      },
      async capabilities() {
        throw new Error("not used");
      },
      async catalog() {
        throw new Error("not used");
      },
      async createRun() {
        throw new Error("not used");
      },
      async deleteRun() {
        return parseTrainingRunDeleteResponse({
          protocol: "replay.v3",
          deleted: true,
          run_id: "run-1",
          session_ids: ["adapter-1", "adapter-track-2"],
        });
      },
    },
    clearDeletedRunState: (runId, sessionIds) => {
      cleared.push({ runId, sessionIds: [...sessionIds] });
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();

  await lifecycle.deleteRun("run-1");

  assert.deepEqual(cleared, [{
    runId: "run-1",
    sessionIds: ["adapter-1", "adapter-track-2"],
  }]);
  assert.deepEqual(lifecycle.getSnapshot().items, []);
  assert.equal(lifecycle.getSnapshot().operation, null);
});

test("Phase 7 prepare-plan parser is exact and preserves fail-closed worker flags", () => {
  const parsed = parseReplaySegmentPreparePlan(segmentPlanResponse());
  assert.equal(parsed.prepare_action, "SNAPSHOT_LOCAL_BAR_RANGE");
  assert.equal(parsed.selection_loads_history, false);
  assert.equal(parsed.create_loads_only_selected_range, true);
  assert.equal(parsed.download_worker_enabled, false);
  assert.equal(parsed.auto_gc_enabled, false);
  assert.throws(() => parseReplaySegmentPreparePlan(segmentPlanResponse({ future: true })));
  assert.throws(() => parseReplaySegmentPreparePlan(segmentPlanResponse({
    failure_policy: "FALLBACK",
  })));
});

test("segment plan uses the selected create contract and never opens a dataset endpoint", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(segmentPlanResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const catalog = blindCatalog();
  const draft = {
    ...createTrainingRunDraft(catalog),
    positionMode: "ONE_WAY" as const,
    accountDataMode: "APPROX_PROXY" as const,
    fundingMode: "OFF" as const,
    bookMode: "OFF" as const,
    startMode: "RANDOM" as const,
    requestedStartMs: null,
    randomRangeStartMs: Date.UTC(2020, 0, 1),
    randomRangeEndMs: Date.UTC(2020, 0, 2),
    timeDisclosurePolicy: "HIDE_ALL" as const,
  };
  const evaluation = evaluateTrainingRunDraft(
    draft,
    parseReplayCapabilities(enabledCapabilities()),
    catalog,
  );
  const payload = buildTrainingRunPreparationRequest(draft, evaluation, catalog);
  await client.segmentPlan(payload);
  assert.deepEqual(requests, [{
    url: "/api/v1/replay/runs/data-segments/plan",
    body: payload,
  }]);
  assert.doesNotMatch(requests[0]?.url ?? "", /sessions|snapshot_blob/);
});

test("Hub creates an empty run without planning a market dataset", async (context) => {
  const calls: string[] = [];
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        calls.push("runs");
        return parseTrainingRunListResponse(listResponse([]));
      },
      async capabilities() {
        calls.push("capabilities");
        return parseReplayCapabilities(enabledCapabilities());
      },
      async catalog() {
        calls.push("catalog");
        return blindCatalog();
      },
      async segmentPlan() {
        calls.push("segment-plan");
        return parseReplaySegmentPreparePlan(segmentPlanResponse());
      },
      async createRun() {
        calls.push("create");
        return parseTrainingRunMutationResponse(mutationResponse());
      },
    },
    navigateToRun: (runId) => calls.push(`navigate:${runId}`),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.deepEqual(calls, ["runs"]);
  await lifecycle.openCreate();
  assert.deepEqual(calls, ["runs", "capabilities"]);
  assert.equal(lifecycle.getSnapshot().segmentPlan, null);
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  await lifecycle.createRun(draft);
  assert.deepEqual(calls.slice(-2), ["create", "navigate:run-1"]);
});

test("hub bootstrap loads only lightweight saves; create capability work starts on demand", async (context) => {
  const calls: string[] = [];
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        calls.push("runs");
        return parseTrainingRunListResponse(listResponse());
      },
      async capabilities() {
        calls.push("capabilities");
        return parseReplayCapabilities(enabledCapabilities());
      },
      async catalog() {
        calls.push("catalog");
        return blindCatalog();
      },
      async createRun() {
        calls.push("create");
        return parseTrainingRunMutationResponse(mutationResponse());
      },
    },
    navigateToRun: (runId) => calls.push(`navigate:${runId}`),
  });
  context.after(() => lifecycle.dispose());

  lifecycle.start();
  await settle();
  assert.deepEqual(calls, ["runs"]);
  assert.equal(lifecycle.getSnapshot().phase, "READY");

  await lifecycle.openCreate();
  assert.deepEqual(calls, ["runs", "capabilities"]);
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  await lifecycle.createRun(draft);
  assert.deepEqual(calls, [
    "runs",
    "capabilities",
    "create",
    "navigate:run-1",
  ]);
});

test("create errors stay visible and reopening refreshes setup context without losing edits", async (context) => {
  let catalogCalls = 0;
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        return parseTrainingRunListResponse(listResponse([]));
      },
      async capabilities() {
        return parseReplayCapabilities(enabledCapabilities());
      },
      async catalog() {
        catalogCalls += 1;
        return blindCatalog();
      },
      async createRun() {
        throw new ReplayV2ApiError(
          "CATALOG_EPOCH_MISMATCH",
          "data capability changed after validation; refresh and try again",
          { status: 409 },
        );
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  await lifecycle.openCreate();
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  const preservedDraft = {
    ...draft,
    name: "保留这份训练",
    indicatorWarmupBars: 300,
  };
  lifecycle.setDraft(preservedDraft);
  await lifecycle.createRun(preservedDraft);
  assert.equal(lifecycle.getSnapshot().error?.code, "CATALOG_EPOCH_MISMATCH");
  await lifecycle.openCreate();
  assert.equal(catalogCalls, 0);
  assert.equal(lifecycle.getSnapshot().error, null);
  assert.equal(lifecycle.getSnapshot().draft?.name, "保留这份训练");
  assert.equal(lifecycle.getSnapshot().draft?.indicatorWarmupBars, 300);
});

test("create posts market-independent setup and defers catalog refresh to the run", async (context) => {
  const catalogQueries: Array<{ warmupBars?: number; horizonMs?: number; blindMode?: boolean }> = [];
  let submitted: Record<string, unknown> | null = null;
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        return parseTrainingRunListResponse(listResponse([]));
      },
      async capabilities() {
        return parseReplayCapabilities(enabledCapabilities());
      },
      async catalog(query) {
        catalogQueries.push(query ?? {});
        const catalog = blindCatalog();
        return catalog;
      },
      async createRun(payload) {
        submitted = { ...payload };
        return parseTrainingRunMutationResponse(mutationResponse());
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  await lifecycle.openCreate();
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  const edited = {
    ...draft,
    indicatorWarmupBars: 300,
    forwardCacheMs: 43_200_000,
  };
  lifecycle.setDraft(edited);
  await lifecycle.createRun(edited);
  assert.equal(catalogQueries.length, 0);
  assert.ok(submitted);
  const submittedPayload = submitted as unknown as Record<string, unknown>;
  assert.equal(submittedPayload.indicator_warmup_bars, 300);
  assert.equal(submittedPayload.forward_cache_ms, 43_200_000);
  assert.equal(submittedPayload.random_range_start_ms, edited.randomRangeStartMs);
  assert.equal(submittedPayload.random_range_end_ms, edited.randomRangeEndMs);
  assert.equal(Object.hasOwn(submittedPayload, "catalog_epoch"), false);
  assert.equal(Object.hasOwn(submittedPayload, "symbol"), false);
});

test("create model covers Phase 6 account fields and exposes fail-closed boundaries", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = hedgeCatalog();
  const draft = createTrainingRunDraft(catalog);
  const evaluation = evaluateTrainingRunSetupDraft(draft, capabilities);
  assert.equal(evaluation.canSubmit, true);
  assert.deepEqual(evaluation.unsupported, {
    account_history: "精确账户只接受服务端已校验并固定的 mark/index/funding/规则归档；公开 K 线代理不算 exact",
    funding: "HEDGE 可使用 pinned historical funding；事件、同刻 mark 或规则覆盖不完整时 fail closed",
    historical_l2: "仅连续、可 pin、已验证的 Binance USD-M 历史 L2 可开启；不含真实盘口排队",
    rule_changes: "费率、杠杆与 Sandbox 固定资金费可按白名单审计变更",
    isolated_margin: "CROSS 与 ISOLATED 均可用；逐仓开仓前必须显式分配保证金",
  });
  const request = buildTrainingRunCreateRequest(draft, evaluation);
  assert.equal(request.protocol, "replay.v3");
  assert.equal(Object.hasOwn(request, "catalog_epoch"), false);
  assert.equal(Object.hasOwn(request, "symbol"), false);
  assert.equal(request.time_disclosure_policy, "NONE");
  assert.equal(request.requested_start_ms, draft.requestedStartMs);
  assert.equal(request.random_range_start_ms, null);
  assert.equal(request.random_range_end_ms, null);
  assert.equal(request.integrity_mode, "CHALLENGE");
  assert.equal(request.funding_mode, "HISTORICAL_EXACT");
  assert.equal(request.account_data_mode, "DETERMINISTIC_SIMULATION");
  assert.equal(request.fixed_funding_rate, null);
  assert.equal(request.funding_interval_ms, null);
  assert.equal(request.book_mode, "OFF");
  assert.equal(request.margin_mode, "CROSS");
  assert.equal(request.position_mode, "HEDGE");
  assert.equal(request.allow_rule_changes, false);
  assert.deepEqual(request.allowed_mutations, []);
});

test("HEDGE create model rejects Sandbox funding and keeps pinned historical inputs", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = hedgeCatalog();
  const base = createTrainingRunDraft(catalog);
  const sandbox = {
    ...base,
    integrityMode: "SANDBOX" as const,
    marginMode: "ISOLATED" as const,
    fundingMode: "SANDBOX_FIXED" as const,
    fixedFundingRate: "-0.0001",
    fundingIntervalMs: 28_800_000,
  };
  const sandboxEvaluation = evaluateTrainingRunSetupDraft(sandbox, capabilities);
  assert.equal(sandboxEvaluation.canSubmit, false);
  assert.match(sandboxEvaluation.errors.join("\n"), /历史资金费/);

  const exactPlan = parseReplaySegmentPreparePlan(segmentPlanResponse({
    historical_book: {
      ...segmentPlanResponse().historical_book,
      feature_enabled: true,
      requested_mode: "BOOK_ASSISTED_REQUIRED",
      capability_state: "AVAILABLE_EXACT",
      reason: "VERIFIED_BINANCE_USDM_DIFF_DEPTH",
      snapshot_and_ordered_deltas: true,
      pinnable: true,
      ready_archive_bytes: 1_024,
    },
    account_history: {
      ...segmentPlanResponse().account_history,
      feature_enabled: true,
      requested_mode: "DETERMINISTIC_SIMULATION",
      reason: "NO_COMPLETE_PINNABLE_ARCHIVE",
    },
    hedge_inputs: exactHedgeInputPlan(),
  }));
  assert.equal(exactPlan.account_history.requested_mode, "DETERMINISTIC_SIMULATION");
  const exact = evaluateTrainingRunDraft(
    base,
    capabilities,
    catalog,
    exactPlan,
  );
  assert.equal(exact.canSubmit, true);
  const payload = buildTrainingRunPreparationRequest(base, exact, catalog);
  assert.deepEqual(
    payload.hedge_public_history_ref,
    exactPlan.hedge_inputs.hedge_public_history_ref,
  );
  assert.deepEqual(
    payload.simulation_manifest_ref,
    exactPlan.hedge_inputs.simulation_manifest_ref,
  );
});

test("HEDGE create mode is the default and accepts the exchange-parity policy matrix", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = hedgeCatalog();
  const base = createTrainingRunDraft(catalog);
  const hedge = { ...base, positionMode: "HEDGE" as const };
  const evaluation = evaluateTrainingRunSetupDraft(hedge, capabilities);
  assert.equal(evaluation.canSubmit, true);
  assert.equal(buildTrainingRunCreateRequest(hedge, evaluation).position_mode, "HEDGE");

  const randomHedge = {
    ...hedge,
    startMode: "RANDOM" as const,
    requestedStartMs: null,
    randomRangeStartMs: hedge.requestedStartMs,
    randomRangeEndMs: hedge.requestedStartMs,
    timeDisclosurePolicy: "HIDE_ALL" as const,
  };
  const randomEvaluation = evaluateTrainingRunSetupDraft(randomHedge, capabilities);
  assert.equal(randomEvaluation.canSubmit, true);
  const randomPayload = buildTrainingRunCreateRequest(randomHedge, randomEvaluation);
  assert.equal(randomPayload.start_mode, "RANDOM");
  assert.equal(randomPayload.requested_start_ms, null);
  assert.equal(randomPayload.position_mode, "HEDGE");

  for (const supported of [
    { ...hedge, marginMode: "ISOLATED" as const },
  ]) {
    assert.equal(evaluateTrainingRunSetupDraft(supported, capabilities).canSubmit, true);
  }
  assert.equal(evaluateTrainingRunSetupDraft({
    ...hedge,
    accountDataMode: "HISTORICAL_EXACT" as const,
  }, capabilities).canSubmit, false);
});

test("Phase 9 create model enables BOOK_ASSISTED only with an exact server plan", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = hedgeCatalog();
  const draft = {
    ...createTrainingRunDraft(catalog),
    startMode: "MANUAL" as const,
    requestedStartMs: 1_710_000_000_000,
    bookMode: "BOOK_ASSISTED_REQUIRED" as const,
  };
  const unavailable = evaluateTrainingRunDraft(draft, capabilities, catalog);
  assert.equal(unavailable.canSubmit, false);
  assert.match(unavailable.errors.join("\n"), /exact L2/);
  const exactBook = {
    feature_enabled: true,
    requested_mode: "BOOK_ASSISTED_REQUIRED",
    capability_state: "AVAILABLE_EXACT",
    reason: "VERIFIED_BINANCE_USDM_DIFF_DEPTH",
    source: "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1",
    snapshot_and_ordered_deltas: true,
    continuity_contract: "SNAPSHOT_BRIDGE_AND_U_u_pu",
    pinnable: true,
    queue_exact: false,
    execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
    ready_archive_bytes: 1_024,
    max_archive_bytes: 1_099_511_627_776,
  };
  const plan = parseReplaySegmentPreparePlan(segmentPlanResponse({
    historical_book: exactBook,
    hedge_inputs: exactHedgeInputPlan(),
  }));
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog, plan);
  assert.equal(evaluation.canSubmit, true);
  assert.equal(
    buildTrainingRunPreparationRequest(draft, evaluation, catalog).book_mode,
    "BOOK_ASSISTED_REQUIRED",
  );
});

test("hub markup exposes saves, native actions, filters and explicit unavailable capability reasons", () => {
  const catalog = blindCatalog();
  const draft = createTrainingRunDraft(catalog);
  const runtime = {
    phase: "READY",
    items: parseTrainingRunListResponse(listResponse([
      runCard(),
      runCard({
        run_id: "run-ended",
        name: "ETH 已结束训练",
        state: "ENDED",
        last_symbol: "ETHUSDT",
        adapter_session_id: "adapter-ended",
        status: { code: "READY", message: "STALE_ENDED_STATUS: 训练可继续" },
        report_available: true,
      }),
    ])).items,
    nextCursor: null,
    filters: { state: null, sourceKind: null, compatibility: null },
    operation: null,
    error: null,
    createOpen: true,
    capabilities: parseReplayCapabilities(enabledCapabilities()),
    catalog,
    draft,
    evaluation: evaluateTrainingRunDraft(
      draft,
      parseReplayCapabilities(enabledCapabilities()),
      catalog,
    ),
    segmentPlan: parseReplaySegmentPreparePlan(segmentPlanResponse()),
    storageOpen: false,
    storageInventory: null,
    storagePlan: null,
    storagePlanConfirmed: false,
    storageResult: null,
    actions: {
      refresh() {},
      loadNext() {},
      setFilters() {},
      openCreate() {},
      closeCreate() {},
      openStorage() {},
      closeStorage() {},
      refreshStorage() {},
      planStorageGc() {},
      confirmStoragePlan() {},
      runStorageGc() {},
      rehydrateStorageObject() {},
      setDraft() {},
      refreshCreatePlan() {},
      createRun() {},
      deleteRun() {},
      continueRun() {},
    },
  } satisfies TrainingHubRuntime;
  const html = renderToStaticMarkup(<TrainingHubDialog runtime={runtime} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /训练存档大厅/);
  assert.match(html, /BTC 手动训练/);
  assert.match(html, /继续训练/);
  const endedNameOffset = html.indexOf("ETH 已结束训练");
  const endedCardStart = html.lastIndexOf("<article", endedNameOffset);
  const endedCardEnd = html.indexOf("</article>", endedNameOffset);
  assert.notEqual(endedNameOffset, -1);
  assert.notEqual(endedCardStart, -1);
  assert.notEqual(endedCardEnd, -1);
  const endedCardHtml = html.slice(endedCardStart, endedCardEnd);
  assert.match(endedCardHtml, /训练已结束，可打开复盘/);
  assert.match(endedCardHtml, /打开复盘/);
  assert.doesNotMatch(endedCardHtml, /训练可继续|继续训练|STALE_ENDED_STATUS/);
  assert.match(html, /删除存档/);
  assert.match(html, /新建训练/);
  assert.match(html, /资金费.*HISTORICAL_EXACT/);
  assert.match(html, /完整性模式/);
  assert.match(html, /HIDE_MINUTE/);
  assert.match(html, /Practice 可审计变更白名单/);
  assert.match(html, /历史盘口.*连续、可 pin/);
  assert.match(html, /商品在 Run 内选择/);
  assert.match(html, /创建时不固定商品、交易所、市场类型、基础周期或数据集/);
  assert.match(html, /原子创建首条 MarketTrack/);
  assert.match(html, /历史 L2 与 pinned funding 默认属于可用产品能力/);
  assert.doesNotMatch(html, /DETERMINISTIC_SIMULATION[^<]*disabled|APPROX_PROXY[^<]*disabled/);
  assert.match(html, /公开 K 线代理不算 exact/);
  assert.match(html, /指标预热 BAR/);
  assert.match(html, /全部可用（默认，按需加载）/);
  assert.match(html, /像实时行情一样向左按需分页/);
  assert.match(html, /确认时间并创建 Run/);
  assert.match(html, /创建确认后 T0 永久不变/);
  assert.match(html, /不含真实盘口排队/);
  assert.doesNotMatch(html, /1710000000000|dataset_epoch|snapshot_blob/);
});

test("archive deletion uses an application-owned explicit confirmation dialog", () => {
  const card = parseTrainingRunListResponse(listResponse()).items[0];
  assert.ok(card);
  const html = renderToStaticMarkup(
    <TrainingRunDeleteConfirmation
      card={card}
      busy={false}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /永久删除训练存档/);
  assert.match(html, /BTC 手动训练/);
  assert.match(html, /取消/);
  assert.match(html, /确认永久删除/);
  assert.match(html, /本机工作区偏好/);
});

test("Hub parser rejects every retired v1 archive shape", () => {
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ kind: "LEGACY_V1", integrity_mode: null }),
  ])));
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ compatibility: "LEGACY_ADAPTER" }),
  ])));
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ resume_action: "OPEN_V1" }),
  ])));
  assert.throws(() => parseTrainingRunListResponse(listResponse([
    runCard({ parent_legacy_session_id: "adapter-old" }),
  ])));
});

test("return-to-hub waits for the server checkpoint before navigation", async () => {
  const calls: string[] = [];
  await returnToTrainingHub(
    "run-1",
    {
      async returnToHub(runId) {
        calls.push(`checkpoint:${runId}`);
        return {
          protocol: "replay.v3",
          run_id: "run-1",
          state: "PAUSED",
          checkpointed: true,
          released: true,
        };
      },
    },
    (url) => calls.push(`navigate:${url}`),
  );
  assert.deepEqual(calls, ["checkpoint:run-1", "navigate:/replay.html"]);
});

test("return-to-hub preserves terminal durable states and still navigates", async () => {
  for (const state of ["ENDED", "ERROR"] as const) {
    const parsed = parseTrainingRunReturnResponse({
      protocol: "replay.v3",
      run_id: `run-${state.toLowerCase()}`,
      state,
      checkpointed: true,
      released: true,
    });
    const calls: string[] = [];
    await returnToTrainingHub(
      parsed.run_id,
      { returnToHub: async () => parsed },
      (url) => calls.push(url),
    );
    assert.deepEqual(calls, ["/replay.html"]);
  }
  assert.throws(() => parseTrainingRunReturnResponse({
    protocol: "replay.v3",
    run_id: "run-playing",
    state: "PLAYING",
    checkpointed: true,
    released: true,
  }));
});
