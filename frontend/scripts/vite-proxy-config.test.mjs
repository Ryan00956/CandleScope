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
