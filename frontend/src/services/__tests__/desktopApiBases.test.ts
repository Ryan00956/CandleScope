import assert from "node:assert/strict";
import test from "node:test";

test("replay and backtest use the desktop backend for HTTP, history and WebSockets", async () => {
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.window = { candlescopeDesktop: { apiBase: "http://127.0.0.1:28080/api/v1" } } as unknown as Window & typeof globalThis;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { ReplayApiClient } = await import("../../features/replay/replayApi.js");
    const { ReplayV2ApiClient } = await import("../../features/replay/replayV2Api.js");
    const { createBacktestApi } = await import("../../features/backtest/backtestApi.js");
    const { buildReplayStreamUrl } = await import("../../features/replay/replayStreamController.js");
    const { buildReplayTrainingRunStreamUrl } = await import("../../features/replay/replayTrainingRunStream.js");
    await assert.rejects(new ReplayApiClient().capabilities());
    await assert.rejects(new ReplayV2ApiClient().capabilities());
    await assert.rejects(createBacktestApi().capabilities());
    assert.ok(urls.every((url) => url.startsWith("http://127.0.0.1:28080/api/v1/")));
    const location = { protocol: "file:", host: "" };
    assert.equal(buildReplayStreamUrl({ sessionId: "session-one", location }), "ws://127.0.0.1:28080/api/v1/stream/replay/session-one");
    assert.ok(buildReplayTrainingRunStreamUrl({ runId: "run-one", location }).startsWith("ws://127.0.0.1:28080/api/v1/stream/replay/runs/run-one?"));
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});
