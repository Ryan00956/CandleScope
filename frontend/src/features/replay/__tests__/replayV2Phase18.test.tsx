import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TrainingHubDialog from "../components/TrainingHubDialog.js";
import {
  parseReplayStorageGcPlan,
  parseReplayStorageInventory,
  type ReplayStorageGcPlan,
} from "../replayStorageModel.js";
import { ReplayV2ApiError } from "../replayV2Api.js";
import {
  TrainingHubLifecycle,
  type TrainingHubApiBoundary,
  type TrainingHubRuntime,
} from "../useTrainingHub.js";


const digest = (character: string) => `sha256:${character.repeat(64)}`;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    object_count: 0,
    ready_count: 0,
    evicted_count: 0,
    quarantined_count: 0,
    pinned_count: 0,
    local_bytes: 0,
    max_bytes: 1_099_511_627_776,
    pressure_bps: 0,
    truncated: false,
    ...overrides,
  };
}

function objectItem(overrides: Record<string, unknown> = {}) {
  return {
    object_id: "segment-one",
    source_kind: "BAR",
    identity: {
      exchange: "binance",
      market_type: "futures",
      symbol: "BTCUSDT",
      base_interval: "1m",
    },
    health: "READY",
    byte_size: 4_096,
    generation: 2,
    active_ref_count: 1,
    recoverability: "TRUSTED_MANIFEST_CHECKSUM_BOUND",
    protection_reasons: ["ACTIVE_RUN"],
    rehydration_available: true,
    ...overrides,
  };
}

function inventoryRaw() {
  return {
    protocol: "replay.storage.inventory.v1",
    decision: {
      state: "HOLD",
      default_flags_enabled: false,
      reason_codes: [
        "PRODUCTION_OBSERVATION_WINDOW_NOT_BOUND",
        "BOOK_PRODUCTION_CAPTURE_NOT_PRESENT",
      ],
      implementation_state: "PHASE18_IMPLEMENTED_RELEASE_HOLD",
    },
    feature_flags: {
      replay_enabled: true,
      agg_trade_enabled: false,
      segment_download_worker_enabled: false,
      segment_auto_gc_enabled: false,
      fast_forward_optimization_enabled: false,
      historical_book_enabled: false,
      account_history_enabled: false,
    },
    categories: {
      segments: {
        summary: summary({
          object_count: 1,
          ready_count: 1,
          pinned_count: 1,
          local_bytes: 4_096,
        }),
        items: [objectItem()],
        gc_protocol: "replay.data.gc.v1",
        auto_gc_enabled: false,
      },
      historical_books: {
        summary: summary(),
        items: [],
        gc_protocol: "replay.historical-book.gc.v1",
        auto_gc_enabled: false,
      },
      account_history: {
        summary: summary({
          object_count: 1,
          evicted_count: 1,
          max_bytes: 137_438_953_472,
        }),
        items: [objectItem({
          object_id: "account-one",
          source_kind: "ACCOUNT_HISTORY",
          identity: {
            exchange: "binance",
            market_type: "futures",
            symbol: "BTCUSDT",
          },
          health: "EVICTED",
          byte_size: 0,
          active_ref_count: 0,
          recoverability: "TRUSTED_LOCAL_SOURCE_CHECKSUM_BOUND",
          protection_reasons: ["HEALTH_EVICTED", "REHYDRATION_REQUIRED"],
        })],
        gc_protocol: "replay.account-history.gc.v1",
        auto_gc_enabled: false,
      },
      review_evidence: {
        summary: summary({
          object_count: 1,
          ready_count: 1,
          pinned_count: 1,
          local_bytes: 2_048,
          max_bytes: 671_088_640,
        }),
        items: [{
          run_id: "run-one",
          run_state: "PAUSED",
          anchor_bytes: 1_024,
          anchor_limit_bytes: 536_870_912,
          artifact_bytes: 1_024,
          artifact_limit_bytes: 134_217_728,
          critical_events: 2,
          critical_event_limit: 8_192,
          viewport_samples: 1,
          viewport_sample_limit: 2_048,
          protection_reasons: ["RUN_ARCHIVE_EVIDENCE", "REVIEW_OPEN"],
          gc_available: false,
        }],
        gc_protocol: null,
        auto_gc_enabled: false,
      },
    },
    support_matrix: [
      ["BAR", "CANDLESCOPE_CLOSED_KLINE_CATALOG"],
      ["AGG_TRADE", "BINANCE_DATA_VISION_USDM_DAILY_AGGTRADES"],
      ["BOOK_ASSISTED", "BINANCE_USDM_OPERATOR_DIFF_DEPTH_CAPTURE"],
      ["HISTORICAL_EXACT_ACCOUNT", "OPERATOR_CAPTURED_LINEAR_ACCOUNT_HISTORY"],
    ].map(([mode, source_contract]) => ({
      mode,
      source_contract,
      declared_scope: "BINANCE_FUTURES_USDM",
      fidelity: `${mode}_FROZEN_FIDELITY`,
      queue_exact: false,
      required_flags: ["REPLAY_ENABLED"],
      observed_identities: mode === "BAR"
        ? [{
            exchange: "binance",
            market_type: "futures",
            symbol: "BTCUSDT",
            base_interval: "1m",
          }]
        : [],
      production_readiness: "HOLD",
      reason_codes: ["PRODUCTION_OBSERVATION_WINDOW_NOT_BOUND"],
    })),
    alerts: [{
      severity: "INFO",
      code: "REPLAY_CORE_DEFAULT_OFF",
      category: "release",
      message: "Replay remains gated by the default-off core switch; v2 is selected when replay is enabled.",
    }],
    bounds: {
      max_items_per_category: 200,
      max_observed_identities: 100,
      actual_time_exposed: false,
      local_paths_exposed: false,
    },
  };
}

function segmentGcPlanRaw() {
  return {
    protocol: "replay.data.gc.v1",
    mode: "DRY_RUN",
    plan_hash: digest("a"),
    request: {
      target_reclaim_bytes: 1,
      max_segments: 10,
    },
    current_external_bytes: 4_096,
    estimated_reclaim_bytes: 4_096,
    candidates: [{
      segment_id: "segment-one",
      generation: 2,
      byte_size: 4_096,
      last_used_at_ms: 1,
      checksum_sha256: digest("b"),
      affected_run_ids: [],
      recoverability: "TRUSTED_MANIFEST_CHECKSUM_BOUND",
    }],
    protected: [{
      segment_id: "segment-two",
      generation: 1,
      byte_size: 2_048,
      last_used_at_ms: 1,
      checksum_sha256: digest("c"),
      affected_run_ids: ["run-one"],
      recoverability: "TRUSTED_MANIFEST_CHECKSUM_BOUND",
      protection_reasons: ["ACTIVE_RUN"],
    }],
    non_rebuildable_auto_reclaimed: false,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function baseApi(
  overrides: Partial<TrainingHubApiBoundary> = {},
): TrainingHubApiBoundary {
  return {
    async listRuns() {
      return {
        protocol: "replay.v2",
        schema_version: "replay.training.v1",
        items: [],
        next_cursor: null,
      };
    },
    async capabilities() {
      throw new Error("unused");
    },
    async catalog() {
      throw new Error("unused");
    },
    async createRun() {
      throw new Error("unused");
    },
    ...overrides,
  } as TrainingHubApiBoundary;
}

test("Phase 18 inventory parser accepts the frozen shape and rejects private fields", () => {
  const parsed = parseReplayStorageInventory(inventoryRaw());
  assert.equal(parsed.decision.state, "HOLD");
  assert.equal(parsed.feature_flags.agg_trade_enabled, false);
  assert.equal(parsed.categories.segments.items[0]?.object_id, "segment-one");
  assert.equal(parsed.categories.review_evidence.gc_protocol, null);
  assert.equal(parsed.support_matrix.length, 4);

  const leaked = structuredClone(inventoryRaw());
  (leaked.categories.segments.items[0] as Record<string, unknown>).local_path = (
    "objects/secret.blob"
  );
  assert.throws(
    () => parseReplayStorageInventory(leaked),
    /crosses the replay storage boundary/,
  );

  const actualTime = structuredClone(inventoryRaw());
  (actualTime.categories.account_history.items[0] as Record<string, unknown>)
    .actual_time_ms = 1_700_000_000_000;
  assert.throws(
    () => parseReplayStorageInventory(actualTime),
    /actual_time_ms/,
  );
});

test("Phase 18 GC parser normalizes category-specific proof without exposing checksum", () => {
  const plan = parseReplayStorageGcPlan(segmentGcPlanRaw());
  assert.equal(plan.protocol, "replay.data.gc.v1");
  assert.equal(plan.request.max_objects, 10);
  assert.equal(plan.candidates[0]?.object_id, "segment-one");
  assert.equal(plan.protected[0]?.protection_reasons[0], "ACTIVE_RUN");
  assert.equal("checksum_sha256" in plan.candidates[0]!, false);

  const inconsistent = structuredClone(segmentGcPlanRaw());
  inconsistent.estimated_reclaim_bytes = 1;
  assert.throws(
    () => parseReplayStorageGcPlan(inconsistent),
    /estimated reclaim bytes/,
  );
});

test("Training Hub loads storage lazily, clears stale plan confirmation and aborts on close", async () => {
  const calls: string[] = [];
  const pendingState: {
    signal?: AbortSignal;
    resolve?: (value: ReturnType<typeof parseReplayStorageInventory>) => void;
  } = {};
  let pending = false;
  const inventory = parseReplayStorageInventory(inventoryRaw());
  const plan = parseReplayStorageGcPlan(segmentGcPlanRaw());
  const api = baseApi({
    async listRuns() {
      calls.push("runs");
      return {
        protocol: "replay.v2",
        schema_version: "replay.training.v1",
        items: [],
        next_cursor: null,
      };
    },
    async storageInventory(signal) {
      calls.push("storage");
      if (!pending) return inventory;
      if (signal !== undefined) pendingState.signal = signal;
      return new Promise((resolve) => {
        pendingState.resolve = resolve;
      });
    },
    async storageGcPlan() {
      calls.push("plan");
      return plan;
    },
    async storageGcRun() {
      calls.push("run");
      throw new ReplayV2ApiError(
        "SEGMENT_GC_PLAN_CHANGED",
        "plan changed",
        { status: 409 },
      );
    },
  });
  const lifecycle = new TrainingHubLifecycle({ api });
  lifecycle.start();
  await settle();
  assert.deepEqual(calls, ["runs"]);

  await lifecycle.openStorage();
  assert.deepEqual(calls, ["runs", "storage"]);
  await lifecycle.planStorageGc("replay.data.gc.v1", 1, 10);
  lifecycle.confirmStoragePlan(true);
  assert.equal(lifecycle.getSnapshot().storagePlanConfirmed, true);
  await lifecycle.runStorageGc();
  assert.equal(lifecycle.getSnapshot().storagePlan, null);
  assert.equal(lifecycle.getSnapshot().storagePlanConfirmed, false);
  assert.equal(lifecycle.getSnapshot().error?.code, "SEGMENT_GC_PLAN_CHANGED");

  pending = true;
  const refresh = lifecycle.refreshStorage();
  await settle();
  lifecycle.closeStorage();
  assert.equal(pendingState.signal?.aborted, true);
  pendingState.resolve?.(inventory);
  await refresh;
  assert.equal(lifecycle.getSnapshot().storageOpen, false);
  lifecycle.dispose();
});

test("storage panel exposes HOLD, protected Review evidence and exact plan confirmation", () => {
  const inventory = parseReplayStorageInventory(inventoryRaw());
  const plan: ReplayStorageGcPlan = parseReplayStorageGcPlan(segmentGcPlanRaw());
  const noop = () => undefined;
  const runtime = {
    phase: "READY",
    items: [],
    nextCursor: null,
    filters: { state: null, sourceKind: null, compatibility: null },
    operation: null,
    error: null,
    createOpen: false,
    capabilities: null,
    catalog: null,
    draft: null,
    evaluation: null,
    segmentPlan: null,
    storageOpen: true,
    storageInventory: inventory,
    storagePlan: plan,
    storagePlanConfirmed: false,
    storageResult: null,
    actions: {
      refresh: noop,
      loadNext: noop,
      setFilters: noop,
      openCreate: noop,
      closeCreate: noop,
      openStorage: noop,
      closeStorage: noop,
      refreshStorage: noop,
      planStorageGc: noop,
      confirmStoragePlan: noop,
      runStorageGc: noop,
      rehydrateStorageObject: noop,
      setDraft: noop,
      refreshCreatePlan: noop,
      createRun: noop,
      deleteRun: noop,
      continueRun: noop,
    },
  } satisfies TrainingHubRuntime;
  const html = renderToStaticMarkup(<TrainingHubDialog runtime={runtime} />);
  assert.match(html, /data-release-decision="HOLD"/);
  assert.match(html, /Run archive evidence 永久受保护/);
  assert.match(html, /本阶段没有删除入口/);
  assert.match(html, /data-storage-plan-hash="sha256:a{64}"/);
  assert.match(html, /我已核对上述 exact plan hash/);
  assert.match(html, /按 checksum 重新水化/);
  assert.equal((html.match(/执行此计划/g) ?? []).length, 1);
  assert.doesNotMatch(html, /objects\/secret/);
});
