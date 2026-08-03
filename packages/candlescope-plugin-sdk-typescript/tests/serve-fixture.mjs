/* SPDX-License-Identifier: GPL-3.0-only */

import { pathToFileURL } from "node:url";

const sdkPath = process.argv[2];
if (!sdkPath) throw new Error("serve fixture requires SDK path");
const sdk = await import(pathToFileURL(sdkPath).href);

class Fixture extends sdk.CandleScopePlugin {
  describe() {
    return {
      protocol: sdk.PROTOCOL,
      plugin: {
        id: "candlescope.node-serve-fixture",
        name: "Node Serve Fixture",
        version: "0.1.0",
        publisher: "candlescope",
      },
      entrypointId: "main",
      contributions: [
        { id: "hello", kind: "command/1", title: "Hello", entrypoint: "main" },
      ],
      permissions: { required: [], optional: [] },
      hostApis: { required: [], optional: [] },
      features: [],
    };
  }

  invoke() {
    console.log("plugin-log-on-stderr");
    process.stdout.write("plugin-direct-stdout-isolated\n");
    return { ok: true };
  }
}

process.exitCode = await sdk.servePlugin(new Fixture());
