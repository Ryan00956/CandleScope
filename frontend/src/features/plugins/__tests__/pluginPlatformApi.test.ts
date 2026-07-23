import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadPluginUserFile,
  parsePluginSettingsValue,
  preparePluginUserFileSave,
  sandboxPluginAssetUrl,
  setPaperKillSwitch,
  stagePluginUserFile,
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
  const calls: Array<{ url: string; options: RequestInit }> = [];
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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }

  assert.equal(calls.length, 4);
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
});
