import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartStrategyAutoRunCoordinator,
  shouldScheduleChartStrategyAutoRun,
} from "../chartStrategyAutoRunCoordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("initial mount and copied attachment do not create an auto-run intent", () => {
  const attached = {
    sessionKey: "btc:1h",
    attachmentKey: "draft-a",
    contentRevision: 1,
    enabled: true,
  };
  assert.equal(shouldScheduleChartStrategyAutoRun(null, attached), false);
  assert.equal(shouldScheduleChartStrategyAutoRun(attached, attached), false);
  assert.equal(shouldScheduleChartStrategyAutoRun(attached, { ...attached, sessionKey: "btc:15m" }), true);
  assert.equal(shouldScheduleChartStrategyAutoRun(attached, { ...attached, attachmentKey: "draft-b" }), true);
  assert.equal(shouldScheduleChartStrategyAutoRun(
    { ...attached, enabled: false },
    attached,
  ), true);
});

test("64 initially mounted attached cells create no auto-run intent", () => {
  for (let index = 0; index < 64; index += 1) {
    assert.equal(shouldScheduleChartStrategyAutoRun(null, {
      sessionKey: `btc:${index}`,
      attachmentKey: `draft-${index}`,
      contentRevision: index + 1,
      enabled: true,
    }), false);
  }
});

test("four changing cells never exceed two active auto Runs and keep latest queued generation", async () => {
  const coordinator = new ChartStrategyAutoRunCoordinator(2);
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
  const starts: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    coordinator.enqueue({
      workspaceId: "workspace-a",
      cellScope: `cell-${index + 1}`,
      generation: 1,
      async execute() {
        starts.push(`cell-${index + 1}:1`);
        await gates[index]!.promise;
      },
    });
  }
  coordinator.enqueue({
    workspaceId: "workspace-a",
    cellScope: "cell-4",
    generation: 2,
    async execute() {
      starts.push("cell-4:2");
      await gates[4]!.promise;
    },
  });
  await Promise.resolve();
  assert.deepEqual(starts, ["cell-1:1", "cell-2:1"]);
  assert.equal(coordinator.diagnostics().workspaces[0]?.maxObservedActive, 2);
  assert.deepEqual(
    coordinator.diagnostics().workspaces[0]?.pending,
    [
      { cellScope: "cell-3", generation: 1 },
      { cellScope: "cell-4", generation: 2 },
    ],
  );
  gates[0]!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts.includes("cell-3:1"), true);
  gates[1]!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts.includes("cell-4:2"), true);
  assert.equal(starts.includes("cell-4:1"), false);
  gates.slice(2).forEach((gate) => gate.resolve());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(coordinator.diagnostics().workspaces, []);
});

test("script edits schedule auto-run after the draft is loaded", () => {
  const attached = {
    sessionKey: "btc:1h",
    attachmentKey: "draft-a",
    contentRevision: 1,
    enabled: true,
  };
  assert.equal(shouldScheduleChartStrategyAutoRun(
    { ...attached, contentRevision: null },
    attached,
  ), false);
  assert.equal(shouldScheduleChartStrategyAutoRun(attached, {
    ...attached,
    contentRevision: 2,
  }), true);
});

test("manual preemption removes an unsubmitted auto job without touching active work", async () => {
  const coordinator = new ChartStrategyAutoRunCoordinator(1);
  const active = deferred();
  let queuedStarted = false;
  coordinator.enqueue({
    workspaceId: "workspace-a",
    cellScope: "cell-active",
    generation: 1,
    execute: () => active.promise,
  });
  coordinator.enqueue({
    workspaceId: "workspace-a",
    cellScope: "cell-manual",
    generation: 1,
    async execute() { queuedStarted = true; },
  });
  assert.equal(coordinator.cancelPending("workspace-a", "cell-manual"), true);
  active.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queuedStarted, false);
});
