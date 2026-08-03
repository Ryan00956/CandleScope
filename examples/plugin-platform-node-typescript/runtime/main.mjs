/* SPDX-License-Identifier: GPL-3.0-only */
import { CandleScopePlugin, ContractError, Deferred, PROTOCOL, servePlugin, } from "./sdk.mjs";
class NodeHelloPlugin extends CandleScopePlugin {
    pending = new Set();
    activationGeneration = 0;
    describe() {
        return {
            protocol: PROTOCOL,
            plugin: {
                id: "candlescope.node-hello",
                name: "Node TypeScript Hello",
                version: "0.1.0",
                publisher: "candlescope",
            },
            entrypointId: "main",
            contributions: [
                {
                    id: "node-hello",
                    kind: "command/1",
                    title: "Say hello from Node.js",
                    entrypoint: "main",
                },
            ],
            permissions: { required: [], optional: [] },
            hostApis: { required: [], optional: [] },
            features: [],
        };
    }
    activate(request) {
        this.activationGeneration = request.generation;
    }
    invoke(request) {
        const unknown = Object.keys(request.input).filter((item) => item !== "name" && item !== "defer");
        if (unknown.length) {
            throw new ContractError("INVALID_CONTRACT", `node hello input contains unknown fields: ${unknown.sort().join(", ")}`, "invoke.input");
        }
        const name = request.input.name ?? "world";
        if (typeof name !== "string" || !name.trim() || name.length > 80) {
            throw new ContractError("INVALID_CONTRACT", "node hello name must be a non-empty string of at most 80 characters", "invoke.input.name");
        }
        if (request.input.defer === true) {
            const token = `node-hello:${request.requestContext.traceId}`;
            this.pending.add(token);
            return new Deferred(token);
        }
        return {
            message: `Hello from Node.js, ${name.trim()}!`,
            contributionId: request.contributionId,
            generation: this.activationGeneration,
        };
    }
    eventBatch(request) {
        const events = request.events;
        if (!Array.isArray(events)) {
            throw new ContractError("INVALID_CONTRACT", "eventBatch.events must be an array");
        }
        return { accepted: events.length, runtime: "node" };
    }
    cancel(token) {
        this.pending.delete(token);
    }
    healthCheck() {
        return {
            status: "ready",
            pending: this.pending.size,
            generation: this.activationGeneration,
        };
    }
    deactivate() {
        this.pending.clear();
        this.activationGeneration = 0;
    }
}
process.exitCode = await servePlugin(new NodeHelloPlugin());
//# sourceMappingURL=../source-maps/main.mjs.map