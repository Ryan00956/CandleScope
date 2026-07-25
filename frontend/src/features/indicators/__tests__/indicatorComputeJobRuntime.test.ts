import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndicatorComputeJobKey,
  createIndicatorComputeJobCoordinator,
  resolveLocalIndicatorExecution,
} from "../indicatorComputeJobRuntime.js";
import { isWsHostedIndicator } from "../indicatorPayloadRuntime.js";

test("existing builtin and script indicators remain hosted unless local is explicit", () => {
  const builtin = { id: "ma", engineName: "MA", params: {} };
  const script = { id: "custom", script: "plot(close)", params: {} };
  assert.equal(resolveLocalIndicatorExecution(builtin).kind, "hosted");
  assert.equal(resolveLocalIndicatorExecution(script).kind, "hosted");
  assert.equal(isWsHostedIndicator(builtin), true);
  assert.equal(isWsHostedIndicator(script), true);
  assert.equal(resolveLocalIndicatorExecution({ id: "incomplete" }).kind, "invalid");
});

test("explicit local execution is valid only with a complete builtin or script descriptor", () => {
  const builtin = {
    id: "ma",
    executionTarget: "local" as const,
    engineName: "MA",
    params: { period: 20 },
  };
  const script = {
    id: "custom",
    executionTarget: "local" as const,
    script: "plot(close)",
  };
  assert.deepEqual(resolveLocalIndicatorExecution(builtin), {
    kind: "local",
    execution: { mode: "builtin", name: "MA", params: { period: 20 } },
  });
  assert.equal(resolveLocalIndicatorExecution(script).kind, "local");
  assert.equal(resolveLocalIndicatorExecution({
    id: "broken",
    executionTarget: "local",
  }).kind, "invalid");
  assert.equal(isWsHostedIndicator(builtin), false);
});

test("local builtin job keys include the resolved name", () => {
  const common = {
    id: "local-builtin",
    executionTarget: "local" as const,
    kind: "builtin",
    params: { period: 20 },
  };
  const ma = buildIndicatorComputeJobKey({
    indicator: { ...common, name: "MA" },
    lifecycleKey: "series",
    params: common.params,
  });
  const rsi = buildIndicatorComputeJobKey({
    indicator: { ...common, name: "RSI" },
    lifecycleKey: "series",
    params: common.params,
  });

  assert.notEqual(ma, rsi);
});

test("local script job keys normalize and separate runtime languages", () => {
  const common = {
    id: "local-script",
    executionTarget: "local" as const,
    script: "plot(close)",
  };
  const buildKey = (language: string) => buildIndicatorComputeJobKey({
    indicator: { ...common, language },
    lifecycleKey: "series",
    params: {},
  });

  assert.equal(buildKey("  PYNE  "), buildKey("pyne"));
  assert.notEqual(buildKey("pyne"), buildKey("pine"));
});

test("job keys canonicalize parameter order and stay bounded", () => {
  const indicator = {
    id: "local-script",
    executionTarget: "local" as const,
    script: "plot(close)",
    securityMode: "safe",
  };
  const first = buildIndicatorComputeJobKey({
    indicator,
    lifecycleKey: `series:${"l".repeat(300)}`,
    params: {
      label: "x".repeat(300),
      nested: { alpha: 1, beta: 2 },
    },
  });
  const reordered = buildIndicatorComputeJobKey({
    indicator,
    lifecycleKey: `series:${"l".repeat(300)}`,
    params: {
      nested: { beta: 2, alpha: 1 },
      label: "x".repeat(300),
    },
  });

  assert.equal(first, reordered);
  assert.match(first, /^indicator-compute:v2:/);
  assert.ok(first.length <= 256, `expected bounded key, received ${first.length}`);
});

test("job keys include resolved script, security mode, lifecycle, and force generation", () => {
  const common = {
    id: "local-script",
    executionTarget: "local" as const,
    script: "plot(close)",
    securityMode: "safe",
  };
  const base = buildIndicatorComputeJobKey({
    indicator: common,
    lifecycleKey: "series-a",
    params: {},
  });
  assert.notEqual(base, buildIndicatorComputeJobKey({
    indicator: { ...common, script: "plot(open)" },
    lifecycleKey: "series-a",
    params: {},
  }));
  assert.notEqual(base, buildIndicatorComputeJobKey({
    indicator: { ...common, securityMode: "research" },
    lifecycleKey: "series-a",
    params: {},
  }));
  assert.notEqual(base, buildIndicatorComputeJobKey({
    indicator: common,
    lifecycleKey: "series-b",
    params: {},
  }));
  assert.notEqual(base, buildIndicatorComputeJobKey({
    forceGeneration: 1,
    indicator: common,
    lifecycleKey: "series-a",
    params: {},
  }));
});

test("same keyed lifecycle joins and waits for one physical batch without republishing", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  let physical = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = async (jobs: Array<{ jobKey: string }>) => {
    physical += 1;
    await gate;
    return jobs;
  };
  const first = coordinator.schedule({ lifecycleKey: "A", jobs: [{ jobKey: "A:ma" }], execute });
  let joinedSettled = false;
  const joinedPromise = coordinator
    .schedule({ lifecycleKey: "A", jobs: [{ jobKey: "A:ma" }], execute })
    .then((result) => {
      joinedSettled = true;
      return result;
    });
  await Promise.resolve();
  assert.equal(joinedSettled, false);
  release?.();
  const [firstResult, joined] = await Promise.all([first, joinedPromise]);
  assert.equal(firstResult.results.length, 1);
  assert.equal(joined.joined, 1);
  assert.equal(joined.queued, 0);
  assert.deepEqual(joined.results, []);
  const cached = await coordinator.schedule({ lifecycleKey: "A", jobs: [{ jobKey: "A:ma" }], execute });
  assert.equal(cached.skipped, 1);
  assert.equal(physical, 1);
});

test("mixed skipped joined and queued jobs wait and return only owned results", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "done" }],
    execute: async (jobs) => jobs,
  });

  let releaseShared: (() => void) | undefined;
  const sharedGate = new Promise<void>((resolve) => { releaseShared = resolve; });
  const sharedOwner = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "shared" }],
    execute: async (jobs) => {
      await sharedGate;
      return jobs;
    },
  });
  let mixedSettled = false;
  const mixed = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "done" }, { jobKey: "shared" }, { jobKey: "new" }],
    execute: async (jobs) => {
      assert.deepEqual(jobs.map((job) => job.jobKey), ["new"]);
      return jobs;
    },
  }).then((result) => {
    mixedSettled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mixedSettled, false);
  releaseShared?.();
  const [sharedResult, mixedResult] = await Promise.all([sharedOwner, mixed]);

  assert.deepEqual(sharedResult.results.map((result) => result.jobKey), ["shared"]);
  assert.deepEqual(mixedResult, {
    joined: 1,
    queued: 1,
    results: [{ jobKey: "new" }],
    skipped: 1,
    stale: false,
  });
  assert.equal(coordinator.snapshot().inFlight, 0);
});

test("a failed joined batch does not discard a mixed call's successful owned result", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  let releaseJoinedFailure: (() => void) | undefined;
  const joinedFailureGate = new Promise<void>((resolve) => {
    releaseJoinedFailure = resolve;
  });
  const joinedOwner = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "joined" }],
    execute: async () => {
      await joinedFailureGate;
      throw new Error("joined physical failure");
    },
  });
  const ownerFailure = assert.rejects(joinedOwner, /joined physical failure/);
  let mixedSettled = false;
  const mixed = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "joined" }, { jobKey: "owned" }],
    execute: async (jobs) => jobs,
  }).then((result) => {
    mixedSettled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mixedSettled, false);
  releaseJoinedFailure?.();
  await ownerFailure;
  const mixedResult = await mixed;

  assert.deepEqual(mixedResult, {
    joined: 1,
    queued: 1,
    results: [{ jobKey: "owned" }],
    skipped: 0,
    stale: false,
  });
  assert.equal(coordinator.snapshot().inFlight, 0);
  assert.equal(coordinator.snapshot().completed, 1);
});

test("lifecycle activation aborts stale work and does not reuse unacknowledged cache state", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  const firstA = await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute: async (jobs) => jobs,
  });
  assert.equal(firstA.results.length, 1);

  let staleSignal: AbortSignal | undefined;
  let releaseB: (() => void) | undefined;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  const pendingB = coordinator.schedule({
    lifecycleKey: "B",
    jobs: [{ jobKey: "B:ma" }],
    execute: async (jobs, signal) => {
      staleSignal = signal;
      await gateB;
      return jobs;
    },
  });
  const secondA = await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute: async (jobs) => jobs,
  });
  assert.equal(staleSignal?.aborted, true);
  assert.equal(secondA.queued, 1);
  assert.equal(secondA.results.length, 1);
  releaseB?.();
  assert.equal((await pendingB).stale, true);
});

test("forced recompute bypasses completed work but still joins the same in-flight key", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  let physical = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = async (jobs: Array<{ jobKey: string }>) => {
    physical += 1;
    if (physical === 2) await gate;
    return jobs;
  };
  await coordinator.schedule({ lifecycleKey: "A", jobs: [{ jobKey: "A:ma" }], execute });
  const forced = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute,
    force: true,
  });
  await Promise.resolve();
  let joinSettled = false;
  const joinedForce = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute,
    force: true,
  }).then((result) => {
    joinSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(joinSettled, false);
  assert.equal(physical, 2);
  release?.();
  const joinedResult = await joinedForce;
  assert.equal(joinedResult.joined, 1);
  assert.equal(joinedResult.queued, 0);
  assert.deepEqual(joinedResult.results, []);
  assert.equal((await forced).results.length, 1);
});

test("physical failures propagate to joiners and clear in-flight ownership", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  let releaseFailure: (() => void) | undefined;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const executeFailure = async () => {
    await failureGate;
    throw new Error("physical failure");
  };
  const owner = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute: executeFailure,
  });
  const joiner = coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute: executeFailure,
  });
  const ownerFailure = assert.rejects(owner, /physical failure/);
  const joinedFailure = assert.rejects(joiner, /physical failure/);

  releaseFailure?.();
  await Promise.all([ownerFailure, joinedFailure]);
  assert.equal(coordinator.snapshot().inFlight, 0);
  assert.equal(coordinator.snapshot().completed, 0);

  const retry = await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute: async (jobs) => jobs,
  });
  assert.equal(retry.queued, 1);
  assert.equal(retry.results.length, 1);
});

test("incomplete results are returned but not remembered as completed", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  let physical = 0;
  const execute = async (jobs: Array<{ jobKey: string }>) => {
    physical += 1;
    return jobs.map((job) => ({ ...job, terminal: physical > 1 }));
  };
  const schedule = () => coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma" }],
    execute,
    isResultComplete: (result) => result.terminal,
  });

  const incomplete = await schedule();
  assert.equal(incomplete.results[0]?.terminal, false);
  assert.equal(coordinator.snapshot().completed, 0);
  const terminal = await schedule();
  assert.equal(terminal.results[0]?.terminal, true);
  assert.equal(coordinator.snapshot().completed, 1);
  const cached = await schedule();
  assert.equal(cached.skipped, 1);
  assert.equal(physical, 2);
});

test("a caller can acknowledge a durably cached result as completed", async () => {
  const coordinator = createIndicatorComputeJobCoordinator();
  const execute = async (jobs: Array<{ jobKey: string; terminal: boolean }>) => jobs;
  await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma", terminal: false }],
    execute,
    isResultComplete: () => false,
  });
  coordinator.complete(["A:ma"]);

  const reused = await coordinator.schedule({
    lifecycleKey: "A",
    jobs: [{ jobKey: "A:ma", terminal: false }],
    execute,
  });
  assert.equal(reused.skipped, 1);
  assert.equal(reused.queued, 0);
});
