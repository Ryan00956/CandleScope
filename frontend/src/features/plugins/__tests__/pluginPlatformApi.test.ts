import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadPluginUserFile,
  fetchLiveAuditExport,
  issueLiveConfirmation,
  killLiveControl,
  parsePluginSettingsValue,
  prepareLocalPluginInstall,
  previewLiveConfirmation,
  preparePluginUserFileSave,
  sandboxPluginAssetUrl,
  revokeLiveAuthority,
  reviewLocalPluginInstall,
  reviewPluginTrustChange,
  confirmLocalPluginInstall,
  confirmPluginTrustChange,
  setLiveControlMode,
  setPaperKillSwitch,
  stagePluginUserFile,
  syncPluginChartContext,
} from "../pluginPlatformApi.js";

test("settings API unwraps the validated value from its revision envelope", () => {
  assert.deepEqual(parsePluginSettingsValue({
    settings: {
      pluginId: "candlescope.market-scanner",
      contributionId: "candlescope.market-scanner.settings",
      value: { interval: "1h", symbolsLimit: 2 },
      schemaSha256: "sha256:abc",
      storeRevision: 4,
    },
  }), { interval: "1h", symbolsLimit: 2 });
});

test("settings API fails closed when the revision envelope has no object value", () => {
  assert.throws(
    () => parsePluginSettingsValue({ settings: { storeRevision: 4 } }),
    /invalid/i,
  );
  assert.throws(
    () => parsePluginSettingsValue({ settings: { value: ["1h"] } }),
    /invalid/i,
  );
});

test("sandbox asset URLs are digest-addressed and reject path confusion", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  assert.equal(
    sandboxPluginAssetUrl("acme.sandbox", digest, "nested/index.html"),
    `/api/v2/plugins/assets/acme.sandbox/${"b".repeat(64)}/nested/index.html`,
  );
  assert.throws(() => sandboxPluginAssetUrl("acme.sandbox", digest, "../index.html"), /invalid/);
  assert.throws(() => sandboxPluginAssetUrl("acme.sandbox", "sha256:abc", "index.html"), /invalid/);
  assert.throws(() => sandboxPluginAssetUrl("sandbox", digest, "index.html"), /invalid/);
});

test("user-selected file APIs send bytes only through the guarded Host gateway", async () => {
  const sessionToken = "phase9-session-token-0123456789abcdef";
  const csrfToken = "phase9-csrf-token-0123456789abcdefghi";
  const handle = `ufh_${"a".repeat(43)}`;
  const downloadId = `ufd_${"b".repeat(43)}`;
  const liveStatus = {
    schemaVersion: "candlescope.live-control-status/1",
    available: true,
    mode: "armed",
    generation: 2,
    policyEpoch: 1,
    updatedAt: "2026-07-23T01:02:03Z",
    outstandingConfirmationCount: 0,
    confirmationCounts: { consumed: 0, expired: 0, issued: 0, revoked: 0 },
    eventSequence: 3,
    eventSha256: `sha256:${"a".repeat(64)}`,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
    liveTransferAvailable: false,
  };
  const preview = {
    schemaVersion: "candlescope.live-confirmation-preview/1",
    intentSha256: `sha256:${"b".repeat(64)}`,
    pluginId: "candlescope.okx-demo",
    connectorId: "candlescope.okx-demo-readonly",
    publisherIdentity: "publisher:test",
    version: "1.0.0",
    clientOrderId: "C".repeat(32),
    instrumentId: "BTC-USDT",
    side: "buy",
    orderType: "limit",
    quantity: "1",
    limitPrice: "42000",
    policyEpoch: 1,
    controlGeneration: 2,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
  };
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const auditBlob = new Blob(
    ['{"schemaVersion":"candlescope.live-audit-export/1"}'],
    { type: "application/json" },
  );
  const responses = [
    new Response(JSON.stringify({
      fileSelection: {
        handle,
        name: "input.json",
        mediaType: "application/json",
        maxBytes: 131_072,
        expiresInSeconds: 300,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      fileSelection: {
        handle: `ufh_${"c".repeat(43)}`,
        name: "report.json",
        mediaType: "application/json",
        maxBytes: 131_072,
        expiresInSeconds: 300,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(new Blob(["saved-by-host"], { type: "application/json" }), {
      status: 200,
      headers: { "Content-Length": "13", "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({
      schemaVersion: "candlescope.paper-status/1",
      killSwitchEnabled: true,
      changed: true,
      cancelledOpenOrders: 0,
      auditEventId: "audit-1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify(liveStatus), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      ...liveStatus,
      mode: "killed",
      generation: 3,
      policyEpoch: 2,
      revokedConfirmationCount: 0,
      revocation: { advanced: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      ...liveStatus,
      mode: "killed",
      generation: 4,
      policyEpoch: 3,
      scopeType: "publisher",
      revokedConfirmationCount: 0,
      revocation: { advanced: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify(preview), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      ...preview,
      schemaVersion: "candlescope.live-confirmation/1",
      receiptRef: `livecfm_${"R".repeat(43)}`,
      receiptId: "c".repeat(32),
      state: "issued",
      issuedAt: "2026-07-23T01:02:03Z",
      expiresAt: "2026-07-23T01:03:03Z",
      resolvedAt: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(auditBlob, {
      status: 200,
      headers: {
        "Content-Length": String(auditBlob.size),
        "Content-Type": "application/json",
      },
    }),
    new Response(JSON.stringify({
      schemaVersion: "candlescope.chart-context/1",
      chartId: "main-chart",
      revision: 1,
      active: true,
      context: { mode: "live", exchange: "binance", marketType: "spot" },
      series: { symbol: "BTCUSDT", interval: "1m" },
      updatedAtMs: 1_700_000_000_000,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  ];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CANDLESCOPE_PLUGIN_MANAGEMENT_V1__: {
        apiBase: "http://127.0.0.1:8000/api/v2/plugins",
        sessionToken,
        csrfToken,
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(input), options });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  try {
    const file = new File(["{}"], "input.json", { type: "application/json" });
    assert.equal(
      (await stagePluginUserFile("candlescope.integration-gateway.import-file", "fileHandle", file)).handle,
      handle,
    );
    assert.equal(
      (await preparePluginUserFileSave("candlescope.integration-gateway.export-file", "fileHandle")).name,
      "report.json",
    );
    assert.equal((await downloadPluginUserFile("candlescope.integration-gateway", downloadId)).size, 13);
    await setPaperKillSwitch(true);
    assert.equal((await setLiveControlMode("armed", "operator-arm", false)).mode, "armed");
    assert.equal((await killLiveControl("operator-kill")).mode, "killed");
    assert.equal(
      (await revokeLiveAuthority("publisher", "publisher:test", "publisher-revoked")).policyEpoch,
      3,
    );
    const loadedPreview = await previewLiveConfirmation(
      `acct_${"A".repeat(43)}`,
      `shdw_${"B".repeat(43)}`,
    );
    assert.equal(loadedPreview.intentSha256, preview.intentSha256);
    assert.equal(
      (await issueLiveConfirmation(
        `acct_${"A".repeat(43)}`,
        `shdw_${"B".repeat(43)}`,
        loadedPreview,
      )).state,
      "issued",
    );
    assert.ok((await fetchLiveAuditExport()).size > 0);
    assert.equal((await syncPluginChartContext({
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
    })).revision, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }

  assert.equal(calls.length, 11);
  const upload = calls[0]!;
  assert.match(upload.url, /\/manage\/files\/open\?contributionId=candlescope\.integration-gateway\.import-file&field=fileHandle$/);
  assert.ok(upload.options.body instanceof File);
  const uploadHeaders = upload.options.headers as Record<string, string>;
  assert.equal(uploadHeaders["Content-Type"], "application/json");
  assert.equal(uploadHeaders["X-CandleScope-File-Name"], "input.json");
  assert.equal(uploadHeaders["X-CandleScope-Plugin-Session"], sessionToken);
  assert.equal(uploadHeaders["X-CandleScope-CSRF"], csrfToken);
  assert.match(uploadHeaders["X-CandleScope-User-Action"] ?? "", /^select-plugin-file-/);
  assert.equal(upload.options.credentials, "omit");

  const save = calls[1]!;
  assert.match(save.url, /\/manage\/files\/save$/);
  assert.deepEqual(JSON.parse(String(save.options.body)), {
    contributionId: "candlescope.integration-gateway.export-file",
    field: "fileHandle",
  });
  const download = calls[2]!;
  assert.match(download.url, /\/manage\/files\/download$/);
  assert.deepEqual(JSON.parse(String(download.options.body)), {
    pluginId: "candlescope.integration-gateway",
    downloadId,
  });
  const killSwitch = calls[3]!;
  assert.match(killSwitch.url, /\/manage\/paper\/kill-switch$/);
  assert.deepEqual(JSON.parse(String(killSwitch.options.body)), { enabled: true });
  assert.match(
    (killSwitch.options.headers as Record<string, string>)["X-CandleScope-User-Action"] ?? "",
    /^paper-kill-switch-/,
  );
  const liveArm = calls[4]!;
  assert.match(liveArm.url, /\/manage\/live\/control$/);
  assert.deepEqual(JSON.parse(String(liveArm.options.body)), {
    mode: "armed",
    reason: "operator-arm",
    acknowledgeKill: false,
  });
  assert.match(
    (liveArm.options.headers as Record<string, string>)["X-CandleScope-User-Action"] ?? "",
    /^live-control-arm-/,
  );
  const confirmation = calls[8]!;
  assert.match(confirmation.url, /\/manage\/live\/confirmations\/issue$/);
  assert.deepEqual(JSON.parse(String(confirmation.options.body)), {
    accountRef: `acct_${"A".repeat(43)}`,
    shadowRef: `shdw_${"B".repeat(43)}`,
    expectedIntentSha256: preview.intentSha256,
    expectedPolicyEpoch: 1,
    expectedControlGeneration: 2,
    ttlSeconds: 60,
  });
  const audit = calls[9]!;
  assert.match(audit.url, /\/manage\/live\/audit-export$/);
  assert.equal(audit.options.method, "GET");
  assert.equal(
    (audit.options.headers as Record<string, string>)["X-CandleScope-CSRF"],
    undefined,
  );
  const chartContext = calls[10]!;
  assert.match(chartContext.url, /\/manage\/chart-context$/);
  assert.equal(chartContext.options.method, "PUT");
  const chartHeaders = chartContext.options.headers as Record<string, string>;
  assert.equal(chartHeaders["X-CandleScope-Plugin-Session"], sessionToken);
  assert.equal(chartHeaders["X-CandleScope-CSRF"], csrfToken);
  assert.equal(chartHeaders["X-CandleScope-User-Action"], undefined);
});

test("Phase 6 trust APIs use fresh guarded user actions for both confirmations", async () => {
  const sessionToken = "phase6-session-token-0123456789abcdef";
  const csrfToken = "phase6-csrf-token-0123456789abcdefghij";
  const profile = {
    profileId: "restricted-python-v1",
    runtimeKind: "python-module",
    sandboxMode: "windows-appcontainer",
    sandboxSupported: true,
    trustedLocalOnly: false,
    networkDefault: "denied",
    subprocessDeclared: false,
    limits: { maxProcesses: 1 },
  };
  const entrypoint = {
    entrypointId: "main",
    runtimeKind: "python-module",
    runtimeId: "python-host",
    descriptor: { kind: "python-module", runtimeId: "python-host", pythonModule: "example.entrypoint" },
    pluginArtifactSha256: null,
    runtimeArtifactSha256: `sha256:${"1".repeat(64)}`,
    runtimeArtifactSize: 1024,
    supplySource: "host-python",
    hostManaged: true,
    registrySha256: null,
    systemRuntimePath: "C:\\Python\\python.exe",
    signatureRoot: "host-python:3.12",
    profile,
  };
  const authorization = (mode: "marketplace-sandboxed" | "trusted-local", signed = false) => ({
    runtimeIdentity: `sha256:${"2".repeat(64)}`,
    authorizationIdentity: `sha256:${(mode === "trusted-local" ? "3" : "4").repeat(64)}`,
    mode,
    entrypoints: [entrypoint],
    signatureRoots: signed
      ? ["host-python:3.12", `publisher-key:ed25519:${"a".repeat(64)}`]
      : ["host-python:3.12"],
    sandbox: {
      requested: mode === "marketplace-sandboxed",
      active: mode === "marketplace-sandboxed",
      status: mode === "marketplace-sandboxed" ? "windows-appcontainer" : "trusted-local-user-approved",
      supported: true,
      trustedLocalOnly: false,
      profiles: [profile],
    },
  });
  const requests = {
    permissions: [],
    network: { requested: false, permissionIds: [] },
    files: { requested: false, permissionIds: [] },
    secrets: { requested: false, permissionIds: [] },
    accounts: { requested: false, permissionIds: [] },
    trading: { requested: false, permissionIds: [] },
    subprocess: { requested: false, declared: false, maxProcesses: 1, reason: "No process model is declared." },
    liveAuthority: { grantedByTrust: false, independentlyProtected: true },
  };
  const acknowledgements = [
    "execute-local-code",
    "live-authority-separate",
    "runtime:main:python-module:python-host",
    "sandbox-status",
  ];
  const trusted = authorization("trusted-local");
  const candidate = {
    candidateId: `candidate-${"b".repeat(32)}`,
    previewSha256: `sha256:${"5".repeat(64)}`,
    expiresAt: "2026-08-03T12:15:00Z",
    preview: {
      schemaVersion: "candlescope.plugin-trust-preview/1",
      plugin: {
        id: "candlescope.phase6-example",
        name: "Phase 6 Example",
        version: "0.1.0",
        publisher: "candlescope",
        bundleSha256: `sha256:${"6".repeat(64)}`,
        manifestSha256: `sha256:${"7".repeat(64)}`,
      },
      source: {
        rawTrustLevel: "local-developer",
        canonicalDefault: "developer-local",
        publisherIdentity: "manifest:candlescope",
        source: "local-file",
        marketplaceId: null,
        signatureRoot: null,
      },
      authorization: trusted,
      permissionDiff: {
        pluginId: "candlescope.phase6-example",
        publisherIdentityChanged: false,
        majorVersionChanged: false,
        bundleChanged: true,
        authorizationIdentityChanged: false,
        requiresConfirmation: false,
        permissions: [],
      },
      runtimeDiff: {
        changed: true,
        requiresConfirmation: true,
        kindOrIdChanged: true,
        signatureRootChanged: true,
        systemRuntimePathChanged: true,
        supplyChanged: true,
        previous: [],
        current: trusted.entrypoints,
      },
      requests,
      requiredAcknowledgements: acknowledgements,
      warning: "Local code runs as the current user; Live authority remains separate.",
    },
  };
  const localReview = {
    candidateId: candidate.candidateId,
    previewSha256: candidate.previewSha256,
    confirmationToken: `trust-review-${"R".repeat(43)}`,
    expiresAt: "2026-08-03T12:10:00Z",
    confirmationStep: 1,
  };
  const sandboxed = authorization("marketplace-sandboxed", true);
  const signedTrusted = authorization("trusted-local", true);
  const trustChange = {
    changeId: `trust-change-${"c".repeat(32)}`,
    previewSha256: `sha256:${"8".repeat(64)}`,
    confirmationToken: `trust-change-${"T".repeat(43)}`,
    expiresAt: "2026-08-03T12:10:00Z",
    preview: {
      schemaVersion: "candlescope.plugin-trust-preview/1",
      action: "trust-change",
      pluginId: "candlescope.phase6-example",
      bundleSha256: candidate.preview.plugin.bundleSha256,
      source: {
        rawTrustLevel: "verified-publisher",
        canonicalDefault: "marketplace-sandboxed",
        publisherIdentity: `publisher-key:ed25519:${"a".repeat(64)}`,
        source: "signed-marketplace",
        marketplaceId: "candlescope.community",
        signatureRoot: `publisher-key:ed25519:${"a".repeat(64)}`,
      },
      from: sandboxed,
      to: signedTrusted,
      permissionDiff: {
        pluginId: "candlescope.phase6-example",
        publisherIdentityChanged: false,
        majorVersionChanged: false,
        bundleChanged: false,
        authorizationIdentityChanged: true,
        requiresConfirmation: true,
        permissions: [],
      },
      runtimeDiff: {
        changed: false,
        requiresConfirmation: false,
        kindOrIdChanged: false,
        signatureRootChanged: false,
        systemRuntimePathChanged: false,
        supplyChanged: false,
        previous: sandboxed.entrypoints,
        current: signedTrusted.entrypoints,
      },
      requests,
      requiredAcknowledgements: acknowledgements,
    },
  };
  const responses = [candidate, localReview, {}, trustChange, {}].map(
    (value) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDateNow = Date.now;
  const originalRandom = Math.random;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CANDLESCOPE_PLUGIN_MANAGEMENT_V1__: {
        apiBase: "http://127.0.0.1:8000/api/v2/plugins",
        sessionToken,
        csrfToken,
      },
    },
  });
  Date.now = () => 1_785_744_000_000;
  Math.random = () => 0.125;
  globalThis.fetch = (async (input: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(input), options });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  try {
    const file = new File(["phase6"], "phase6.cspkg", { type: "application/vnd.candlescope.plugin+zip" });
    const prepared = await prepareLocalPluginInstall(file);
    const reviewed = await reviewLocalPluginInstall(
      prepared.candidateId,
      prepared.previewSha256,
      "Review the exact local runtime before execution.",
      acknowledgements,
    );
    await confirmLocalPluginInstall(
      prepared.candidateId,
      prepared.previewSha256,
      reviewed.confirmationToken,
    );
    const changed = await reviewPluginTrustChange(
      "candlescope.phase6-example",
      "trusted-local",
      "Run this exact signed artifact as local code.",
      acknowledgements,
    );
    await confirmPluginTrustChange(
      "candlescope.phase6-example",
      changed.changeId,
      changed.previewSha256,
      changed.confirmationToken,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    Math.random = originalRandom;
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }

  assert.equal(calls.length, 5);
  assert.match(calls[0]!.url, /\/manage\/install\/prepare$/);
  assert.ok(calls[0]!.options.body instanceof File);
  assert.match(calls[1]!.url, /\/manage\/install\/review$/);
  assert.match(calls[2]!.url, /\/manage\/install\/confirm$/);
  assert.match(calls[3]!.url, /\/manage\/candlescope\.phase6-example\/trust\/review$/);
  assert.match(calls[4]!.url, /\/manage\/candlescope\.phase6-example\/trust\/confirm$/);
  const actionIds = calls.map(
    (call) => (call.options.headers as Record<string, string>)["X-CandleScope-User-Action"],
  );
  assert.equal(new Set(actionIds).size, 5, "every confirmation must use a distinct Host user action");
  assert.match(actionIds[0] ?? "", /^install-prepare-/);
  assert.match(actionIds[1] ?? "", /^install-review-/);
  assert.match(actionIds[2] ?? "", /^install-confirm-/);
  assert.match(actionIds[3] ?? "", /^trust-change-review-/);
  assert.match(actionIds[4] ?? "", /^trust-change-confirm-/);
  const observedHeaders = calls[0]!.options.headers as Record<string, string>;
  const observedSession = observedHeaders["X-CandleScope-Plugin-Session"] ?? "";
  const observedCsrf = observedHeaders["X-CandleScope-CSRF"] ?? "";
  assert.ok(observedSession.length >= 32);
  assert.ok(observedCsrf.length >= 32);
  assert.notEqual(observedSession, observedCsrf);
  for (const call of calls) {
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers["X-CandleScope-Plugin-Session"], observedSession);
    assert.equal(headers["X-CandleScope-CSRF"], observedCsrf);
    assert.equal(call.options.credentials, "omit");
  }
  assert.deepEqual(JSON.parse(String(calls[2]!.options.body)), {
    candidateId: candidate.candidateId,
    previewSha256: candidate.previewSha256,
    confirmationToken: localReview.confirmationToken,
  });
});
