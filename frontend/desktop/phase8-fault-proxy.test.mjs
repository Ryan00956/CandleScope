import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { Phase8Fault429Proxy } from "./phase8-fault-proxy.mjs";

test("controlled Phase 8 proxy returns HTTP 429 and accounts the receipt", async () => {
  const proxy = new Phase8Fault429Proxy();
  await proxy.start();
  try {
    const response = await fetch(proxy.url());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(proxy.diagnostics().counts, { requests: 1, connects: 0, responses429: 1 });
  } finally {
    await proxy.stop();
  }
});

test("controlled Phase 8 proxy rejects HTTPS CONNECT with HTTP 429", async () => {
  const proxy = new Phase8Fault429Proxy();
  await proxy.start();
  try {
    const statusLine = await new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxy.diagnostics().port,
        method: "CONNECT",
        path: "api.binance.com:443",
      });
      request.once("connect", (response, socket) => {
        resolve(`HTTP/${response.httpVersion} ${response.statusCode}`);
        socket.destroy();
      });
      request.once("response", (response) => resolve(`HTTP/${response.httpVersion} ${response.statusCode}`));
      request.once("error", reject);
      request.end();
    });
    assert.match(String(statusLine), /429/);
    assert.equal(proxy.diagnostics().counts.connects, 1);
  } finally {
    await proxy.stop();
  }
});
