import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditBoundary,
  CdpConnection,
  createV2ArchiveRun,
  createStreamingBoundaryAudit,
  isAuthoritativeReplayStatus,
  inspectReplaySoakFrontendBuild,
  readJson,
  replayBackendHealth,
  replayCatalogQueryFromCreatePayload,
  replaySpeedAction,
  replaySpeedRequestState,
  replayStepAction,
  replaySubscriberReleaseState,
  replaySoakFrontendPlan,
  replaySoakFrontendProcessEnvironment,
  replayTrainingTargetSpeed,
  restoreCommandReadinessAfterReconnect,
  selectFormalV2RealTrainingPlan,
} from "./replay-soak.mjs";

test("replay soak builds and serves the same flag-enabled production output", () => {
  const outDir = path.join(os.tmpdir(), "candlescope-soak-plan");
  const plan = replaySoakFrontendPlan({
    backendPort: 18_080,
    frontendPort: 15_173,
    outDir,
    productV2: true,
  });
  assert.equal(plan.runtime, "vite-production-preview");
  assert.equal(plan.environment.VITE_API_PROXY_TARGET, "http://127.0.0.1:18080");
  assert.equal(plan.environment.VITE_REPLAY_ENTRY_ENABLED, "1");
  assert.equal(plan.environment.VITE_REPLAY_PRODUCT_V2_ENABLED, "1");
  assert.equal(plan.environment.VITE_REPLAY_SOAK_PROJECTION_ENABLED, "1");
  assert.deepEqual(plan.buildArgs.slice(1), [
    "build",
    "--outDir",
    outDir,
    "--emptyOutDir",
    "--manifest",
  ]);
  assert.deepEqual(plan.previewArgs.slice(1), [
    "preview",
    "--outDir",
    outDir,
    "--host",
    "127.0.0.1",
    "--port",
    "15173",
    "--strictPort",
  ]);
  assert.equal(
    replaySoakFrontendPlan({
      backendPort: 18_080,
      frontendPort: 15_173,
      outDir,
      productV2: false,
    }).environment.VITE_REPLAY_PRODUCT_V2_ENABLED,
    "0",
  );
  assert.throws(
    () => replaySoakFrontendPlan({
      backendPort: 0,
      frontendPort: 15_173,
      outDir,
      productV2: true,
    }),
    /backendPort/,
  );
  assert.throws(
    () => replaySoakFrontendPlan({
      backendPort: 18_080,
      frontendPort: 15_173,
      outDir: "relative-dist",
      productV2: true,
    }),
    /absolute child of the OS temp directory/,
  );
  const processEnvironment = replaySoakFrontendProcessEnvironment(
    plan.environment,
    {
      NODE_ENV: "development",
      PATH: "trusted-path",
      VITE_API_PROXY_TARGET: "https://untrusted.invalid",
      VITE_REPLAY_PRODUCT_V2_ENABLED: "0",
      VITE_UNRELATED_FLAG: "ambient-leak",
    },
  );
  assert.equal(processEnvironment.PATH, "trusted-path");
  assert.equal(processEnvironment.NODE_ENV, "production");
  assert.equal(processEnvironment.VITE_API_PROXY_TARGET, "http://127.0.0.1:18080");
  assert.equal(processEnvironment.VITE_REPLAY_PRODUCT_V2_ENABLED, "1");
  assert.equal(processEnvironment.VITE_UNRELATED_FLAG, undefined);
});

test("replay soak binds its projection URL and evidence to the production manifest", (context) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-soak-build-test-"));
  context.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outDir, ".vite"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "assets", "projection-abc.js"),
    "const R=class{},f={},p={};export{R as ReplayStore,f as fixtures,p as parser};\n",
  );
  fs.writeFileSync(path.join(outDir, "replay.html"), "<!doctype html>\n");
  fs.writeFileSync(
    path.join(outDir, ".vite", "manifest.json"),
    JSON.stringify({
      "scripts/replay-soak-projection.ts": {
        file: "assets/projection-abc.js",
        isEntry: true,
        name: "replaySoakProjection",
        src: "scripts/replay-soak-projection.ts",
      },
    }),
  );

  const inspected = inspectReplaySoakFrontendBuild(outDir);
  assert.equal(inspected.projectionModuleUrl, "/assets/projection-abc.js");
  assert.equal(inspected.evidence.schema_version, "replay-soak-frontend-build.v1");
  assert.equal(inspected.evidence.runtime, "vite-production-preview");
  assert.equal(inspected.evidence.fileCount, 3);
  assert.equal(inspected.evidence.projectionAsset.file, "assets/projection-abc.js");
  assert.deepEqual(
    inspected.evidence.projectionAsset.exports,
    ["ReplayStore", "fixtures", "parser"],
  );
  assert.match(inspected.evidence.projectionAsset.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(inspected.evidence.manifestSha256, /^sha256:[a-f0-9]{64}$/);

  fs.writeFileSync(
    path.join(outDir, "assets", "projection-abc.js"),
    "const R=class{};export{R as ReplayStore};\n",
  );
  assert.throws(
    () => inspectReplaySoakFrontendBuild(outDir),
    /missing exports: fixtures, parser/,
  );

  fs.writeFileSync(
    path.join(outDir, ".vite", "manifest.json"),
    JSON.stringify({
      "scripts/replay-soak-projection.ts": {
        file: "../projection.js",
        isEntry: true,
        name: "replaySoakProjection",
      },
    }),
  );
  assert.throws(() => inspectReplaySoakFrontendBuild(outDir), /manifest file is invalid/);

  fs.writeFileSync(
    path.join(outDir, ".vite", "manifest.json"),
    JSON.stringify({
      "scripts/replay-soak-projection.ts": {
        file: "assets/missing.js",
        isEntry: true,
        name: "replaySoakProjection",
      },
    }),
  );
  assert.throws(() => inspectReplaySoakFrontendBuild(outDir), /projection asset is missing/);
});

class FakeSocket {
  constructor() {
    this.closed = false;
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({
      listener,
      once: Boolean(options?.once),
    });
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    this.listeners.set(
      type,
      listeners.filter((record) => record.listener !== listener),
    );
  }

  emit(type, event = {}) {
    for (const record of [...(this.listeners.get(type) || [])]) {
      if (record.once) this.removeEventListener(type, record.listener);
      record.listener(event);
    }
  }

  send(payload) {
    if (this.closed) throw new Error("fake socket is closed");
    this.sent.push(JSON.parse(payload));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1_000, reason: "test-close" });
  }
}

async function connectedCdp(timeoutMs = 1_000) {
  const socket = new FakeSocket();
  const cdp = new CdpConnection("ws://replay-soak.test", {
    socketFactory: () => socket,
    timeoutMs,
  });
  queueMicrotask(() => socket.emit("open"));
  await cdp.connect();
  return { cdp, socket };
}

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

test("replay soak bounds an HTTP fetch even when the implementation ignores abort", async () => {
  let observedSignal = null;
  await assert.rejects(
    readJson(
      "http://replay-soak.test/hanging-fetch",
      { timeoutMs: 25 },
      async (_url, options) => {
        observedSignal = options.signal;
        return new Promise(() => {});
      },
    ),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /HTTP GET .* timed out after 25ms/);
      return true;
    },
  );
  assert.equal(observedSignal?.aborted, true);
});

test("replay soak bounds an HTTP response body that never completes", async () => {
  await assert.rejects(
    readJson(
      "http://replay-soak.test/hanging-body",
      { timeoutMs: 25 },
      async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => new Promise(() => {}),
      }),
    ),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /HTTP GET .* timed out after 25ms/);
      return true;
    },
  );
});

test("replay soak makes a CDP connect timeout terminal and closes the socket", async () => {
  const socket = new FakeSocket();
  const cdp = new CdpConnection("ws://replay-soak.test", {
    socketFactory: () => socket,
    timeoutMs: 25,
  });
  await assert.rejects(
    cdp.connect(),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /CDP WebSocket connect timed out after 25ms/);
      return true;
    },
  );
  assert.equal(socket.closed, true);
  await assert.rejects(cdp.send("Runtime.evaluate"), /connect timed out/);
});

test("replay soak rejects a timed-out CDP command without retaining pending work", async () => {
  const { cdp, socket } = await connectedCdp(25);
  await assert.rejects(
    cdp.send("Runtime.evaluate"),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /CDP Runtime\.evaluate timed out after 25ms/);
      return true;
    },
  );
  assert.equal(socket.sent.length, 1);
  assert.equal(cdp.pending.size, 0);
  cdp.close();
});

test("replay soak rejects every pending CDP command when the target disappears", async () => {
  const { cdp, socket } = await connectedCdp();
  const first = cdp.send("Runtime.evaluate");
  const second = cdp.send("Page.captureScreenshot");
  socket.emit("close", { code: 1_006, reason: "target-gone" });
  await assert.rejects(first, /CDP WebSocket closed \(code=1006 reason=target-gone\)/);
  await assert.rejects(second, /CDP WebSocket closed \(code=1006 reason=target-gone\)/);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send("Runtime.evaluate"), /target-gone/);
});

test("replay soak resolves a CDP command response and clears its deadline", async () => {
  const { cdp, socket } = await connectedCdp();
  const pending = cdp.send("Runtime.evaluate", { expression: "1 + 1" });
  const request = socket.sent.at(-1);
  socket.emit("message", {
    data: JSON.stringify({
      id: request.id,
      result: { result: { type: "number", value: 2 } },
    }),
  });
  assert.deepEqual(await pending, {
    result: { type: "number", value: 2 },
  });
  assert.equal(cdp.pending.size, 0);
  cdp.close();
});

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

test("formal v2 soak binds a 30-day plan to a contiguous real identity", () => {
  const evidence = {
    read_only: true,
    file_sha256: "a".repeat(64),
    identities: [
      {
        exchange: "binance",
        market_type: "spot",
        symbol: "ETHUSDT",
        interval: "1m",
        contiguous: true,
        validated_rows: 43_400,
      },
      {
        exchange: "binance",
        market_type: "spot",
        symbol: "BTCUSDT",
        interval: "1m",
        contiguous: true,
        validated_rows: 43_401,
      },
    ],
  };

  assert.deepEqual(selectFormalV2RealTrainingPlan(evidence), {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
    forwardCacheMs: 2_592_000_000,
    warmupBars: 200,
    requiredRows: 43_400,
    validatedRows: 43_401,
    sourceSha256: "a".repeat(64),
  });
  assert.throws(
    () => selectFormalV2RealTrainingPlan({
      ...evidence,
      identities: evidence.identities.map((identity) => ({
        ...identity,
        validated_rows: 43_399,
      })),
    }),
    /contiguous 43400-row real 1m identity/,
  );
  assert.throws(
    () => selectFormalV2RealTrainingPlan({ ...evidence, read_only: false }),
    /read-only real source identity evidence/,
  );
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

test("replay soak treats an evicted actor as zero retained subscribers", () => {
  const payload = {
    replay: {
      sessions: {
        active: { subscribers: 2 },
      },
    },
  };
  assert.deepEqual(replaySubscriberReleaseState(payload, "missing", 1), {
    actor: null,
    ready: true,
    state: "actor-evicted",
    subscriberCount: 0,
  });
  assert.deepEqual(replaySubscriberReleaseState(payload, "active", 1), {
    actor: { subscribers: 2 },
    ready: false,
    state: "actor-active",
    subscriberCount: 2,
  });
  assert.equal(replaySubscriberReleaseState({}, "missing", 1).ready, false);
});

test("replay soak fails closed on backend lifecycle and persistence failures", () => {
  const healthy = {
    replay: {
      persistence: {
        degraded: false,
        transaction_failures: 0,
      },
      reaper_failures: 0,
      recovery_failures: 0,
      shutdown_failures: 0,
    },
  };
  assert.equal(replayBackendHealth(healthy).passed, true);
  assert.equal(replayBackendHealth({
    ...healthy,
    replay: { ...healthy.replay, reaper_failures: 1 },
  }).passed, false);
  assert.equal(replayBackendHealth({
    ...healthy,
    replay: {
      ...healthy.replay,
      persistence: { degraded: true, transaction_failures: 0 },
    },
  }).passed, false);
  assert.equal(replayBackendHealth({}).passed, false);
});
