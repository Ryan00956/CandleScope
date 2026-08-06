import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TrainingHubDialog from "../components/TrainingHubDialog.js";
import {
  buildTrainingRunPreparationRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
  evaluateTrainingRunSetupDraft,
  formatUtcReplayStartInput,
  isEligibleReplayStart,
  parseUtcReplayStartInput,
  replayStartWindow,
  requiresBlindTrainingCatalog,
} from "../trainingHubModel.js";
import {
  createReplayPublicTimeFormatter,
} from "../replayPublicTimeModel.js";
import {
  parseReplayPublicTimeBatchResponse,
} from "../replayIntegrityModel.js";
import { parseReplayCapabilities, parseReplayCatalog } from "../replayParser.js";
import {
  TrainingHubLifecycle,
  type TrainingHubRuntime,
} from "../useTrainingHub.js";
import { enabledCapabilities } from "./fixtures.js";


const EPOCH = `sha256:${"a".repeat(64)}` as const;
const START_MS = 1_710_000_000_000;
const MINUTE_MS = 60_000;

function catalog(blindMode: boolean) {
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: EPOCH,
    warmup_bars: 2,
    horizon_ms: 8 * MINUTE_MS,
    quality_mode: "exact",
    blind_mode: blindMode,
    entries: [{
      identity: { exchange: "binance", market_type: "spot", symbol: "BTCUSDT" },
      base_intervals: ["1m"],
      selected_base_interval: "1m",
      eligible_window_count: 4,
      quality: "EXACT_BAR_COVERAGE",
      limitations: [],
      catalog_epoch: EPOCH,
      bounds: blindMode ? null : {
        earliest_open_ms: START_MS,
        latest_source_open_ms: START_MS + 15 * MINUTE_MS,
        latest_closed_open_ms: START_MS + 14 * MINUTE_MS,
        total_count: 15,
      },
      ...(blindMode ? {} : {
        gap_summary: {
          gaps: [{
            start_ms: START_MS + 4 * MINUTE_MS,
            end_ms: START_MS + 5 * MINUTE_MS,
            missing_bars: 1,
            reason: "missing",
          }],
          gap_count: 1,
          missing_bars: 1,
          scanned_bars: 15,
          scan_calls: 1,
          calendar_id: "continuous",
        },
        source_fingerprint: `sha256:${"b".repeat(64)}`,
      }),
      eligible_ranges: blindMode ? [] : [{
        interval: "1m",
        interval_ms: MINUTE_MS,
        first_start_ms: START_MS + 2 * MINUTE_MS,
        last_start_ms: START_MS + 3 * MINUTE_MS,
        count: 2,
        warmup_bars: 2,
        replay_bars: 8,
      }, {
        interval: "1m",
        interval_ms: MINUTE_MS,
        first_start_ms: START_MS + 6 * MINUTE_MS,
        last_start_ms: START_MS + 7 * MINUTE_MS,
        count: 2,
        warmup_bars: 2,
        replay_bars: 8,
      }],
    }],
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("UTC datetime helpers expose history and eligible boundaries without millisecond entry", () => {
  const entry = catalog(false).entries[0];
  assert.ok(entry);
  const window = replayStartWindow(entry);
  assert.deepEqual(window, {
    earliestHistoryMs: START_MS,
    earliestEligibleMs: START_MS + 2 * MINUTE_MS,
    latestEligibleMs: START_MS + 7 * MINUTE_MS,
    eligibleWindowCount: 4,
    stepSeconds: 60,
  });
  const value = formatUtcReplayStartInput(START_MS + 2 * MINUTE_MS);
  assert.equal(value, "2024-03-09T16:02:00");
  assert.equal(parseUtcReplayStartInput(value), START_MS + 2 * MINUTE_MS);
  assert.equal(parseUtcReplayStartInput("2024-03-09T16:02"), START_MS + 2 * MINUTE_MS);
  assert.equal(parseUtcReplayStartInput("2024-02-30T00:00"), null);
  assert.equal(isEligibleReplayStart(entry, START_MS + 2 * MINUTE_MS), true);
  assert.equal(isEligibleReplayStart(entry, START_MS + 4 * MINUTE_MS), false);
  assert.equal(isEligibleReplayStart(entry, START_MS + 2 * MINUTE_MS + 1), false);
});

test("create payload delegates random seed ownership to the server", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const blind = catalog(true);
  const draft = {
    ...createTrainingRunDraft(blind),
    positionMode: "ONE_WAY" as const,
    accountDataMode: "APPROX_PROXY" as const,
    fundingMode: "OFF" as const,
    bookMode: "OFF" as const,
    startMode: "RANDOM" as const,
    requestedStartMs: null,
    randomRangeStartMs: START_MS,
    randomRangeEndMs: START_MS + 10 * MINUTE_MS,
    timeDisclosurePolicy: "HIDE_ALL" as const,
  };
  assert.equal(Object.hasOwn(draft, "randomSeed"), false);
  assert.equal(requiresBlindTrainingCatalog(draft), true);
  const evaluation = evaluateTrainingRunDraft(draft, capabilities, blind);
  assert.equal(evaluation.canSubmit, true);
  const request = buildTrainingRunPreparationRequest(draft, evaluation, blind);
  assert.equal(request.random_seed, null);

  const manual = {
    ...draft,
    startMode: "MANUAL" as const,
    requestedStartMs: START_MS + 2 * MINUTE_MS,
    randomRangeStartMs: null,
    randomRangeEndMs: null,
    timeDisclosurePolicy: "NONE" as const,
  };
  assert.equal(requiresBlindTrainingCatalog(manual), false);
  const visible = catalog(false);
  assert.equal(evaluateTrainingRunDraft(manual, capabilities, visible).canSubmit, true);
});

test("Hub creates a product-independent Run without reading or rebinding catalogs", async (context) => {
  const blindQueries: boolean[] = [];
  const lifecycle = new TrainingHubLifecycle({
    api: {
      async listRuns() {
        return {
              protocol: "replay.v3",
              schema_version: "replay.training.v2",
          items: [],
          next_cursor: null,
        };
      },
      async capabilities() {
        return parseReplayCapabilities(enabledCapabilities());
      },
      async catalog(query) {
        const blindMode = query?.blindMode ?? true;
        blindQueries.push(blindMode);
        return catalog(blindMode);
      },
      async createRun() {
        throw new Error("not used");
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  await lifecycle.openCreate();
  assert.deepEqual(blindQueries, []);
  assert.equal(lifecycle.getSnapshot().catalog, null);
  const initial = lifecycle.getSnapshot().draft;
  assert.ok(initial);

  lifecycle.setDraft({ ...initial, timeDisclosurePolicy: "NONE" });
  await settle();
  assert.deepEqual(blindQueries, []);
  assert.equal(lifecycle.getSnapshot().catalog, null);

  const visibleDraft = lifecycle.getSnapshot().draft;
  assert.ok(visibleDraft);
  lifecycle.setDraft({
    ...visibleDraft,
    timeDisclosurePolicy: "HIDE_DAY",
    startMode: "MANUAL",
    requestedStartMs: START_MS + 2 * MINUTE_MS,
  });
  await settle();
  assert.deepEqual(blindQueries, []);

  const manual = lifecycle.getSnapshot().draft;
  assert.ok(manual);
  lifecycle.setDraft({
    ...manual,
    startMode: "RANDOM",
    requestedStartMs: null,
  });
  await settle();
  assert.deepEqual(blindQueries, []);
});

test("manual create panel renders UTC setup and defers product coverage to the Run", () => {
  const capabilities = parseReplayCapabilities(enabledCapabilities());
  const base = createTrainingRunDraft();
  const draft = {
    ...base,
    startMode: "MANUAL" as const,
    requestedStartMs: START_MS + 2 * MINUTE_MS,
  };
  const evaluation = evaluateTrainingRunSetupDraft(draft, capabilities);
  const noop = () => undefined;
  const runtime = {
    phase: "READY",
    items: [],
    nextCursor: null,
    filters: { state: null, sourceKind: null, compatibility: null },
    operation: null,
    error: null,
    createOpen: true,
    capabilities,
    catalog: null,
    draft,
    evaluation,
    segmentPlan: null,
    storageOpen: false,
    storageInventory: null,
    storagePlan: null,
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
  const markup = renderToStaticMarkup(<TrainingHubDialog runtime={runtime} />);
  assert.match(markup, /type="datetime-local"/);
  assert.match(markup, /UTC/);
  assert.match(markup, /创建确认后 T0 永久不变/);
  assert.match(markup, /确认时间并创建 Run/);
  assert.doesNotMatch(markup, /使用最早合格起点|个合格随机窗口/);
  assert.doesNotMatch(markup, /请求开始时间（ms）/);
});

test("public-time parser and formatter use exact server labels and fail closed on misses", () => {
  const labels = [
    ["NONE", "2024-03-09 16:00:00"],
    ["HIDE_YEAR", "03-09 16:00:00"],
    ["HIDE_MONTH", "09 16:00:00"],
    ["HIDE_DAY", "D+1 16:00:00"],
    ["HIDE_HOUR", "T+0h 00:00"],
    ["HIDE_MINUTE", "T+0m 00"],
    ["HIDE_ALL", "D+1 T+00:00:00"],
  ] as const;
  for (const [policy, label] of labels) {
    const parsed = parseReplayPublicTimeBatchResponse({
      protocol: "replay.v3",
      run_id: "run-1",
      policy,
      items: [{
        input_timeline_ms: START_MS,
        public_time: {
          policy,
          timeline_ms: START_MS,
          relative_ms: 0,
          sequence: 0,
          label,
        },
      }],
    });
    const formatter = createReplayPublicTimeFormatter({
      policy,
      originMs: START_MS,
      labels: new Map(parsed.items.map((item) => [
        item.input_timeline_ms,
        item.public_time.label,
      ])),
    });
    assert.equal(formatter(START_MS), label);
    const fallback = formatter(START_MS + MINUTE_MS);
    if (policy !== "NONE") {
      assert.match(fallback, /^D[+-]\d+ \d{2}:\d{2}:\d{2}$/);
      assert.doesNotMatch(fallback, /2024|03-09/);
    }
  }
});

test("revealed NONE clocks map synthetic timeline values back to the actual origin", () => {
  const syntheticOriginMs = Date.UTC(2000, 0, 1);
  const formatter = createReplayPublicTimeFormatter({
    policy: "NONE",
    originMs: START_MS,
    timelineOriginMs: syntheticOriginMs,
    labels: new Map(),
  });

  assert.equal(
    formatter(syntheticOriginMs + MINUTE_MS),
    new Date(START_MS + MINUTE_MS).toISOString().replace("T", " ").slice(0, 19),
  );
  assert.doesNotMatch(formatter(syntheticOriginMs + MINUTE_MS), /^2000-/);
});
