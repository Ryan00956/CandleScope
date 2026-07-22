import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TrainingHubDialog from "../components/TrainingHubDialog.js";
import { resolveReplayProduct } from "../replayProduct.js";
import { ReplayV2ApiClient, ReplayV2ApiError } from "../replayV2Api.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
} from "../trainingHubModel.js";
import { returnToTrainingHub } from "../trainingHubNavigation.js";
import {
  TrainingHubLifecycle,
  type TrainingHubRuntime,
} from "../useTrainingHub.js";
import {
  parseTrainingRunListResponse,
  parseTrainingRunMutationResponse,
} from "../replayV2Types.js";
import { parseReplaySegmentPreparePlan } from "../replaySegmentTypes.js";
import type { ReplayDigest } from "../replayTypes.js";
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
    parent_legacy_session_id: null,
    status: { code: "READY", message: "训练可继续" },
    report_available: false,
    review_available: false,
    ...overrides,
  };
}

function listResponse(items = [runCard()], nextCursor: string | null = null) {
  return {
    protocol: "replay.v2",
    schema_version: "replay.training.v1",
    items,
    next_cursor: nextCursor,
  };
}

function mutationResponse() {
  return {
    protocol: "replay.v2",
    created: true,
    migrated: false,
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
    estimated_rows: 1_644,
    prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE",
    existing_ready_segments: 1,
    existing_ready_bytes: 380_000,
    selection_loads_history: false,
    create_loads_only_selected_range: true,
    download_worker_enabled: false,
    auto_gc_enabled: false,
    failure_policy: "QUARANTINE_AND_FAIL_CLOSED",
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

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Phase 1 run list and mutation parsers reject unknown fields and blind history leaks", () => {
  const parsed = parseTrainingRunListResponse(listResponse());
  assert.equal(parsed.items[0]?.run_id, "run-1");
  assert.equal(parseTrainingRunMutationResponse(mutationResponse()).run.adapter_session_id, "adapter-1");

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
  const draft = createTrainingRunDraft(catalog);
  const evaluation = evaluateTrainingRunDraft(
    draft,
    parseReplayCapabilities(enabledCapabilities()),
    catalog,
  );
  const payload = buildTrainingRunCreateRequest(draft, evaluation, catalog);
  await client.segmentPlan(payload);
  assert.deepEqual(requests, [{
    url: "/api/v1/replay/runs/data-segments/plan",
    body: payload,
  }]);
  assert.doesNotMatch(requests[0]?.url ?? "", /sessions|snapshot_blob/);
});

test("Hub loads a segment plan only after create opens and refreshes it before create", async (context) => {
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
      async migrateLegacy() {
        throw new Error("not used");
      },
    },
    navigateToSession: (sessionId) => calls.push(`navigate:${sessionId}`),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.deepEqual(calls, ["runs"]);
  await lifecycle.openCreate();
  assert.deepEqual(calls, ["runs", "capabilities", "catalog", "segment-plan"]);
  assert.equal(lifecycle.getSnapshot().segmentPlan?.failure_policy, "QUARANTINE_AND_FAIL_CLOSED");
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  await lifecycle.createRun(draft);
  assert.deepEqual(calls.slice(-4), ["catalog", "segment-plan", "create", "navigate:adapter-1"]);
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
      async migrateLegacy() {
        throw new Error("not used");
      },
    },
    navigateToSession: (sessionId) => calls.push(`navigate:${sessionId}`),
  });
  context.after(() => lifecycle.dispose());

  lifecycle.start();
  await settle();
  assert.deepEqual(calls, ["runs"]);
  assert.equal(lifecycle.getSnapshot().phase, "READY");

  await lifecycle.openCreate();
  assert.deepEqual(calls, ["runs", "capabilities", "catalog"]);
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  await lifecycle.createRun(draft);
  assert.deepEqual(calls, [
    "runs",
    "capabilities",
    "catalog",
    "catalog",
    "create",
    "navigate:adapter-1",
  ]);
});

test("catalog drift stays rejected and an explicit revalidation reloads create context", async (context) => {
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
      async migrateLegacy() {
        throw new Error("not used");
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  await lifecycle.openCreate();
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  const preservedDraft = { ...draft, name: "保留这份训练", warmupBars: 300 };
  lifecycle.setDraft(preservedDraft);
  await lifecycle.createRun(preservedDraft);
  assert.equal(lifecycle.getSnapshot().error?.code, "CATALOG_EPOCH_MISMATCH");
  await lifecycle.openCreate();
  assert.equal(catalogCalls, 3);
  assert.equal(lifecycle.getSnapshot().error, null);
  assert.equal(lifecycle.getSnapshot().draft?.name, "保留这份训练");
  assert.equal(lifecycle.getSnapshot().draft?.warmupBars, 300);
});

test("create refreshes catalog epoch with the edited warmup and horizon before POST", async (context) => {
  const catalogQueries: Array<{ warmupBars?: number; horizonMs?: number; blindMode?: boolean }> = [];
  let submittedEpoch: string | null = null;
  const refreshedEpoch = `sha256:${"c".repeat(64)}` as ReplayDigest;
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
        if (catalogQueries.length === 1) return catalog;
        return {
          ...catalog,
          catalog_epoch: refreshedEpoch,
          warmup_bars: query?.warmupBars ?? catalog.warmup_bars,
          horizon_ms: query?.horizonMs ?? catalog.horizon_ms,
          entries: catalog.entries.map((entry) => ({ ...entry, catalog_epoch: refreshedEpoch })),
        };
      },
      async createRun(payload) {
        submittedEpoch = payload.catalog_epoch;
        return parseTrainingRunMutationResponse(mutationResponse());
      },
      async migrateLegacy() {
        throw new Error("not used");
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  await lifecycle.openCreate();
  const draft = lifecycle.getSnapshot().draft;
  assert.ok(draft);
  const edited = { ...draft, warmupBars: 300, forwardCacheMs: 43_200_000 };
  lifecycle.setDraft(edited);
  await lifecycle.createRun(edited);
  assert.deepEqual(catalogQueries.at(-1), {
    warmupBars: 300,
    horizonMs: 43_200_000,
    qualityMode: "exact",
    blindMode: true,
  });
  assert.equal(submittedEpoch, refreshedEpoch);
});

test("create model covers Phase 6 account fields and exposes fail-closed boundaries", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = blindCatalog();
  const draft = createTrainingRunDraft(catalog);
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, catalog);
  assert.equal(evaluation.canSubmit, true);
  assert.deepEqual(evaluation.unsupported, {
    funding: "HISTORICAL_EXACT 缺少对齐的历史 funding 与 mark，创建时 fail closed",
    historical_l2: "Phase 9 可选能力尚未实现；当前只能 OFF",
    rule_changes: "费率、杠杆与 Sandbox 固定资金费可按白名单审计变更",
    isolated_margin: "CROSS 与 ISOLATED 均可用；逐仓开仓前必须显式分配保证金",
  });
  const request = buildTrainingRunCreateRequest(draft, evaluation, catalog);
  assert.equal(request.protocol, "replay.v2");
  assert.equal(request.catalog_epoch, catalog.catalog_epoch);
  assert.equal(request.time_disclosure_policy, "HIDE_ALL");
  assert.equal(request.integrity_mode, "CHALLENGE");
  assert.equal(request.funding_mode, "OFF");
  assert.equal(request.fixed_funding_rate, null);
  assert.equal(request.funding_interval_ms, null);
  assert.equal(request.book_mode, "OFF");
  assert.equal(request.margin_mode, "CROSS");
  assert.equal(request.allow_rule_changes, false);
  assert.deepEqual(request.allowed_mutations, []);
});

test("Phase 6 create model enables isolated Sandbox funding but rejects historical exact", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const catalog = blindCatalog();
  const base = createTrainingRunDraft(catalog);
  const sandbox = {
    ...base,
    integrityMode: "SANDBOX" as const,
    marginMode: "ISOLATED" as const,
    fundingMode: "SANDBOX_FIXED" as const,
    fixedFundingRate: "-0.0001",
    fundingIntervalMs: 28_800_000,
  };
  const sandboxEvaluation = evaluateTrainingRunDraft(sandbox, capabilities, catalog);
  assert.equal(sandboxEvaluation.canSubmit, true);
  const request = buildTrainingRunCreateRequest(sandbox, sandboxEvaluation, catalog);
  assert.equal(request.margin_mode, "ISOLATED");
  assert.equal(request.funding_mode, "SANDBOX_FIXED");
  assert.equal(request.fixed_funding_rate, "-0.0001");
  assert.equal(request.funding_interval_ms, 28_800_000);

  const exact = evaluateTrainingRunDraft(
    { ...base, fundingMode: "HISTORICAL_EXACT" },
    capabilities,
    catalog,
  );
  assert.equal(exact.canSubmit, false);
  assert.match(exact.errors.join("\n"), /历史 funding.*mark|funding.*mark/);
});

test("hub markup exposes saves, native actions, filters and explicit unavailable capability reasons", () => {
  const catalog = blindCatalog();
  const draft = createTrainingRunDraft(catalog);
  const runtime = {
    phase: "READY",
    items: parseTrainingRunListResponse(listResponse()).items,
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
    actions: {
      refresh() {},
      loadNext() {},
      setFilters() {},
      openCreate() {},
      closeCreate() {},
      setDraft() {},
      createRun() {},
      migrateLegacy() {},
      continueRun() {},
    },
  } satisfies TrainingHubRuntime;
  const html = renderToStaticMarkup(<TrainingHubDialog runtime={runtime} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /训练存档大厅/);
  assert.match(html, /BTC 手动训练/);
  assert.match(html, /继续训练/);
  assert.match(html, /新建训练/);
  assert.match(html, /资金费.*HISTORICAL_EXACT/);
  assert.match(html, /完整性模式/);
  assert.match(html, /HIDE_MINUTE/);
  assert.match(html, /Practice 可审计变更白名单/);
  assert.match(html, /历史盘口.*Phase 9/);
  assert.match(html, /Phase 6 合约账户已启用/);
  assert.match(html, /Phase 7 按需数据段/);
  assert.match(html, /SNAPSHOT_LOCAL_BAR_RANGE/);
  assert.match(html, /校验失败 quarantine/);
  assert.match(html, /后台下载.*默认关闭/);
  assert.match(html, /自动 GC.*默认关闭/);
  assert.match(html, /TOUCH_OR_TAPE_V2/);
  assert.match(html, /不含盘口排队/);
  assert.doesNotMatch(html, /<strong>多商品<\/strong>/);
  assert.doesNotMatch(html, /1710000000000|dataset_epoch|snapshot_blob/);
});

test("product routing keeps v1 exact when the flag is off and opens Hub only for configure", () => {
  assert.equal(resolveReplayProduct(false, { kind: "configure" }), "v1");
  assert.equal(resolveReplayProduct(true, { kind: "configure" }), "hub");
  assert.equal(resolveReplayProduct(true, { kind: "session", sessionId: "adapter-1" }), "v1");
  assert.equal(resolveReplayProduct(true, {
    kind: "error",
    code: "REPLAY_ENTRY_INVALID",
    message: "invalid",
  }), "v1");
});

test("return-to-hub waits for the server checkpoint before navigation", async () => {
  const calls: string[] = [];
  await returnToTrainingHub(
    "adapter-1",
    {
      async returnToHub(sessionId) {
        calls.push(`checkpoint:${sessionId}`);
        return {
          protocol: "replay.v2",
          run_id: "run-1",
          state: "PAUSED",
          checkpointed: true,
          released: true,
        };
      },
    },
    (url) => calls.push(`navigate:${url}`),
  );
  assert.deepEqual(calls, ["checkpoint:adapter-1", "navigate:/replay.html"]);
});
