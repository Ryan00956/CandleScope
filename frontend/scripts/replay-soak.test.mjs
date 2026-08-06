import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBoundary,
  captureTarget,
  CdpConnection,
  createV2ArchiveRun,
  createStreamingBoundaryAudit,
  isRecordedAdapterEviction,
  isAuthoritativeReplayStatus,
  inspectReplaySoakFrontendBuild,
  readJson,
  replayBackendHealth,
  replaySpeedAction,
  replaySpeedRequestState,
  replayStepAction,
  replaySubscriberReleaseState,
  replaySoakFrontendPlan,
  replaySoakFrontendProcessEnvironment,
  replayTrainingTargetSpeed,
  restoreCommandReadinessAfterReconnect,
  selectFormalV2HedgeTrainingPlan,
  selectFormalV2RealTrainingPlan,
} from "./replay-soak.mjs";

test("public replay scripts cannot select or launch the retired v1 product", () => {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const frontendRoot = path.resolve(scriptDirectory, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(frontendRoot, "package.json"), "utf8"));

  assert.match(packageJson.scripts["smoke:replay"], /replay-soak\.mjs/);
  assert.doesNotMatch(packageJson.scripts["smoke:replay"], /replay-smoke\.mjs/);
  assert.match(packageJson.scripts["drill:replay:rollback"], /replay-v2-rollback-drill\.mjs/);
  assert.doesNotMatch(packageJson.scripts["drill:replay:rollback"], /replay-rollback-drill\.(?:mjs|ps1)/);

  const historicalSmoke = fs.readFileSync(path.join(scriptDirectory, "replay-smoke.mjs"), "utf8");
  const historicalRollback = fs.readFileSync(path.join(scriptDirectory, "replay-rollback-drill.mjs"), "utf8");
  const powershellRollback = fs.readFileSync(path.join(scriptDirectory, "replay-rollback-drill.ps1"), "utf8");
  const soak = fs.readFileSync(path.join(scriptDirectory, "replay-soak.mjs"), "utf8");
  assert.match(historicalSmoke, /replay-soak\.mjs/);
  assert.match(historicalRollback, /replay-v2-rollback-drill\.mjs/);
  assert.match(powershellRollback, /replay-v2-rollback-drill\.mjs/);
  assert.match(soak, /\/api\/v1\/replay\/runs\/session\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.doesNotMatch(soak, /\/api\/v1\/replay\/sessions(?:\/|\$\{)/);
  assert.match(soak, /packages", "candlescope-plugin-sdk", "src"/);
  assert.match(soak, /process\.env\.PYTHONPATH/);
  assert.match(soak, /确认时间并创建 Run/);
  assert.doesNotMatch(soak, /创建 Run 并选择商品/);
  assert.match(soak, /Run market search readiness/);
  assert.match(soak, /market-picker-readiness/);
  assert.match(soak, /data-training-field="requested-start-utc"/);
  assert.match(soak, /railView: "replay-paper"/);
  assert.doesNotMatch(soak, /text: "纸面交易"/);
  assert.match(soak, /data-replay-action="place-order"/);
  assert.match(soak, /data-side="\$\{side\}"/);
  assert.doesNotMatch(soak, /\.replay-order-ticket/);
  const endConfirmationOffset = soak.indexOf("soak session end");
  const integrityDrawerOffset = soak.indexOf(
    'data-replay-action="toggle-integrity"',
    endConfirmationOffset,
  );
  const reportPanelOffset = soak.indexOf(
    'data-replay-panel=\\"report\\"',
    integrityDrawerOffset,
  );
  assert.ok(endConfirmationOffset >= 0);
  assert.ok(integrityDrawerOffset > endConfirmationOffset);
  assert.ok(reportPanelOffset > integrityDrawerOffset);
  assert.match(soak, /REPLAY_TRAINING_PROTOCOL = "replay\.v3"/);
  assert.match(soak, /exported\.protocol === REPLAY_TRAINING_PROTOCOL/);
  assert.doesNotMatch(soak, /exported\.protocol === "replay\.v2"/);
  const accountProofSource = soak.slice(
    soak.indexOf("async function readServerAccountProof"),
    soak.indexOf("async function addAndSelectHedgeSecondaryMarket"),
  );
  assert.match(accountProofSource, /\/tracks`/);
  assert.doesNotMatch(accountProofSource, /\/markets`/);
  assert.match(soak, /async function waitForServerSelectedMarket/);
  assert.match(soak, /authoritative HEDGE market selection/);
  assert.match(soak, /HEDGE market selection command failed/);
  assert.match(soak, /registered HEDGE market \$\{symbol\} readiness/);
  assert.match(soak, /trackId !== 'unregistered'/);
  assert.match(soak, /captureCursor =/);
  assert.match(soak, /responseBodies: replayOnly/);
  assert.match(soak, /replay interval \$\{interval\} readiness/);
});

test("adapter eviction evidence keys the target Hub eviction amid background reaping", () => {
  const evidence = {
    evicted: true,
    session_id: "session-primary",
    release_attempts: 1,
    sessions_evicted_before: 226,
    sessions_evicted_after: 228,
    hub_sessions_evicted_before: 150,
    hub_sessions_evicted_after: 151,
  };
  assert.equal(isRecordedAdapterEviction(evidence, "session-primary"), true);
  assert.equal(
    isRecordedAdapterEviction(
      { ...evidence, hub_sessions_evicted_after: 152 },
      "session-primary",
    ),
    false,
  );
  assert.equal(
    isRecordedAdapterEviction(
      { ...evidence, sessions_evicted_after: 226 },
      "session-primary",
    ),
    false,
  );
  assert.equal(isRecordedAdapterEviction(evidence, "session-other"), false);
});

test("replay soak builds and serves the same flag-enabled production output", () => {
  const outDir = path.join(os.tmpdir(), "candlescope-soak-plan");
  const plan = replaySoakFrontendPlan({
    backendPort: 18_080,
    frontendPort: 15_173,
    outDir,
  });
  assert.equal(plan.runtime, "vite-production-preview");
  assert.equal(plan.environment.VITE_API_PROXY_TARGET, "http://127.0.0.1:18080");
  assert.equal(plan.environment.VITE_REPLAY_ENTRY_ENABLED, "1");
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
  assert.throws(
    () => replaySoakFrontendPlan({
      backendPort: 0,
      frontendPort: 15_173,
      outDir,
    }),
    /backendPort/,
  );
  assert.throws(
    () => replaySoakFrontendPlan({
      backendPort: 18_080,
      frontendPort: 15_173,
      outDir: "relative-dist",
    }),
    /absolute child of the OS temp directory/,
  );
  const processEnvironment = replaySoakFrontendProcessEnvironment(
    plan.environment,
    {
      NODE_ENV: "development",
      PATH: "trusted-path",
      VITE_API_PROXY_TARGET: "https://untrusted.invalid",
      VITE_UNRELATED_FLAG: "ambient-leak",
    },
  );
  assert.equal(processEnvironment.PATH, "trusted-path");
  assert.equal(processEnvironment.NODE_ENV, "production");
  assert.equal(processEnvironment.VITE_API_PROXY_TARGET, "http://127.0.0.1:18080");
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
  protocol: "replay.v3",
  name: "Run-centric soak",
  source_kind: "BAR",
  start_mode: "RANDOM",
  exchange: "binance",
  market_type: "spot",
  symbol: "BTCUSDT",
  settlement_asset: "USDT",
  base_interval: "1m",
  display_interval: "1m",
  requested_start_ms: null,
  indicator_warmup_bars: 200,
  visible_history_lookback: { mode: "ALL_AVAILABLE", duration_ms: null },
  forward_cache_ms: 86_400_000,
  time_disclosure_policy: "HIDE_ALL",
  random_seed: 7,
  initial_equity: "10000",
  max_leverage: "3",
  maker_fee_bps: "2",
  taker_fee_bps: "5",
  market_slippage_bps: "1",
  integrity_mode: "CHALLENGE",
  book_mode: "OFF",
  margin_mode: "CROSS",
  funding_mode: "OFF",
  account_data_mode: "APPROX_PROXY",
  account_history_ref: null,
  hedge_public_history_ref: { archive_id: "hedge-public-v1" },
  simulation_manifest_ref: { manifest_id: "simulation-v1" },
  fixed_funding_rate: null,
  funding_interval_ms: null,
  allow_rule_changes: false,
  allowed_mutations: [],
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

test("replay soak streaming blind audit resets creation-time public inputs", () => {
  const audit = createStreamingBoundaryAudit("http");
  audit.add({
    phase: "training-hub",
    requested_start_ms: 1_700_160_666_666,
    latest_source_open_ms: 1_700_260_666_666,
  });

  audit.reset();
  audit.add({ phase: "blind-runtime", public_time: "D+2 03:04:00" });
  const result = audit.finish();

  assert.equal(result.itemCount, 1);
  assert.equal(result.passed, true);
  assert.deepEqual(result.forbiddenMatches, []);
  assert.throws(() => audit.reset(), /cannot reset after finish/);
});

test("replay soak blind capture attributes late response bodies to request start", async () => {
  const handlers = new Map();
  const bodies = new Map([
    ["setup", JSON.stringify({ latest_source_open_ms: 1_700_260_666_666 })],
    ["runtime", JSON.stringify({ virtual_time: "D+2 03:04:00" })],
  ]);
  const cdp = {
    on(name, listener) {
      handlers.set(name, listener);
    },
    send(name, payload) {
      assert.equal(name, "Network.getResponseBody");
      return Promise.resolve({ base64Encoded: false, body: bodies.get(payload.requestId) });
    },
  };
  const emit = (name, payload) => handlers.get(name)?.(payload);
  const capture = captureTarget(cdp, { auditReplayBoundaries: true });
  const replayUrl = "http://127.0.0.1/api/v1/replay/catalog";

  emit("Network.requestWillBeSent", {
    requestId: "setup",
    request: { method: "GET", url: replayUrl },
  });
  capture.startBlindBoundaryAudit();
  emit("Network.responseReceived", {
    requestId: "setup",
    response: { status: 200, url: replayUrl },
  });
  emit("Network.loadingFinished", { requestId: "setup" });
  emit("Network.requestWillBeSent", {
    requestId: "runtime",
    request: { method: "GET", url: "http://127.0.0.1/api/v1/replay/runs/run-1" },
  });
  emit("Network.responseReceived", {
    requestId: "runtime",
    response: { status: 200, url: "http://127.0.0.1/api/v1/replay/runs/run-1" },
  });
  emit("Network.loadingFinished", { requestId: "runtime" });
  await capture.settle();

  const result = capture.boundaryAudits.http.finish();
  assert.equal(result.passed, true);
  assert.equal(result.itemCount, 2);
  assert.deepEqual(result.forbiddenMatches, []);
  assert.equal(capture.responseBodies.length, 2);
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

test("replay soak uses only the v2 rendered action contracts", () => {
  assert.equal(replayStepAction(), "advance-display");
  assert.equal(replaySpeedAction(), "playback-rate");
});

test("replay soak rotates only through fast speeds rendered by v2", () => {
  const v2Options = ["1", "2", "5", "10", "30", "60", "120", "600", "1000", "10000"];

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

test("formal HEDGE soak binds both exact public/L2 archives and one simulation model", () => {
  const publicRefs = {
    BTCUSDT: { archive_id: "btc-public" },
    ETHUSDT: { archive_id: "eth-public" },
  };
  const simulationRef = { manifest_id: "simulation-v1" };
  const historicalBook = {
    BTCUSDT: { archive_id: "btc-book" },
    ETHUSDT: { archive_id: "eth-book" },
  };
  const rangeStartMs = 1_700_000_040_000;
  const rangeEndMs = rangeStartMs + 43_400 * 60_000;
  const fixture = {
    source_profile: "HEDGE_EXACT_ARCHIVE_QA",
    historical_book: historicalBook,
    hedge_inputs: {
      fidelity: "PINNED_PUBLIC_EXACT_PRIVATE_DETERMINISTIC_SIMULATION",
      fallback_applied: false,
      range_start_ms: rangeStartMs,
      range_end_ms: rangeEndMs,
      public_refs: publicRefs,
      simulation_ref: simulationRef,
    },
  };
  assert.deepEqual(selectFormalV2HedgeTrainingPlan(fixture), {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    secondarySymbol: "ETHUSDT",
    interval: "1m",
    timeDisclosurePolicy: "HIDE_ALL",
    requestedStartMs: rangeStartMs + 200 * 60_000,
    forwardCacheMs: 2_592_000_000,
    warmupBars: 200,
    requiredRows: 43_400,
    publicRefs,
    simulationRef,
    historicalBook,
    inputFidelity: "PINNED_PUBLIC_EXACT_PRIVATE_DETERMINISTIC_SIMULATION",
    fallbackApplied: false,
  });
  assert.throws(
    () => selectFormalV2HedgeTrainingPlan({
      ...fixture,
      hedge_inputs: { ...fixture.hedge_inputs, fallback_applied: true },
    }),
    /exact per-symbol public\/L2 inputs/,
  );
  assert.throws(
    () => selectFormalV2HedgeTrainingPlan({
      ...fixture,
      hedge_inputs: {
        ...fixture.hedge_inputs,
        range_end_ms: rangeEndMs - 60_000,
      },
    }),
    /exact per-symbol public\/L2 inputs/,
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
  assert.equal(calls.length, 5);
  assert.match(calls[3].url, /\/runs\/run-2\/market-catalog$/);
  assert.equal(calls[3].url.includes("undefined"), false);
  assert.equal(
    JSON.parse(calls[4].options.body).catalog_epoch,
    result.catalogEpoch,
  );
  const setup = JSON.parse(calls[0].options.body);
  assert.equal(Object.hasOwn(setup, "symbol"), false);
  assert.equal(Object.hasOwn(setup, "catalog_epoch"), false);
  assert.equal(Object.hasOwn(setup, "hedge_public_history_ref"), false);
  assert.equal(Object.hasOwn(setup, "simulation_manifest_ref"), false);
  const selection = JSON.parse(calls[4].options.body);
  assert.deepEqual(selection.hedge_public_history_ref, createPayload.hedge_public_history_ref);
  assert.deepEqual(selection.simulation_manifest_ref, createPayload.simulation_manifest_ref);
});

test("v2 lifecycle does not retry unrelated conflicts", async () => {
  let calls = 0;
  const requestJson = async (url, options = {}) => {
    calls += 1;
    if (options.method && /\/api\/v1\/replay\/runs$/.test(new URL(url).pathname)) {
      return { run: { run_id: "run-1", adapter_session_id: null } };
    }
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
  assert.equal(calls, 3);
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
  assert.equal(replaySpeedRequestState(null, 600), "waiting");
  assert.equal(replaySpeedRequestState(authoritative, 600), "waiting");
  assert.equal(
    replaySpeedRequestState({ ...authoritative, controlPending: "set_speed" }, 600),
    "started",
  );
  assert.equal(
    replaySpeedRequestState({ ...authoritative, clockRate: 600 }, 600),
    "acknowledged",
  );
  assert.equal(replaySpeedRequestState({ ...authoritative, revision: 653 }, 600), "waiting");
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
