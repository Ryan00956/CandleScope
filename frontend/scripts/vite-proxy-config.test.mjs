import assert from "node:assert/strict";
import { globalAgent as globalHttpAgent } from "node:http";
import test from "node:test";

import viteConfig from "../vite.config.js";

test("development and preview API proxies never pool upstream sockets", () => {
  for (const runtime of ["server", "preview"]) {
    const proxy = viteConfig[runtime]?.proxy?.["/api"];

    assert.ok(proxy, `${runtime} API proxy is configured`);
    assert.ok(proxy.agent, `${runtime} API proxy owns an explicit agent`);
    assert.notEqual(proxy.agent, globalHttpAgent);
    assert.equal(proxy.agent.keepAlive, false);
    assert.equal(proxy.agent.options.keepAlive, false);
    assert.equal(proxy.agent.maxSockets, 32);
  }
});

test("the Monaco React adapter stays in the lazy editor chunk", () => {
  const manualChunks = viteConfig.build?.rollupOptions?.output?.manualChunks;

  assert.equal(typeof manualChunks, "function");
  assert.equal(
    manualChunks("C:/repo/node_modules/@monaco-editor/react/dist/index.mjs"),
    "vendor-editor",
  );
  assert.equal(
    manualChunks("C:/repo/node_modules/monaco-editor/esm/vs/editor/editor.api.js"),
    "vendor-editor",
  );
  assert.equal(
    manualChunks("C:/repo/node_modules/react-dom/client.js"),
    "vendor-react",
  );
});
