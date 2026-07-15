import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWING_PERFORMANCE_RESET_STORAGE_TYPES,
  DRAWING_PERFORMANCE_RELOAD_MARKER_KEY,
  drawingPerformanceOrigin,
  drawingPerformanceStorageResetRequest,
  navigateToDrawingPerformanceScenario,
  reloadFreshDrawingPerformanceDocument,
  resetDrawingPerformanceOriginStorage,
} from "./drawing-performance-storage.mjs";

function runtimeResponse(value) {
  return { result: { result: { value: JSON.stringify(value) } } };
}

test("drawing perf reset targets only IndexedDB and localStorage for the app origin", () => {
  assert.equal(
    drawingPerformanceOrigin("http://127.0.0.1:15175/path?scenario=one#chart"),
    "http://127.0.0.1:15175",
  );
  assert.equal(DRAWING_PERFORMANCE_RESET_STORAGE_TYPES, "indexeddb,local_storage");
  assert.equal(DRAWING_PERFORMANCE_RESET_STORAGE_TYPES.includes("cookies"), false);
  assert.deepEqual(
    drawingPerformanceStorageResetRequest("https://example.test:8443/chart"),
    {
      origin: "https://example.test:8443",
      storageTypes: "indexeddb,local_storage",
    },
  );
});

test("drawing perf reset rejects non-origin and non-HTTP URLs", () => {
  assert.throws(() => drawingPerformanceOrigin("/relative"), /absolute URL/);
  assert.throws(() => drawingPerformanceOrigin("about:blank"), /HTTP\(S\) origin/);
  assert.throws(() => drawingPerformanceOrigin("file:///tmp/index.html"), /HTTP\(S\) origin/);
});

test("drawing perf scenario navigation clears the exact origin stores first", async () => {
  const calls = [];
  const result = await navigateToDrawingPerformanceScenario({
    async send(method, parameters) {
      calls.push({ method, parameters });
      return { method };
    },
  }, "http://127.0.0.1:15175/", "http://127.0.0.1:15175/?drawingPerf=fixture");

  assert.deepEqual(calls, [
    {
      method: "Storage.clearDataForOrigin",
      parameters: {
        origin: "http://127.0.0.1:15175",
        storageTypes: "indexeddb,local_storage",
      },
    },
    {
      method: "Page.navigate",
      parameters: { url: "http://127.0.0.1:15175/?drawingPerf=fixture" },
    },
  ]);
  assert.deepEqual(result.resetRequest, calls[0].parameters);
  assert.deepEqual(result.navigation, { method: "Page.navigate" });
});

test("drawing perf reset fails closed when CDP cannot clear storage", async () => {
  const failure = new Error("CDP rejected clear");
  await assert.rejects(
    resetDrawingPerformanceOriginStorage({
      async send() { throw failure; },
    }, "http://127.0.0.1:15175/"),
    (error) => {
      assert.match(error.message, /origin storage reset failed/);
      assert.equal(error.cause, failure);
      return true;
    },
  );
  await assert.rejects(
    resetDrawingPerformanceOriginStorage(null, "http://127.0.0.1:15175/"),
    /CDP client is unavailable/,
  );
});

test("drawing perf scenario navigation never navigates after reset failure", async () => {
  const calls = [];
  await assert.rejects(
    navigateToDrawingPerformanceScenario({
      async send(method) {
        calls.push(method);
        throw new Error("clear failed");
      },
    }, "http://127.0.0.1:15175/", "http://127.0.0.1:15175/?drawingPerf=fixture"),
    /origin storage reset failed/,
  );
  assert.deepEqual(calls, ["Storage.clearDataForOrigin"]);
});

test("drawing perf reload accepts only the marker executed by the new document", async () => {
  const calls = [];
  const generations = [
    { token: "old-marker", timeOrigin: 100, href: "http://example.test/", readyState: "complete" },
    { token: "old-marker", timeOrigin: 100, href: "http://example.test/", readyState: "complete" },
    { token: "new-marker", timeOrigin: 200, href: "http://example.test/", readyState: "loading" },
  ];
  const cdp = {
    async send(method, parameters) {
      calls.push({ method, parameters });
      if (method === "Runtime.evaluate") return runtimeResponse(generations.shift());
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        assert.match(parameters.source, new RegExp(DRAWING_PERFORMANCE_RELOAD_MARKER_KEY));
        assert.match(parameters.source, /new-marker/);
        return { result: { identifier: "reload-script-1" } };
      }
      return {};
    },
  };
  let clock = 0;
  const receipt = await reloadFreshDrawingPerformanceDocument(cdp, {
    timeoutMs: 100,
    pollIntervalMs: 5,
    markerToken: "new-marker",
    now: () => clock,
    wait: async (delayMs) => { clock += delayMs; },
  });

  assert.equal(receipt.previousTimeOrigin, 100);
  assert.equal(receipt.currentTimeOrigin, 200);
  assert.equal(receipt.markerToken, "new-marker");
  assert.deepEqual(calls.map(({ method }) => method), [
    "Runtime.evaluate",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.reload",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Page.removeScriptToEvaluateOnNewDocument",
  ]);
  assert.deepEqual(calls.at(-1).parameters, { identifier: "reload-script-1" });
});

test("drawing perf reload removes its marker after a fail-closed timeout", async () => {
  const calls = [];
  const cdp = {
    async send(method, parameters) {
      calls.push({ method, parameters });
      if (method === "Runtime.evaluate") {
        return runtimeResponse({
          token: "stale-marker",
          timeOrigin: 100,
          href: "http://example.test/",
          readyState: "complete",
        });
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return { result: { identifier: "reload-script-timeout" } };
      }
      return {};
    },
  };
  let clock = 0;
  await assert.rejects(
    reloadFreshDrawingPerformanceDocument(cdp, {
      timeoutMs: 10,
      pollIntervalMs: 5,
      markerToken: "never-observed",
      now: () => clock,
      wait: async (delayMs) => { clock += delayMs; },
    }),
    /did not reach a fresh document/,
  );
  assert.equal(
    calls.filter(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument").length,
    1,
  );
  assert.equal(calls.some(({ method }) => method === "Page.reload"), true);
});

test("drawing perf reload reports marker cleanup failure instead of hiding it", async () => {
  const cdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        return runtimeResponse({
          token: method,
          timeOrigin: 100,
          href: "http://example.test/",
          readyState: "complete",
        });
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return { result: { identifier: "reload-script-cleanup" } };
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        throw new Error("remove rejected");
      }
      return {};
    },
  };
  await assert.rejects(
    reloadFreshDrawingPerformanceDocument(cdp, {
      timeoutMs: 1,
      markerToken: "Runtime.evaluate",
      wait: async () => {},
    }),
    /marker cleanup failed/,
  );
});
