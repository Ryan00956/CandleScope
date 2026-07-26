import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReplayPublicTimeBatchResponse,
} from "../replayIntegrityModel.js";
import {
  ReplayPublicTimeProjectionController,
  type ReplayPublicTimeProjectionApi,
} from "../replayPublicTimeProjection.js";
import type { ReplayV2TimeDisclosurePolicy } from "../replayV2Types.js";

const ORIGIN_MS = 1_710_000_000_000;

function response(
  runId: string,
  policy: ReplayV2TimeDisclosurePolicy,
  values: readonly number[],
): ReplayPublicTimeBatchResponse {
  return {
    protocol: "replay.v2",
    run_id: runId,
    policy,
    items: values.map((value, index) => ({
      input_timeline_ms: value,
      public_time: {
        policy,
        timeline_ms: value,
        relative_ms: value - ORIGIN_MS,
        sequence: index,
        label: `public:${value}`,
      },
    })),
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function update(
  controller: ReplayPublicTimeProjectionController,
  timelineMs: readonly number[],
  runId = "run-1",
): void {
  controller.update({
    runId,
    policy: "HIDE_ALL",
    originMs: ORIGIN_MS,
    timelineOriginMs: ORIGIN_MS,
    timelineMs,
  });
}

test("public-time projection coalesces bursts and fetches only cache misses", async (context) => {
  const calls: number[][] = [];
  const api: ReplayPublicTimeProjectionApi = {
    async publicTimesRun(runId, timelineMs) {
      calls.push([...timelineMs]);
      return response(runId, "HIDE_ALL", timelineMs);
    },
  };
  const controller = new ReplayPublicTimeProjectionController(api);
  context.after(() => controller.cancel());
  let publications = 0;
  controller.subscribe(() => {
    publications += 1;
  });

  update(controller, [ORIGIN_MS]);
  update(controller, [ORIGIN_MS, ORIGIN_MS + 60_000]);
  update(controller, [ORIGIN_MS, ORIGIN_MS + 60_000, ORIGIN_MS + 120_000]);
  await waitFor(
    () => controller.getSnapshot().labels.size === 3
      && !controller.getSnapshot().loading,
    "initial projection did not settle",
  );
  assert.deepEqual(calls, [[
    ORIGIN_MS,
    ORIGIN_MS + 60_000,
    ORIGIN_MS + 120_000,
  ]]);
  assert.equal(publications, 2);

  const settled = controller.getSnapshot();
  update(controller, [
    ORIGIN_MS + 120_000,
    ORIGIN_MS,
    ORIGIN_MS + 60_000,
    ORIGIN_MS,
  ]);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.getSnapshot(), settled);
  assert.equal(publications, 2);

  update(controller, [
    ORIGIN_MS,
    ORIGIN_MS + 60_000,
    ORIGIN_MS + 120_000,
    ORIGIN_MS + 180_000,
  ]);
  await waitFor(
    () => controller.getSnapshot().labels.size === 4
      && !controller.getSnapshot().loading,
    "incremental projection did not settle",
  );
  assert.deepEqual(calls[1], [ORIGIN_MS + 180_000]);
  assert.equal(controller.getSnapshot().labels.get(ORIGIN_MS), `public:${ORIGIN_MS}`);
});

test("public-time projection ignores an aborted stale scope", async (context) => {
  const stale = {
    resolve: null as ((value: ReplayPublicTimeBatchResponse) => void) | null,
  };
  const calls: Array<{ runId: string; signal: AbortSignal | undefined }> = [];
  const api: ReplayPublicTimeProjectionApi = {
    publicTimesRun(runId, timelineMs, signal) {
      calls.push({ runId, signal });
      if (runId === "run-1") {
        return new Promise((resolve) => {
          stale.resolve = resolve;
        });
      }
      return Promise.resolve(response(runId, "HIDE_ALL", timelineMs));
    },
  };
  const controller = new ReplayPublicTimeProjectionController(api);
  context.after(() => controller.cancel());

  update(controller, [ORIGIN_MS], "run-1");
  await waitFor(() => calls.length === 1, "stale request did not start");
  update(controller, [ORIGIN_MS + 60_000], "run-2");
  await waitFor(
    () => controller.getSnapshot().labels.has(ORIGIN_MS + 60_000),
    "replacement scope did not settle",
  );
  assert.equal(calls[0]?.signal?.aborted, true);

  assert.ok(stale.resolve);
  stale.resolve(response("run-1", "HIDE_ALL", [ORIGIN_MS]));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.getSnapshot().labels.has(ORIGIN_MS), false);
  assert.equal(controller.getSnapshot().labels.get(ORIGIN_MS + 60_000), `public:${ORIGIN_MS + 60_000}`);
});

test("public-time projection fails closed on incomplete authoritative data", async (context) => {
  const api: ReplayPublicTimeProjectionApi = {
    async publicTimesRun(runId, timelineMs) {
      return response(runId, "HIDE_ALL", timelineMs.slice(0, -1));
    },
  };
  const controller = new ReplayPublicTimeProjectionController(api);
  context.after(() => controller.cancel());

  update(controller, [ORIGIN_MS, ORIGIN_MS + 60_000]);
  await waitFor(
    () => controller.getSnapshot().error !== null,
    "incomplete response did not fail closed",
  );
  assert.equal(controller.getSnapshot().labels.size, 0);
  assert.equal(controller.getSnapshot().loading, false);
  assert.match(controller.getSnapshot().error ?? "", /incomplete/);
});
