import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingEnginePresencePolicy } from "../drawingEngineLoader.js";
import type {
  DrawingDocumentManifestReadResult,
  DrawingDocumentPresenceProbeResult,
} from "../persistence/drawingDocumentRepository.js";

interface ProbeController {
  promise: Promise<DrawingDocumentPresenceProbeResult>;
  resolve(result: DrawingDocumentPresenceProbeResult): void;
}

function deferredProbe(): ProbeController {
  let resolve!: (result: DrawingDocumentPresenceProbeResult) => void;
  return {
    promise: new Promise((accept) => { resolve = accept; }),
    resolve,
  };
}

function policyFixture(manifest: DrawingDocumentManifestReadResult) {
  let manifestReads = 0;
  let probeReads = 0;
  const probeQueue: Array<Promise<DrawingDocumentPresenceProbeResult>> = [];
  const policy = createDrawingEnginePresencePolicy({
    readManifestHint() {
      manifestReads += 1;
      return manifest;
    },
    probeAndRepairManifest() {
      probeReads += 1;
      const next = probeQueue.shift();
      if (!next) throw new Error("missing test probe result");
      return next;
    },
  });
  return {
    policy,
    probeQueue,
    reads: () => ({ manifestReads, probeReads }),
  };
}

test("active drawing tools mount without touching manifest or legacy bytes", () => {
  const fixture = policyFixture({ status: "missing" });
  assert.equal(fixture.policy.shouldLoad({ activeTool: "line-segment", drawingKey: "scope" }), true);
  assert.deepEqual(fixture.reads(), { manifestReads: 0, probeReads: 0 });
});

test("positive manifest is a tiny synchronous hint and does not trigger an async probe", () => {
  const fixture = policyFixture({
    status: "valid",
    hint: { manifestSchemaVersion: 1, scopeKey: "scope", count: 512, revision: 9 },
  });
  assert.equal(fixture.policy.shouldLoad({ activeTool: null, drawingKey: "scope" }), true);
  assert.deepEqual(fixture.reads(), { manifestReads: 1, probeReads: 0 });
});

test("concurrent probes are deduplicated and found results populate the positive cache", async () => {
  const fixture = policyFixture({ status: "missing" });
  const deferred = deferredProbe();
  fixture.probeQueue.push(deferred.promise);
  const first = fixture.policy.probe("scope");
  const second = fixture.policy.probe("scope");
  assert.strictEqual(first, second);
  assert.deepEqual(fixture.reads(), { manifestReads: 0, probeReads: 1 });
  deferred.resolve({
    status: "found",
    source: "v2",
    count: 2,
    revision: 4,
    manifestUpdated: true,
  });
  assert.equal(await first, true);
  assert.equal(fixture.policy.shouldLoad({ activeTool: null, drawingKey: "scope" }), true);
});

test("missing clears cached presence while invalid and unavailable probes reject fail-closed", async () => {
  const fixture = policyFixture({ status: "missing" });
  fixture.probeQueue.push(Promise.resolve({
    status: "found",
    source: "legacy",
    count: 1,
    revision: 0,
    manifestUpdated: true,
  }));
  assert.equal(await fixture.policy.probe("scope"), true);

  fixture.probeQueue.push(Promise.resolve({
    status: "missing",
    source: "none",
    count: 0,
    revision: 0,
    manifestUpdated: true,
  }));
  assert.equal(await fixture.policy.probe("scope"), false);
  assert.equal(fixture.policy.shouldLoad({ activeTool: null, drawingKey: "scope" }), false);

  fixture.probeQueue.push(Promise.resolve({
    status: "invalid",
    source: "v2",
    error: new Error("corrupt v2"),
    manifestUpdated: false,
  }));
  await assert.rejects(fixture.policy.probe("scope"), /corrupt v2/);

  fixture.probeQueue.push(Promise.resolve({
    status: "unavailable",
    source: "v2",
    error: new Error("IDB denied"),
    manifestUpdated: false,
  }));
  await assert.rejects(fixture.policy.probe("scope"), /IDB denied/);
});
