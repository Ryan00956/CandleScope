/* SPDX-License-Identifier: GPL-3.0-only */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [sdkPath, transcriptPath] = process.argv.slice(2);
if (!sdkPath || !transcriptPath) throw new Error("self-test requires SDK and transcript paths");
const sdk = await import(pathToFileURL(sdkPath).href);

class HelloPlugin extends sdk.CandleScopePlugin {
  pending = new Set();

  describe() {
    return {
      protocol: sdk.PROTOCOL,
      plugin: {
        id: "candlescope.hello-command",
        name: "Hello Command",
        version: "0.1.0",
        publisher: "candlescope",
      },
      entrypointId: "main",
      contributions: [
        {
          id: "hello",
          kind: "command/1",
          title: "Say hello",
          entrypoint: "main",
        },
      ],
      permissions: { required: [], optional: [] },
      hostApis: { required: [], optional: [] },
      features: [],
    };
  }

  invoke(request) {
    const unknown = Object.keys(request.input).filter(
      (item) => item !== "name" && item !== "defer",
    );
    if (unknown.length) throw new sdk.ContractError("INVALID_CONTRACT", "unknown hello input");
    const name = request.input.name ?? "world";
    if (typeof name !== "string" || !name.trim() || name.length > 80) {
      throw new sdk.ContractError("INVALID_CONTRACT", "invalid hello name", "invoke.input.name");
    }
    if (request.input.defer === true) {
      const token = `hello:${request.requestContext.traceId}`;
      this.pending.add(token);
      return new sdk.Deferred(token);
    }
    return { message: `Hello, ${name.trim()}!`, contributionId: request.contributionId };
  }

  cancel(token) {
    this.pending.delete(token);
  }

  healthCheck() {
    return { status: "ready", pending: this.pending.size };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const transcript = sdk.parseStrictJson(await readFile(transcriptPath));
const server = new sdk.JsonLineServer(new HelloPlugin());
const responseHashes = [];
for (const request of transcript.requests) {
  const responses = await server.handleValue(request);
  for (const response of responses) responseHashes.push(sdk.canonicalSha256(response));
}
assert(
  JSON.stringify(responseHashes) === JSON.stringify(transcript.expected.responseSha256),
  `Python parity response digests changed: ${JSON.stringify(responseHashes)}`,
);
assert(server.dispatcher.shutdownRequested, "shutdown did not close the SDK dispatcher");

for (const invalid of [
  '{"jsonrpc":"2.0","id":1,"id":2}',
  '{"value":NaN}',
  '{"value":9007199254740992}',
  '{"value":"\\ud800"}',
]) {
  let rejected = false;
  try {
    sdk.parseStrictJson(invalid);
  } catch {
    rejected = true;
  }
  assert(rejected, `strict JSON accepted ${invalid}`);
}

class HostCallPlugin extends sdk.CandleScopePlugin {
  describe() {
    return {
      protocol: sdk.PROTOCOL,
      plugin: {
        id: "candlescope.host-call-test",
        name: "Host Call Test",
        version: "0.1.0",
        publisher: "candlescope",
      },
      entrypointId: "main",
      contributions: [
        { id: "scan", kind: "command/1", title: "Scan", entrypoint: "main" },
      ],
      permissions: { required: ["market.bars.read"], optional: [] },
      hostApis: { required: [sdk.HOST_API], optional: [] },
      features: [],
    };
  }

  invoke(request) {
    return new sdk.HostCall({
      token: "host-token",
      capabilityHandle: "opaque-capability-handle",
      method: "market.bars.read",
      params: { symbol: "BTCUSDT", limit: 100 },
      requestContext: request.requestContext,
    });
  }

  completeHostCall(token, response) {
    assert(token === "host-token", "host token changed");
    assert(response.success, "host response should succeed");
    return { bars: response.result.bars.length };
  }
}

const hostServer = new sdk.JsonLineServer(new HostCallPlugin());
await hostServer.handleValue({
  jsonrpc: "2.0",
  id: "h",
  method: "handshake",
  params: {
    protocols: [sdk.PROTOCOL],
    host: { name: "CandleScope", version: "0.4.0" },
    entrypointId: "main",
    hostApis: [sdk.HOST_API],
    transports: [sdk.TRANSPORT],
  },
  generation: 0,
});
await hostServer.handleValue({
  jsonrpc: "2.0",
  id: "a",
  method: "activate",
  params: {
    instanceId: "host-call-instance",
    generation: 7,
    capabilities: [
      {
        handle: "opaque-capability-handle",
        permissionId: "market.bars.read",
        scope: {},
      },
    ],
  },
  generation: 7,
});
const hostRequest = (
  await hostServer.handleValue({
    jsonrpc: "2.0",
    id: "invoke-host",
    method: "invoke",
    params: {
      contributionId: "scan",
      input: {},
      requestContext: {
        contributionId: "scan",
        userAction: true,
        generation: 7,
        traceId: "trace-host-call-1",
      },
    },
    generation: 7,
  })
)[0];
assert(hostRequest.method === "host.call", "invoke did not create host.call");
const completion = await hostServer.handleValue({
  jsonrpc: "2.0",
  id: hostRequest.id,
  result: { bars: [], coverage: { complete: true } },
  generation: 7,
});
assert(completion[0].result.bars === 0, "host.call completion did not correlate");
const late = await hostServer.handleValue({
  jsonrpc: "2.0",
  id: hostRequest.id,
  result: { bars: [] },
  generation: 7,
});
assert(late[0].error.data.code === "HOST_CALL_NOT_PENDING", "late host response was accepted");

process.stdout.write("candlescope-plugin-sdk-node self-test: PASS\n");
