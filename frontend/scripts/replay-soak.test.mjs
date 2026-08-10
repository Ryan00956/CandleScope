import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBoundary,
  assertReplayNetwork,
  browserSoakFailureEvidence,
  captureTarget,
  CdpConnection,
  createV2ArchiveRun,
  createStreamingBoundaryAudit,
  isRecordedAdapterEviction,
  isAuthoritativeReplayStatus,
  inspectReplaySoakFrontendBuild,
  isExactHedgeTrainingBound,
  primaryReplayFailureDiagnostics,
  parseArgs,
  readJson,
  readinessProcessExitIsTerminal,
  replayBackendHealth,
  replayApiConcurrencyContract,
  replayCommandResponseIdentityContract,
  replayCommandTransportRecoveryContract,
  replayOrderAdvisoryRequestContract,
  replayReadOnlyTransportRecoveryContract,
  replaySpeedAction,
  replaySpeedRequestState,
  replayStepAction,
  replaySubscriberReleaseState,
  replaySoakFrontendPlan,
  replaySoakFrontendProcessEnvironment,
  replayProductHeapEvidence,
  replayTrainingTargetSpeed,
  requestBrowserClose,
  restoreCommandReadinessAfterReconnect,
  selectFormalV2HedgeTrainingPlan,
  selectFormalV2RealTrainingPlan,
  waitForHttpUnavailable,
  waitForValue,
  withNetworkInspectorSuspended,
  writeHeapSnapshot,
} from "./replay-soak.mjs";

test("release stability and non-blocking observation modes keep distinct minimums", () => {
  const realSource = ["--real-klines-source", fileURLToPath(import.meta.url)];
  const stability = parseArgs(realSource);
  assert.equal(stability.durationMs, 3_600_000);
  assert.equal(stability.cycles, 100);
  assert.equal(stability.projectionEvents, 1_000_000);
  assert.equal(stability.observationOnly, false);

  const observation = parseArgs([
    ...realSource,
    "--observation-only",
    "--duration-ms",
    "14400000",
  ]);
  assert.equal(observation.observationOnly, true);

  assert.throws(
    () => parseArgs([
      ...realSource,
      "--observation-only",
      "--duration-ms",
      "14400000",
      "--cycles",
      "99",
    ]),
    /Non-blocking observation requires >=4h, >=100 lifecycle cycles/,
  );
  assert.throws(
    () => parseArgs(["--allow-short", "--observation-only"]),
    /mutually exclusive/,
  );
});

test("waitForValue fails immediately after the CDP control channel is terminal", async () => {
  let sends = 0;
  const cdp = {
    terminalError: new Error("CDP WebSocket closed (code=1006)"),
    async send() {
      sends += 1;
      return {};
    },
  };

  await assert.rejects(
    waitForValue(cdp, "true", 120_000, "terminal CDP probe"),
    /CDP WebSocket closed \(code=1006\)/,
  );
  assert.equal(sends, 0);
});

test("Chrome readiness permits only an explicit successful launcher handoff", () => {
  assert.equal(readinessProcessExitIsTerminal(null), false);
  assert.equal(readinessProcessExitIsTerminal(0), true);
  assert.equal(
    readinessProcessExitIsTerminal(0, { allowSuccessfulExitHandoff: true }),
    false,
  );
  assert.equal(
    readinessProcessExitIsTerminal(1, { allowSuccessfulExitHandoff: true }),
    true,
  );
});

test("browser cleanup tolerates WebSocket closure only with endpoint disappearance proof", async () => {
  const commands = [];
  let closed = 0;
  const connection = {
    async send(method, params, timeoutMs) {
      commands.push({ method, params, timeoutMs });
      throw new Error("CDP WebSocket closed");
    },
    close() {
      closed += 1;
    },
  };

  const close = await requestBrowserClose(connection, 25);
  assert.deepEqual(commands, [{ method: "Browser.close", params: {}, timeoutMs: 25 }]);
  assert.equal(closed, 1);
  assert.deepEqual(close, {
    attempted: true,
    acknowledged: false,
    error: "CDP WebSocket closed",
  });
  await waitForHttpUnavailable("http://127.0.0.1:1/json/version", 25, {
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    waitImpl: async () => undefined,
  });
});

test("browser cleanup fails when the debugging endpoint remains alive", async () => {
  await assert.rejects(
    waitForHttpUnavailable("http://127.0.0.1:1/json/version", 10, {
      fetchImpl: async () => ({ ok: true }),
      waitImpl: () => new Promise((resolve) => setTimeout(resolve, 1)),
    }),
    /Timed out waiting for .* to become unavailable/,
  );
});

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
  const trainingShell = fs.readFileSync(
    path.join(frontendRoot, "src", "features", "replay", "ReplayTrainingPageShell.tsx"),
    "utf8",
  );
  assert.match(historicalSmoke, /replay-soak\.mjs/);
  assert.match(historicalRollback, /replay-v2-rollback-drill\.mjs/);
  assert.match(powershellRollback, /replay-v2-rollback-drill\.mjs/);
  assert.match(soak, /\/api\/v1\/replay\/runs\/session\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.doesNotMatch(soak, /\/api\/v1\/replay\/sessions(?:\/|\$\{)/);
  assert.match(soak, /packages", "candlescope-plugin-sdk", "src"/);
  assert.match(soak, /process\.env\.PYTHONPATH/);
  assert.match(soak, /确认时间并创建 Run/);
  assert.doesNotMatch(soak, /创建 Run 并选择商品/);
  assert.doesNotMatch(soak, /hubKeyboard\?\.created\?\.active\?\.text === "创建并进入训练"/);
  assert.match(soak, /Run market search readiness/);
  assert.match(soak, /market-picker-readiness/);
  assert.match(soak, /data-training-field="requested-start-utc"/);
  assert.match(soak, /railView: "replay-paper"/);
  assert.doesNotMatch(soak, /text: "纸面交易"/);
  assert.match(soak, /data-replay-action="place-order"/);
  assert.match(soak, /HEDGE continuity pre-reload integrity idle/);
  assert.match(soak, /lifecycle pre-reload integrity idle/);
  assert.match(soak, /lifecycle replay API returned failures/);
  assert.match(soak, /replay_api_concurrency_bounded/);
  assert.match(soak, /phase: "browser-process-cleanup"/);
  assert.match(soak, /fs\.rmSync\(args\.out, \{ force: true \}\)/);
  assert.match(soak, /CATALOG_EPOCH_RETRY_DID_NOT_SUCCEED/);
  assert.match(soak, /--heap-snapshot-out is available only with --allow-short/);
  assert.match(
    trainingShell,
    /"data-replay-integrity-operation": integrityRuntime\.operation \?\? ""/,
  );
  assert.match(soak, /data-side="\$\{side\}"/);
  assert.match(soak, /\{ action: "place-order", side: "SELL" \}/);
  assert.match(soak, /order\?\.active\?\.side === "SELL"/);
  assert.match(soak, /training order side \$\{side\} readiness/);
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
  assert.equal(inspected.evidence.hostSecurityInjectionReferences, 0);
  assert.equal(inspected.evidence.projectionAsset.file, "assets/projection-abc.js");
  assert.deepEqual(
    inspected.evidence.projectionAsset.exports,
    ["ReplayStore", "fixtures", "parser"],
  );
  assert.match(inspected.evidence.projectionAsset.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(inspected.evidence.manifestSha256, /^sha256:[a-f0-9]{64}$/);

  fs.writeFileSync(
    path.join(outDir, "assets", "projection-abc.js"),
    "const u='http://gc.kis.v2.scr.kaspersky-labs.com';const R=class{},f={},p={};export{R as ReplayStore,f as fixtures,p as parser};\n",
  );
  assert.throws(
    () => inspectReplaySoakFrontendBuild(outDir),
    /contains host security injection origin/,
  );

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

test("replay target capture retains initial-market response identity and bodies", async () => {
  const handlers = new Map();
  const bodies = new Map([
    ["conflict", JSON.stringify({ error: { code: "CATALOG_EPOCH_MISMATCH" } })],
    ["retry", JSON.stringify({ initialized: true })],
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
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/markets";
  for (const [requestId, status] of [["conflict", 409], ["retry", 201]]) {
    emit("Network.requestWillBeSent", {
      requestId,
      request: { method: "POST", url, postData: "{}" },
    });
    emit("Network.responseReceived", {
      requestId,
      response: { status, url },
    });
    emit("Network.loadingFinished", { requestId });
  }
  await capture.settle();

  assert.deepEqual(
    capture.replayApiResponses.map(({ requestId, method, status }) => ({ requestId, method, status })),
    [
      { requestId: "conflict", method: "POST", status: 409 },
      { requestId: "retry", method: "POST", status: 201 },
    ],
  );
  assert.equal(capture.replayApiResponseBodies.length, 2);
  assert.equal(capture.replayApiResponseBodies[0].requestId, "conflict");
  assert.equal(capture.replayApiResponseBodies[0].status, 409);
});

test("replay target capture retains command request and response identities", async () => {
  const handlers = new Map();
  const command = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "set-speed-1",
    type: "set_speed",
  };
  const result = {
    protocol: "replay.v3",
    run_id: "run-1",
    command_id: "set-speed-1",
  };
  const cdp = {
    on(name, listener) {
      handlers.set(name, listener);
    },
    send(name, payload) {
      assert.equal(name, "Network.getResponseBody");
      assert.equal(payload.requestId, "command-1");
      return Promise.resolve({
        base64Encoded: false,
        body: JSON.stringify(result),
      });
    },
  };
  const emit = (name, payload) => handlers.get(name)?.(payload);
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/commands";
  emit("Network.requestWillBeSent", {
    requestId: "command-1",
    request: { method: "POST", url, postData: JSON.stringify(command) },
  });
  emit("Network.responseReceived", {
    requestId: "command-1",
    response: { status: 200, url },
  });
  emit("Network.loadingFinished", { requestId: "command-1" });
  await capture.settle();

  assert.equal(capture.replayCommandRequests.length, 1);
  assert.equal(capture.replayCommandResponses.length, 1);
  assert.equal(capture.replayCommandResponseBodies.length, 1);
  const identity = replayCommandResponseIdentityContract(capture);
  assert.equal(identity.passed, true);
  assert.deepEqual(identity.violations, []);
  assert.equal(identity.records[0].requestCommandId, "set-speed-1");
  assert.equal(identity.records[0].responseCommandId, "set-speed-1");
});

test("replay v1 session command accepts one proved same-envelope transport recovery", async () => {
  const handlers = new Map();
  const command = {
    protocol: "replay.v1",
    command_id: "command-loss-1",
    client_instance_id: "browser-1",
    expected_revision: 7,
    type: "step",
    payload: { count: 1 },
  };
  const result = {
    protocol: "replay.v1",
    session_id: "session-1",
    command_id: "command-loss-1",
    revision: 8,
  };
  const bodies = new Map([
    ["lost", ""],
    ["reconciled", JSON.stringify(result)],
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
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/commands";
  const postData = JSON.stringify(command);
  for (const [requestId, status] of [["lost", 500], ["reconciled", 200]]) {
    emit("Network.requestWillBeSent", {
      requestId,
      request: { method: "POST", url, postData },
    });
    emit("Network.responseReceived", {
      requestId,
      response: { status, url },
    });
    emit("Network.loadingFinished", { requestId });
  }
  await capture.settle();

  assert.equal(capture.replayCommandRequests.length, 2);
  assert.equal(capture.replayCommandResponses.length, 2);
  const recovery = replayCommandTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 1);
  assert.equal(recovery.recoveries[0].retryRequestId, "reconciled");
  assert.equal(recovery.recoveries[0].commandId, "command-loss-1");
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, true);
  assert.deepEqual(api.unexpectedFailures, []);
  const identity = replayCommandResponseIdentityContract(capture);
  assert.equal(identity.passed, true);
  assert.equal(identity.records[0].routeSessionId, "session-1");
  assert.equal(identity.records[0].recoveredByRequestId, "reconciled");
  assert.equal(identity.records[1].responseSessionId, "session-1");
});

test("replay read-only transport recovery accepts one bodyless 5xx followed by parseable 2xx", async () => {
  const handlers = new Map();
  const bodies = new Map([
    ["lost", ""],
    ["recovered", JSON.stringify({ protocol: "replay.v3", tracks: [] })],
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
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  for (const [requestId, status] of [["lost", 500], ["recovered", 200]]) {
    emit("Network.requestWillBeSent", {
      requestId,
      request: { method: "GET", url },
    });
    emit("Network.responseReceived", {
      requestId,
      response: { status, url },
    });
    emit("Network.loadingFinished", { requestId });
  }
  await capture.settle();

  assert.equal(capture.replayReadOnlyRequests.length, 2);
  assert.equal(capture.replayReadOnlyResponses.length, 2);
  assert.equal(capture.replayReadOnlyResponseBodies.length, 2);
  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 1);
  assert.equal(recovery.recoveries[0].retryRequestId, "recovered");
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, true);
  assert.equal(api.schemaVersion, "replay.api-concurrency-contract.v3");
  assert.equal(api.transportRecovery.recoveryCount, 1);
});

test("replay read-only transport recovery never accepts a structured 5xx", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const errorBody = JSON.stringify({
    protocol: "replay.v3",
    error: { code: "STORAGE_DEGRADED", message: "track read failed", details: {} },
  });
  const capture = {
    replayApiResponses: [{ requestId: "failed", method: "GET", url, status: 503 }],
    replayApiResponseBodies: [{ requestId: "failed", method: "GET", url, status: 503, body: errorBody }],
    replayReadOnlyRequests: [{ requestId: "failed", method: "GET", url, sequence: 1 }],
    replayReadOnlyResponses: [{ requestId: "failed", method: "GET", url, status: 503 }],
    replayReadOnlyResponseBodies: [{ requestId: "failed", method: "GET", url, status: 503, body: errorBody }],
  };

  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 0);
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, false);
  assert.equal(api.unexpectedFailures[0].responseBody.error.code, "STORAGE_DEGRADED");
});

test("replay read-only transport recovery rejects a missing retry", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const capture = {
    replayApiResponses: [{ requestId: "lost", method: "GET", url, status: 500 }],
    replayApiResponseBodies: [{ requestId: "lost", method: "GET", url, status: 500, body: "" }],
    replayReadOnlyRequests: [{ requestId: "lost", method: "GET", url, sequence: 1 }],
    replayReadOnlyResponses: [{ requestId: "lost", method: "GET", url, status: 500 }],
    replayReadOnlyResponseBodies: [{ requestId: "lost", method: "GET", url, status: 500, body: "" }],
  };

  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, false);
  assert.equal(recovery.violations[0].reason, "READ_TRANSPORT_RECOVERY_MISSING");
  assert.equal(replayApiConcurrencyContract(capture).passed, false);
});

test("replay read-only transport recovery rejects an interrupted 4xx response", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const capture = {
    replayApiResponses: [{ requestId: "failed", method: "GET", url, status: 404 }],
    replayReadOnlyRequests: [
      { requestId: "failed", method: "GET", url, sequence: 1 },
      { requestId: "later", method: "GET", url, sequence: 2 },
    ],
    replayReadOnlyResponses: [
      { requestId: "failed", method: "GET", url, status: 404 },
      { requestId: "later", method: "GET", url, status: 200 },
    ],
    replayReadOnlyResponseBodies: [
      { requestId: "later", method: "GET", url, status: 200, body: "{}" },
    ],
    failedRequests: [{
      requestId: "failed",
      method: "GET",
      url,
      responseStatus: 404,
      errorText: "net::ERR_CONNECTION_RESET",
    }],
  };

  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 0);
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, false);
  assert.equal(api.unexpectedFailures[0].reason, "UNEXPECTED_REPLAY_API_FAILURE");
});

test("replay read-only transport recovery accepts an interrupted 2xx body", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const capture = {
    replayReadOnlyRequests: [
      { requestId: "interrupted", method: "GET", url, sequence: 1 },
      { requestId: "retry", method: "GET", url, sequence: 2 },
    ],
    replayReadOnlyResponses: [
      { requestId: "interrupted", method: "GET", url, status: 200 },
      { requestId: "retry", method: "GET", url, status: 200 },
    ],
    replayReadOnlyResponseBodies: [
      { requestId: "retry", method: "GET", url, status: 200, body: "{}" },
    ],
    failedRequests: [{
      requestId: "interrupted",
      method: "GET",
      url,
      responseStatus: 200,
      errorText: "net::ERR_CONTENT_LENGTH_MISMATCH",
    }],
  };

  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 1);
  assert.equal(recovery.recoveries[0].failureKind, "NETWORK_LOADING_FAILED");
  assert.equal(replayApiConcurrencyContract(capture).passed, true);
});

test("replay read-only transport recovery audits intentional aborts without consuming budget", async () => {
  const handlers = new Map();
  const cdp = {
    on(name, listener) {
      handlers.set(name, listener);
    },
    send(name) {
      assert.equal(name, "Network.getResponseBody");
      return Promise.resolve({ base64Encoded: false, body: "{}" });
    },
  };
  const emit = (name, payload) => handlers.get(name)?.(payload);
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  emit("Network.requestWillBeSent", {
    requestId: "aborted",
    request: { method: "GET", url },
  });
  emit("Network.responseReceived", {
    requestId: "aborted",
    response: { status: 200, url },
  });
  emit("Network.loadingFailed", {
    requestId: "aborted",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });
  emit("Network.requestWillBeSent", {
    requestId: "later",
    request: { method: "GET", url },
  });
  emit("Network.responseReceived", {
    requestId: "later",
    response: { status: 200, url },
  });
  emit("Network.loadingFinished", { requestId: "later" });
  await capture.settle();

  assert.equal(capture.replayReadOnlyAborts.length, 1);
  assert.equal(capture.replayReadOnlyAborts[0].responseStatus, 200);
  assert.deepEqual(capture.replayReadOnlyRequests, []);
  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.ignoredAbortCount, 1);
  assert.equal(recovery.recoveryCount, 0);
  assert.equal(replayApiConcurrencyContract(capture).passed, true);
});

test("replay read-only transport recovery does not hide other canceled failures", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const capture = {
    replayReadOnlyRequests: [
      { requestId: "lost", method: "GET", url, sequence: 1 },
      { requestId: "retry", method: "GET", url, sequence: 2 },
    ],
    replayReadOnlyResponses: [
      { requestId: "retry", method: "GET", url, status: 200 },
    ],
    replayReadOnlyResponseBodies: [
      { requestId: "retry", method: "GET", url, status: 200, body: "{}" },
    ],
    failedRequests: [{
      requestId: "lost",
      method: "GET",
      url,
      canceled: true,
      errorText: "net::ERR_CONNECTION_RESET",
    }],
  };

  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.ignoredAbortCount, 0);
  assert.equal(recovery.recoveryCount, 1);
  assert.equal(recovery.recoveries[0].errorText, "net::ERR_CONNECTION_RESET");
});

test("replay read-only transport recovery fails when its tracked retry is aborted", async () => {
  const handlers = new Map();
  const cdp = {
    on(name, listener) {
      handlers.set(name, listener);
    },
    send(name, payload) {
      assert.equal(name, "Network.getResponseBody");
      assert.equal(payload.requestId, "lost");
      return Promise.resolve({ base64Encoded: false, body: "" });
    },
  };
  const emit = (name, payload) => handlers.get(name)?.(payload);
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  emit("Network.requestWillBeSent", {
    requestId: "lost",
    request: { method: "GET", url },
  });
  emit("Network.responseReceived", {
    requestId: "lost",
    response: { status: 500, url },
  });
  emit("Network.loadingFinished", { requestId: "lost" });
  emit("Network.requestWillBeSent", {
    requestId: "aborted-retry",
    request: { method: "GET", url },
  });
  emit("Network.loadingFailed", {
    requestId: "aborted-retry",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });
  await capture.settle();

  assert.equal(capture.replayReadOnlyAborts.length, 1);
  assert.equal(capture.replayReadOnlyRequests.length, 2);
  const recovery = replayReadOnlyTransportRecoveryContract(capture);
  assert.equal(recovery.passed, false);
  assert.equal(recovery.recoveryCount, 0);
  assert.equal(recovery.violations.length, 1);
  assert.equal(recovery.violations[0].reason, "READ_TRANSPORT_RECOVERY_RETRY_FAILED");
  assert.equal(replayApiConcurrencyContract(capture).passed, false);
});

test("formal replay transport recovery permits only one combined command or read loss", () => {
  const commandUrl = "http://127.0.0.1/api/v1/replay/runs/session/session-1/commands";
  const readUrl = "http://127.0.0.1/api/v1/replay/runs/session/session-1/tracks";
  const postData = JSON.stringify({
    protocol: "replay.v1",
    command_id: "command-loss-1",
    expected_revision: 0,
    type: "pause",
    payload: {},
  });
  const commandResult = JSON.stringify({
    protocol: "replay.v1",
    session_id: "session-1",
    command_id: "command-loss-1",
    revision: 1,
  });
  const capture = {
    replayApiResponses: [
      { requestId: "command-lost", method: "POST", url: commandUrl, status: 500 },
      { requestId: "read-lost", method: "GET", url: readUrl, status: 500 },
    ],
    replayApiResponseBodies: [
      { requestId: "command-lost", method: "POST", url: commandUrl, status: 500, body: "" },
      { requestId: "read-lost", method: "GET", url: readUrl, status: 500, body: "" },
    ],
    replayCommandRequests: [
      { requestId: "command-lost", method: "POST", url: commandUrl, postData },
      { requestId: "command-retry", method: "POST", url: commandUrl, postData },
    ],
    replayCommandResponses: [
      { requestId: "command-lost", method: "POST", url: commandUrl, status: 500 },
      { requestId: "command-retry", method: "POST", url: commandUrl, status: 200 },
    ],
    replayCommandResponseBodies: [
      { requestId: "command-lost", method: "POST", url: commandUrl, status: 500, body: "" },
      { requestId: "command-retry", method: "POST", url: commandUrl, status: 200, body: commandResult },
    ],
    replayReadOnlyRequests: [
      { requestId: "read-lost", method: "GET", url: readUrl, sequence: 1 },
      { requestId: "read-retry", method: "GET", url: readUrl, sequence: 2 },
    ],
    replayReadOnlyResponses: [
      { requestId: "read-lost", method: "GET", url: readUrl, status: 500 },
      { requestId: "read-retry", method: "GET", url: readUrl, status: 200 },
    ],
    replayReadOnlyResponseBodies: [
      { requestId: "read-lost", method: "GET", url: readUrl, status: 500, body: "" },
      { requestId: "read-retry", method: "GET", url: readUrl, status: 200, body: "{}" },
    ],
  };

  assert.equal(replayCommandTransportRecoveryContract(capture).passed, true);
  assert.equal(replayReadOnlyTransportRecoveryContract(capture).passed, true);
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, false);
  assert.equal(api.transportRecovery.recoveryCount, 2);
  assert.equal(
    api.unexpectedFailures.at(-1).reason,
    "REPLAY_TRANSPORT_RECOVERY_LIMIT_EXCEEDED",
  );
});

test("replay command transport recovery rejects a changed canonical envelope", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/commands";
  const original = JSON.stringify({
    protocol: "replay.v1",
    command_id: "command-loss-1",
    expected_revision: 7,
    type: "step",
    payload: { count: 1 },
  });
  const changed = JSON.stringify({
    protocol: "replay.v1",
    command_id: "command-loss-1",
    expected_revision: 8,
    type: "step",
    payload: { count: 1 },
  });
  const capture = {
    replayApiResponses: [{ requestId: "lost", method: "POST", url, status: 500 }],
    replayApiResponseBodies: [{ requestId: "lost", method: "POST", url, status: 500, body: "" }],
    replayCommandRequests: [
      { requestId: "lost", method: "POST", url, postData: original },
      { requestId: "changed", method: "POST", url, postData: changed },
    ],
    replayCommandResponses: [
      { requestId: "lost", method: "POST", url, status: 500 },
      { requestId: "changed", method: "POST", url, status: 200 },
    ],
    replayCommandResponseBodies: [
      { requestId: "lost", method: "POST", url, status: 500, body: "" },
      {
        requestId: "changed",
        method: "POST",
        url,
        status: 200,
        body: JSON.stringify({
          protocol: "replay.v1",
          session_id: "session-1",
          command_id: "command-loss-1",
        }),
      },
    ],
  };

  const recovery = replayCommandTransportRecoveryContract(capture);
  assert.equal(recovery.passed, false);
  assert.equal(recovery.violations[0].reason, "COMMAND_TRANSPORT_RECOVERY_MISSING");
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, false);
  assert.equal(api.unexpectedFailures[0].reason, "UNEXPECTED_REPLAY_API_FAILURE");
});

test("replay command transport recovery never accepts a structured server failure", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/commands";
  const postData = JSON.stringify({
    protocol: "replay.v1",
    command_id: "command-persistence-1",
    expected_revision: 7,
    type: "step",
    payload: { count: 1 },
  });
  const errorBody = JSON.stringify({
    protocol: "replay.v1",
    error: { code: "PERSISTENCE_DEGRADED", message: "write failed", details: {} },
  });
  const capture = {
    replayApiResponses: [{ requestId: "failed", method: "POST", url, status: 503 }],
    replayApiResponseBodies: [{ requestId: "failed", method: "POST", url, status: 503, body: errorBody }],
    replayCommandRequests: [{ requestId: "failed", method: "POST", url, postData }],
    replayCommandResponses: [{ requestId: "failed", method: "POST", url, status: 503 }],
    replayCommandResponseBodies: [{ requestId: "failed", method: "POST", url, status: 503, body: errorBody }],
  };

  const recovery = replayCommandTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveryCount, 0);
  const api = replayApiConcurrencyContract(capture);
  assert.equal(api.passed, false);
  assert.equal(api.unexpectedFailures[0].responseBody.error.code, "PERSISTENCE_DEGRADED");
});

test("replay command transport recovery retains a loading-failed envelope for exact reconciliation", async () => {
  const handlers = new Map();
  const command = {
    protocol: "replay.v1",
    command_id: "command-network-loss-1",
    expected_revision: 3,
    type: "pause",
    payload: {},
  };
  const cdp = {
    on(name, listener) {
      handlers.set(name, listener);
    },
    send(name) {
      assert.equal(name, "Network.getResponseBody");
      return Promise.resolve({
        base64Encoded: false,
        body: JSON.stringify({
          protocol: "replay.v1",
          session_id: "session-1",
          command_id: command.command_id,
          revision: 4,
        }),
      });
    },
  };
  const emit = (name, payload) => handlers.get(name)?.(payload);
  const capture = captureTarget(cdp);
  const url = "http://127.0.0.1/api/v1/replay/runs/session/session-1/commands";
  const postData = JSON.stringify(command);
  emit("Network.requestWillBeSent", {
    requestId: "lost",
    request: { method: "POST", url, postData },
  });
  emit("Network.loadingFailed", {
    requestId: "lost",
    errorText: "net::ERR_CONNECTION_RESET",
    canceled: false,
  });
  emit("Network.requestWillBeSent", {
    requestId: "reconciled",
    request: { method: "POST", url, postData },
  });
  emit("Network.responseReceived", {
    requestId: "reconciled",
    response: { status: 200, url },
  });
  emit("Network.loadingFinished", { requestId: "reconciled" });
  await capture.settle();

  assert.equal(capture.failedRequests[0].url, url);
  assert.equal(capture.failedRequests[0].postData, postData);
  const recovery = replayCommandTransportRecoveryContract(capture);
  assert.equal(recovery.passed, true);
  assert.equal(recovery.recoveries[0].failureKind, "NETWORK_LOADING_FAILED");
  assert.equal(replayApiConcurrencyContract(capture).passed, true);
  assert.equal(replayCommandResponseIdentityContract(capture).passed, true);
});

test("formal replay command transport recovery permits at most one loss", () => {
  const requests = [];
  const responses = [];
  const bodies = [];
  for (const index of [1, 2]) {
    const url = `http://127.0.0.1/api/v1/replay/runs/session/session-${index}/commands`;
    const postData = JSON.stringify({
      protocol: "replay.v1",
      command_id: `command-loss-${index}`,
      expected_revision: 0,
      type: "pause",
      payload: {},
    });
    requests.push(
      { requestId: `lost-${index}`, method: "POST", url, postData },
      { requestId: `retry-${index}`, method: "POST", url, postData },
    );
    responses.push(
      { requestId: `lost-${index}`, method: "POST", url, status: 500 },
      { requestId: `retry-${index}`, method: "POST", url, status: 200 },
    );
    bodies.push(
      { requestId: `lost-${index}`, method: "POST", url, status: 500, body: "" },
      {
        requestId: `retry-${index}`,
        method: "POST",
        url,
        status: 200,
        body: JSON.stringify({
          protocol: "replay.v1",
          session_id: `session-${index}`,
          command_id: `command-loss-${index}`,
          revision: 1,
        }),
      },
    );
  }
  const capture = {
    replayApiResponses: responses.filter((item) => item.status >= 400),
    replayApiResponseBodies: bodies.filter((item) => item.status >= 400),
    replayCommandRequests: requests,
    replayCommandResponses: responses,
    replayCommandResponseBodies: bodies,
  };

  const recovery = replayCommandTransportRecoveryContract(capture);
  assert.equal(recovery.passed, false);
  assert.equal(recovery.recoveryCount, 2);
  assert.equal(recovery.violations[0].reason, "COMMAND_TRANSPORT_RECOVERY_LIMIT_EXCEEDED");
  assert.equal(replayApiConcurrencyContract(capture).passed, false);
  assert.equal(replayCommandResponseIdentityContract(capture).passed, false);
});

test("replay command response identity contract rejects a stale 200 body", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/commands";
  const identity = replayCommandResponseIdentityContract({
    replayCommandRequests: [{
      requestId: "command-1",
      method: "POST",
      url,
      postData: JSON.stringify({
        protocol: "replay.v3",
        run_id: "run-1",
        command_id: "set-speed-1",
        type: "set_speed",
      }),
    }],
    replayCommandResponses: [{
      requestId: "command-1",
      method: "POST",
      url,
      status: 200,
    }],
    replayCommandResponseBodies: [{
      requestId: "command-1",
      method: "POST",
      url,
      status: 200,
      body: JSON.stringify({
        protocol: "replay.v3",
        run_id: "run-1",
        command_id: "pause-before-set-speed",
      }),
    }],
  });

  assert.equal(identity.passed, false);
  assert.equal(identity.violations.length, 1);
  assert.equal(
    identity.violations[0].reason,
    "COMMAND_RESPONSE_IDENTITY_MISMATCH",
  );
  assert.equal(identity.violations[0].requestCommandId, "set-speed-1");
  assert.equal(
    identity.violations[0].responseCommandId,
    "pause-before-set-speed",
  );
});

test("replay API contract accepts one classified catalog epoch conflict followed by 201", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/markets";
  const result = replayApiConcurrencyContract({
    replayApiResponses: [
      { requestId: "conflict", method: "POST", url, status: 409 },
      { requestId: "retry", method: "POST", url, status: 201 },
    ],
    replayApiResponseBodies: [
      {
        requestId: "conflict",
        method: "POST",
        url,
        status: 409,
        body: JSON.stringify({
          protocol: "replay.v3",
          error: {
            code: "CATALOG_EPOCH_MISMATCH",
            message: "catalog changed",
            details: {},
          },
        }),
      },
    ],
  });

  assert.equal(result.passed, true);
  assert.equal(result.catalogEpochConflictCount, 1);
  assert.equal(result.catalogEpochConflicts[0].retryRequestId, "retry");
  assert.deepEqual(result.unexpectedFailures, []);
});

test("replay API contract rejects unrelated replay conflicts", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/markets";
  const result = replayApiConcurrencyContract({
    replayApiResponses: [
      { requestId: "busy", method: "POST", url, status: 409 },
    ],
    replayApiResponseBodies: [
      {
        requestId: "busy",
        method: "POST",
        url,
        status: 409,
        body: JSON.stringify({
          protocol: "replay.v3",
          error: {
            code: "TRAINING_RUN_BUSY",
            message: "run busy",
            details: {},
          },
        }),
      },
    ],
  });

  assert.equal(result.passed, false);
  assert.equal(result.catalogEpochConflictCount, 0);
  assert.equal(result.unexpectedFailures[0].reason, "UNEXPECTED_REPLAY_API_FAILURE");
  assert.equal(result.unexpectedFailures[0].responseBody.error.code, "TRAINING_RUN_BUSY");
});

test("replay API contract rejects catalog conflicts without a successful retry", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/markets";
  const result = replayApiConcurrencyContract({
    replayApiResponses: [
      { requestId: "conflict", method: "POST", url, status: 409 },
    ],
    replayApiResponseBodies: [
      {
        requestId: "conflict",
        method: "POST",
        url,
        status: 409,
        body: JSON.stringify({
          protocol: "replay.v3",
          error: {
            code: "CATALOG_EPOCH_MISMATCH",
            message: "catalog changed",
            details: {},
          },
        }),
      },
    ],
  });

  assert.equal(result.passed, false);
  assert.equal(
    result.unexpectedFailures[0].reason,
    "CATALOG_EPOCH_RETRY_DID_NOT_SUCCEED",
  );
});

test("replay API contract rejects a second catalog epoch conflict", () => {
  const url = "http://127.0.0.1/api/v1/replay/runs/run-1/markets";
  const errorBody = JSON.stringify({
    protocol: "replay.v3",
    error: {
      code: "CATALOG_EPOCH_MISMATCH",
      message: "catalog changed",
      details: {},
    },
  });
  const result = replayApiConcurrencyContract({
    replayApiResponses: [
      { requestId: "conflict-1", method: "POST", url, status: 409 },
      { requestId: "conflict-2", method: "POST", url, status: 409 },
      { requestId: "retry", method: "POST", url, status: 201 },
    ],
    replayApiResponseBodies: [
      { requestId: "conflict-1", method: "POST", url, status: 409, body: errorBody },
      { requestId: "conflict-2", method: "POST", url, status: 409, body: errorBody },
    ],
  });

  assert.equal(result.passed, false);
  assert.equal(result.catalogEpochConflictCount, 1);
  assert.equal(result.unexpectedFailures[0].reason, "CATALOG_EPOCH_RETRY_EXCEEDED");
});

test("replay soak product heap checkpoints suspend and restore Network inspection", async () => {
  const calls = [];
  const cdp = {
    async send(name, payload = {}) {
      calls.push({ name, payload });
      return {};
    },
  };

  const value = await withNetworkInspectorSuspended(cdp, async () => {
    calls.push({ name: "measure", payload: {} });
    return 42;
  });

  assert.equal(value, 42);
  assert.deepEqual(calls, [
    { name: "Network.disable", payload: {} },
    { name: "measure", payload: {} },
    { name: "Network.enable", payload: {} },
    { name: "Network.setCacheDisabled", payload: { cacheDisabled: true } },
  ]);
});

test("replay soak final product heap checkpoint leaves Network inspection disabled", async () => {
  const calls = [];
  const cdp = {
    async send(name) {
      calls.push(name);
      return {};
    },
  };

  await assert.rejects(
    () => withNetworkInspectorSuspended(
      cdp,
      async () => { throw new Error("heap probe failed"); },
      { resume: false },
    ),
    /heap probe failed/,
  );
  assert.deepEqual(calls, ["Network.disable"]);
});

test("replay soak diagnostic heap snapshot streams chunks and unregisters its handler", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-replay-heap-"));
  const outputPath = path.join(directory, "primary.heapsnapshot");
  const handlers = new Map();
  const calls = [];
  const cdp = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    off(name, handler) {
      assert.equal(handlers.get(name), handler);
      handlers.delete(name);
    },
    async send(name, payload = {}, timeoutMs = undefined) {
      calls.push({ name, payload, timeoutMs });
      if (name === "HeapProfiler.takeHeapSnapshot") {
        handlers.get("HeapProfiler.addHeapSnapshotChunk")?.({ chunk: "{\"snapshot\":" });
        handlers.get("HeapProfiler.addHeapSnapshotChunk")?.({ chunk: "true}" });
      }
      return {};
    },
  };

  try {
    const result = await writeHeapSnapshot(cdp, outputPath);
    assert.equal(fs.readFileSync(outputPath, "utf8"), '{"snapshot":true}');
    assert.deepEqual(result, { path: outputPath, chunks: 2, bytes: 17 });
    assert.equal(handlers.size, 0);
    assert.deepEqual(calls, [
      { name: "HeapProfiler.collectGarbage", payload: {}, timeoutMs: undefined },
      {
        name: "HeapProfiler.takeHeapSnapshot",
        payload: { reportProgress: false, captureNumericValue: true },
        timeoutMs: 600_000,
      },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("replay soak product heap evidence uses clean lifecycle state nearest half duration", () => {
  const metrics = (usedSize) => ({ heap: { usedSize } });
  const evidence = replayProductHeapEvidence({
    initialMetrics: metrics(10),
    finalMetrics: metrics(35),
    durationMs: 1_000,
    lifecycleCycles: [
      { index: 1, elapsedFromStartMs: 400, afterMetrics: metrics(20) },
      { index: 2, elapsedFromStartMs: 600, afterMetrics: metrics(22) },
      { index: 3, elapsedFromStartMs: 900, afterMetrics: metrics(30) },
    ],
  });

  assert.equal(evidence.measurement, "network-inspector-suspended-forced-gc");
  assert.equal(evidence.half.cycleIndex, 1);
  assert.equal(evidence.half.targetElapsedMs, 500);
  assert.equal(evidence.primaryHeapGrowthBytes, 25);
  assert.equal(evidence.lateHeapGrowthBytes, 15);
  assert.throws(
    () => replayProductHeapEvidence({
      initialMetrics: metrics(10),
      finalMetrics: metrics(20),
      durationMs: 1_000,
      lifecycleCycles: [],
    }),
    /requires a clean lifecycle checkpoint/,
  );
});

test("replay soak network gate isolates verified host injection without allowing other origins", () => {
  const frontendOrigin = "http://127.0.0.1:4173";
  const classified = assertReplayNetwork({
    requests: [
      { url: `${frontendOrigin}/api/v1/replay/runs/run-1` },
      { url: "data:image/svg+xml;base64,PHN2Zy8+" },
      { url: "http://gc.kis.v2.scr.kaspersky-labs.com/id/main.js" },
    ],
    webSockets: [
      "ws://127.0.0.1:4173/api/v1/stream/replay/session-1",
      "ws://gc.kis.v2.scr.kaspersky-labs.com/id/websocket",
    ],
  }, frontendOrigin);

  assert.equal(classified.passed, true);
  assert.equal(classified.applicationRequests, 1);
  assert.equal(classified.embeddedRequests, 1);
  assert.deepEqual(classified.hostSecurityInjection, {
    host: "gc.kis.v2.scr.kaspersky-labs.com",
    requests: 1,
    sockets: 1,
    buildReferences: 0,
  });
  assert.throws(() => assertReplayNetwork({
    requests: [{ url: "https://example.com/runtime.js" }],
    webSockets: [],
  }, frontendOrigin), /forbidden HTTP/);
});

test("replay soak bounds order advisory amplification by lifecycle count", () => {
  const request = (kind) => ({
    method: "POST",
    url: `http://127.0.0.1:4173/api/v1/replay/runs/run-1/order-${kind}`,
  });
  const bounded = replayOrderAdvisoryRequestContract({
    requests: [
      ...Array.from({ length: 12 }, () => request("capacity")),
      ...Array.from({ length: 8 }, () => request("preview")),
      { method: "GET", url: "http://127.0.0.1:4173/api/v1/replay/runs/run-1" },
    ],
  }, 2);

  assert.deepEqual(bounded.counts, { capacity: 12, preview: 8 });
  assert.equal(bounded.requestCount, 20);
  assert.equal(bounded.semanticRequestCount, 2);
  assert.equal(bounded.duplicateRequestCount, 18);
  assert.equal(bounded.maximumRequests, 44);
  assert.equal(bounded.passed, true);

  const amplified = replayOrderAdvisoryRequestContract({
    requests: Array.from({ length: 1_000 }, () => request("capacity")),
  }, 10);
  assert.equal(amplified.maximumRequests, 140);
  assert.equal(amplified.semanticRequestCount, 1);
  assert.equal(amplified.duplicateRequestCount, 999);
  assert.equal(amplified.passed, false);
  assert.throws(
    () => replayOrderAdvisoryRequestContract({ requests: [] }, 0),
    /cycles must be a positive safe integer/,
  );
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

test("formal HEDGE soak emits a strict boolean exact-binding acceptance", () => {
  const fixture = { source_profile: "HEDGE_EXACT_ARCHIVE_QA" };
  const binding = {
    payloadBound: true,
    requiredRows: 43_400,
    forwardCacheMs: 2_592_000_000,
    inputFidelity: "PINNED_PUBLIC_EXACT_PRIVATE_DETERMINISTIC_SIMULATION",
    fallbackApplied: false,
    publicRefs: {
      BTCUSDT: { archive_id: "btc-public" },
      ETHUSDT: { archive_id: "eth-public" },
    },
    simulationRef: { manifest_id: "simulation-v1" },
  };

  const accepted = isExactHedgeTrainingBound(fixture, binding);
  assert.equal(accepted, true);
  assert.equal(typeof accepted, "boolean");
  assert.equal(
    isExactHedgeTrainingBound(fixture, { ...binding, simulationRef: null }),
    false,
  );
  assert.equal(
    isExactHedgeTrainingBound(fixture, {
      ...binding,
      publicRefs: { BTCUSDT: binding.publicRefs.BTCUSDT },
    }),
    false,
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

test("replay soak failure evidence retains the failed primary actor", () => {
  const actor = {
    state: "ERROR",
    runtime_failures: 1,
    last_runtime_error_type: "ValueError",
    last_runtime_error_message: "injected failure",
  };
  const backend = {
    replay: {
      sessions: { primary: actor },
      persistence: { degraded: false, transaction_failures: 0 },
      reaper_failures: 0,
      recovery_failures: 0,
      shutdown_failures: 0,
    },
  };
  const status = { connection: "connected", state: "ERROR", sourceSequence: 327 };

  assert.deepEqual(
    primaryReplayFailureDiagnostics({
      backend,
      phase: "primary-replay-sample",
      sessionId: "primary",
      status,
    }),
    {
      phase: "primary-replay-sample",
      status,
      actor,
      backendHealth: {
        checks: {
          diagnostics_contract: true,
          persistence_not_degraded: true,
          persistence_transactions_clean: true,
          reaper_clean: true,
          recovery_clean: true,
          shutdown_clean: true,
        },
        passed: true,
        counters: {
          persistenceDegraded: false,
          persistenceTransactionFailures: 0,
          reaperFailures: 0,
          recoveryFailures: 0,
          shutdownFailures: 0,
        },
      },
    },
  );
});

test("replay soak acceptance failure evidence retains the completed result", () => {
  const partialResult = {
    schema_version: "replay-v2-browser-soak.v1",
    passed: false,
    replay: {
      primaryHeapGrowthBytes: 70 * 1024 * 1024,
      lateHeapGrowthBytes: 40 * 1024 * 1024,
    },
    samples: [
      { elapsedMs: 0, replay: { heap: { usedSize: 10 } } },
      { elapsedMs: 1, replay: { heap: { usedSize: 20 } } },
    ],
  };
  const evidence = browserSoakFailureEvidence({
    releaseEvidence: {
      recorded_at: "2026-08-08T00:00:00.000Z",
      evidence: { commit: "abc" },
    },
    error: new Error("browser soak acceptance failed"),
    phaseDiagnostics: null,
    partialResult,
    frontendRuntime: { mode: "production" },
    backendTail: { lines: [] },
    viteTail: { lines: [] },
    chromeTail: { lines: [] },
  });

  assert.equal(evidence.passed, false);
  assert.match(evidence.error, /browser soak acceptance failed/);
  assert.equal(evidence.phaseDiagnostics, null);
  assert.equal(evidence.partialResult, partialResult);
  assert.equal(evidence.partialResult.samples.length, 2);
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
