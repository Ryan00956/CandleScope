import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReplayPeriodSummaryPrepare,
  parseReplayPeriodSummaryStatus,
} from "../replayPeriodSummary.js";
import { ReplayV2ApiClient } from "../replayV2Api.js";


const proof = `sha256:${"a".repeat(64)}`;

function activeBuild() {
  return {
    set_id: "summary-set-1",
    status: "READY",
    active: true,
    algorithm_version: "replay.period-summary.algorithm.v1",
    candidate_count: 2,
    source_event_count: 128,
    raw_state_bytes: 4096,
    compressed_bytes: 1024,
    build_wall_ms: 12,
    build_cpu_ms: 10,
    build_proof_hash: proof,
    error_code: null,
    error_message: null,
  };
}

function statusResponse() {
  return {
    protocol: "replay.v2",
    run_id: "run-1",
    enabled: true,
    status: {
      schema_version: "replay.period-summary-set.v1",
      latest_build: activeBuild(),
      active_set: activeBuild(),
      limits: {
        max_candidates: 64,
        max_total_compressed_bytes: 134_217_728,
      },
    },
  };
}

function prepareResponse() {
  return {
    ...statusResponse(),
    build: {
      set_id: "summary-set-1",
      status: "READY",
      candidate_count: 2,
      source_event_count: 128,
      raw_state_bytes: 4096,
      compressed_bytes: 1024,
      build_wall_ms: 12,
      build_cpu_ms: 10,
      build_proof_hash: proof,
    },
  };
}

test("Phase 15 period-summary parsers are strict and expose no component payload", () => {
  const status = parseReplayPeriodSummaryStatus(statusResponse());
  assert.equal(status.status.active_set?.candidate_count, 2);
  assert.equal(status.status.active_set?.build_proof_hash, proof);
  assert.equal(
    parseReplayPeriodSummaryPrepare(prepareResponse()).build.source_event_count,
    128,
  );

  assert.throws(() => parseReplayPeriodSummaryStatus({
    ...statusResponse(),
    actual_start_ms: 1_710_000_000_000,
  }), /unknown/);
  assert.throws(() => parseReplayPeriodSummaryPrepare({
    ...prepareResponse(),
    build: { ...prepareResponse().build, component_state: { account: {} } },
  }), /unknown/);
  assert.throws(() => parseReplayPeriodSummaryStatus({
    ...statusResponse(),
    status: {
      ...statusResponse().status,
      active_set: { ...activeBuild(), build_proof_hash: "sha256:bad" },
    },
  }), /SHA-256/);

  const disabled = parseReplayPeriodSummaryStatus({
    protocol: "replay.v2",
    run_id: "run-1",
    enabled: false,
    status: {
      schema_version: "replay.period-summary-set.v1",
      latest_build: null,
      active_set: null,
      reason_code: "OPTIMIZATION_DISABLED",
    },
  });
  assert.equal(disabled.status.reason_code, "OPTIMIZATION_DISABLED");
});

test("Phase 15 API uses replay-only status and explicit prepare routes", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const client = new ReplayV2ApiClient({
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify(
        url.endsWith("/prepare") ? prepareResponse() : statusResponse(),
      ), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.periodSummaryStatusRun("run-1");
  const prepared = await client.preparePeriodSummariesRun("run-1");
  assert.equal(prepared.build.status, "READY");
  assert.deepEqual(requests, [
    {
      url: "/api/v1/replay/runs/run-1/fast-forward-summaries",
      method: "GET",
    },
    {
      url: "/api/v1/replay/runs/run-1/fast-forward-summaries/prepare",
      method: "POST",
    },
  ]);
  assert.ok(requests.every(({ url }) => !url.includes("/market/")));
});
