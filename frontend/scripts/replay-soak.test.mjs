import assert from "node:assert/strict";
import test from "node:test";

import {
  auditBoundary,
  createV2ArchiveRun,
  createStreamingBoundaryAudit,
  isAuthoritativeReplayStatus,
  replayCatalogQueryFromCreatePayload,
  replaySpeedAction,
  replaySpeedRequestState,
  replayStepAction,
  replayTrainingTargetSpeed,
  restoreCommandReadinessAfterReconnect,
} from "./replay-soak.mjs";

const catalogEntry = {
  identity: {
    exchange: "binance",
    market_type: "spot",
    symbol: "BTCUSDT",
  },
  selected_base_interval: "1m",
};

const createPayload = {
  exchange: "binance",
  market_type: "spot",
  symbol: "BTCUSDT",
  base_interval: "1m",
  indicator_warmup_bars: 200,
  forward_cache_ms: 86_400_000,
  time_disclosure_policy: "HIDE_ALL",
  random_seed: 7,
};

function reconnectCdp({ recovery }) {
  const calls = [];
  return {
    calls,
    async send(method, payload) {
      assert.equal(method, "Runtime.evaluate");
      calls.push(payload.expression);
      if (payload.expression.includes("const command = document.querySelector")) {
        return { result: { value: recovery } };
      }
      if (payload.expression.includes("const element = document.querySelector")) {
        return { result: { value: true } };
      }
      if (payload.expression.includes("const button = document.querySelector")) {
        return { result: { value: true } };
      }
      throw new Error(`Unexpected Runtime.evaluate expression: ${payload.expression}`);
    },
  };
}

test("replay soak blind audit catches standalone fixture epochs across HTTP shapes", () => {
  for (const value of [
    { body: JSON.stringify({ event_time_ms: 1_700_160_666_666 }) },
    { body: JSON.stringify({ event_time_ms: "1700160666666" }) },
    { url: "http://127.0.0.1/replay?start=1700160666666&blind=true" },
    { text: "cursor 1700160666666 hidden" },
  ]) {
    const result = auditBoundary("http", value);
    assert.equal(result.passed, false);
    assert.equal(result.forbiddenMatches[0]?.boundary, "fixture_epoch_milliseconds");
    assert.deepEqual(result.forbiddenMatches[0]?.values, ["1700160666666"]);
  }
});

test("replay soak blind audit does not mistake Decimal or digest substrings for epochs", () => {
  const result = auditBoundary("http", {
    equity: "9998.1700160666666",
    digest: "sha256:1700160666666abcdef",
    identifier: "order1700160666666suffix",
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.forbiddenMatches, []);
});

test("replay soak blind audit retains calendar and filesystem path boundaries", () => {
  const result = auditBoundary("dom", {
    date: "2023-11-16",
    database: "C:\\private\\replay.db",
  });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.forbiddenMatches.map((item) => item.boundary),
    ["fixture_calendar_date", "windows_filesystem_path", "archive_or_database_path"],
  );
});

test("replay soak streaming blind audit covers every item without aggregate serialization", () => {
  const audit = createStreamingBoundaryAudit("http");
  audit.add({ body: JSON.stringify({ event_time_ms: 1_700_160_666_666 }) });
  for (let index = 0; index < 10_050; index += 1) {
    audit.add({ index, body: `safe-response-${index}` });
  }
  audit.add({ body: JSON.stringify({ event_time_ms: 1_700_260_666_666 }) });

  const result = audit.finish();
  assert.equal(result.itemCount, 10_052);
  assert.equal(result.passed, false);
  assert.equal(result.framing, "length-prefixed-json-lines.v1");
  assert.deepEqual(result.forbiddenMatches[0]?.values, ["1700160666666", "1700260666666"]);
  assert.match(result.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.bytes > 0);
  assert.equal(audit.add({ body: "late-frame" }), false);
  assert.equal(result.itemsAfterFinish, 1);
  assert.equal(audit.finish(), result);
});

test("replay soak reconnect accepts an already-ready controller", async () => {
  const cdp = reconnectCdp({ recovery: "ready" });
  assert.equal(await restoreCommandReadinessAfterReconnect(cdp, 1_000, true), "ready");
  assert.equal(cdp.calls.some((expression) => expression.includes("const element = document.querySelector")), false);
  assert.equal(cdp.calls.at(-1).includes('data-replay-action="advance-display"'), true);
});

test("replay soak reconnect takes over before waiting for command readiness", async () => {
  const cdp = reconnectCdp({ recovery: "takeover" });
  assert.equal(await restoreCommandReadinessAfterReconnect(cdp, 1_000, true), "takeover");
  assert.equal(cdp.calls.some((expression) => expression.includes('data-replay-action="takeover-controller"')), true);
  assert.equal(cdp.calls.at(-1).includes('data-replay-action="advance-display"'), true);
});

test("replay soak maps v1 and v2 controls to their rendered action contracts", () => {
  assert.equal(replayStepAction(false), "step");
  assert.equal(replayStepAction(true), "advance-display");
  assert.equal(replaySpeedAction(false), "speed");
  assert.equal(replaySpeedAction(true), "playback-rate");
});

test("replay soak rotates only through fast speeds rendered by each product", () => {
  const v1Options = ["1", "5", "15", "30", "60", "120", "300", "600", "MAX"];
  const v2Options = ["1", "2", "5", "10", "30", "60", "120", "600", "1000", "10000"];

  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => replayTrainingTargetSpeed(v1Options, index)),
    [60, 120, 300, 600, 60],
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => replayTrainingTargetSpeed(v2Options, index)),
    [60, 120, 600, 1000, 10000, 60],
  );
  assert.throws(() => replayTrainingTargetSpeed(["1", "30", "MAX"], 0), /no numeric option/);
  assert.throws(() => replayTrainingTargetSpeed(v2Options, -1), /non-negative safe integer/);
});

test("v2 lifecycle refreshes exactly once for catalog epoch drift", async () => {
  const calls = [];
  let catalogReads = 0;
  const requestJson = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      catalogReads += 1;
      return {
        catalog_epoch: `sha256:${String(catalogReads).repeat(64)}`,
        entries: [catalogEntry],
      };
    }
    if (catalogReads === 1) {
      const error = new Error("catalog changed");
      error.status = 409;
      error.responseBody = {
        error: { code: "CATALOG_EPOCH_MISMATCH" },
      };
      throw error;
    }
    return { run: { run_id: "run-2", adapter_session_id: "session-2" } };
  };

  const result = await createV2ArchiveRun({
    backendOrigin: "http://127.0.0.1:18000",
    createPayload,
    index: 15,
    requestJson,
  });

  assert.equal(result.catalogEpochRefreshes, 1);
  assert.equal(result.catalogEpoch, `sha256:${"2".repeat(64)}`);
  assert.equal(calls.length, 4);
  assert.equal(
    new URL(calls[2].url).searchParams.get("warmup_bars"),
    "200",
  );
  assert.equal(calls[2].url.includes("undefined"), false);
  assert.equal(
    JSON.parse(calls[3].options.body).catalog_epoch,
    result.catalogEpoch,
  );
});

test("v2 lifecycle catalog query binds the Phase 14 history-policy fields", () => {
  assert.equal(
    replayCatalogQueryFromCreatePayload(createPayload).toString(),
    "warmup_bars=200&horizon_ms=86400000&quality_mode=exact&blind_mode=true",
  );
  assert.throws(
    () => replayCatalogQueryFromCreatePayload({
      ...createPayload,
      indicator_warmup_bars: undefined,
    }),
    /indicator_warmup_bars/,
  );
  assert.throws(
    () => replayCatalogQueryFromCreatePayload({
      ...createPayload,
      forward_cache_ms: undefined,
    }),
    /forward_cache_ms/,
  );
});

test("v2 lifecycle does not retry unrelated conflicts", async () => {
  let calls = 0;
  const requestJson = async (_url, options = {}) => {
    calls += 1;
    if (!options.method) {
      return {
        catalog_epoch: `sha256:${"a".repeat(64)}`,
        entries: [catalogEntry],
      };
    }
    const error = new Error("capacity conflict");
    error.status = 409;
    error.responseBody = { error: { code: "TRAINING_RUN_CREATE_FAILED" } };
    throw error;
  };

  await assert.rejects(
    createV2ArchiveRun({
      backendOrigin: "http://127.0.0.1:18000",
      createPayload,
      index: 0,
      requestJson,
    }),
    /capacity conflict/,
  );
  assert.equal(calls, 2);
});

test("replay soak rejects resync placeholders as command acknowledgements", () => {
  const authoritative = {
    connection: "connected",
    generation: 3,
    state: "PAUSED",
    sourceSequence: 225,
    revision: 652,
    stateHash: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(isAuthoritativeReplayStatus(authoritative), true);
  assert.equal(isAuthoritativeReplayStatus({
    ...authoritative,
    connection: "resyncing",
    sourceSequence: 0,
    revision: 0,
    stateHash: "",
  }), false);
  assert.equal(isAuthoritativeReplayStatus({ ...authoritative, stateHash: "" }), false);
  assert.equal(isAuthoritativeReplayStatus({ ...authoritative, generation: 0 }), false);
});

test("replay soak distinguishes speed dispatch, pending work, and authoritative acknowledgement", () => {
  const authoritative = {
    clockRate: 1,
    connection: "connected",
    controlPending: "",
    generation: 3,
    revision: 652,
    sourceSequence: 225,
    state: "PAUSED",
    stateHash: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(replaySpeedRequestState(null, 600, true, 652), "waiting");
  assert.equal(replaySpeedRequestState(authoritative, 600, true, 652), "waiting");
  assert.equal(
    replaySpeedRequestState({ ...authoritative, controlPending: "set_speed" }, 600, true, 652),
    "started",
  );
  assert.equal(
    replaySpeedRequestState({ ...authoritative, clockRate: 600 }, 600, true, 652),
    "acknowledged",
  );
  assert.equal(replaySpeedRequestState(authoritative, 600, false, 652), "waiting");
  assert.equal(
    replaySpeedRequestState({ ...authoritative, revision: 653 }, 600, false, 652),
    "acknowledged",
  );
});
