import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalIndicatorPlanSignature,
  resolveSubmittedLocalJobKeysById,
} from "../indicatorComputeController.js";
import {
  buildIndicatorComputeJobKey,
} from "../indicatorComputeJobRuntime.js";

test("local plan identity is order-independent and supersedes execution changes", () => {
  const ma = {
    id: "local-ma",
    executionTarget: "local" as const,
    kind: "builtin",
    name: "MA",
    params: { period: 20 },
  };
  const script = {
    id: "local-script",
    executionTarget: "local" as const,
    script: "plot(close)",
    params: { width: 2 },
  };
  const first = buildLocalIndicatorPlanSignature([ma, script], "#0f0", "#f00");

  assert.equal(
    buildLocalIndicatorPlanSignature([script, ma], "#0f0", "#f00"),
    first,
  );
  assert.notEqual(buildLocalIndicatorPlanSignature([{
    ...ma,
    name: "RSI",
  }, script], "#0f0", "#f00"), first);
  assert.notEqual(buildLocalIndicatorPlanSignature([ma, {
    ...script,
    params: { width: 3 },
  }], "#0f0", "#f00"), first);
  assert.equal(buildLocalIndicatorPlanSignature([
    ma,
    script,
    { id: "hosted", engineName: "EMA", params: { period: 50 } },
  ], "#0f0", "#f00"), first);
});

test("transport failure ownership only includes current physically submitted local jobs", () => {
  const lifecycleKey = "lifecycle-a";
  const local = {
    id: "local-ma",
    executionTarget: "local" as const,
    kind: "builtin",
    name: "MA",
    params: { period: 20 },
  };
  const localJobKey = buildIndicatorComputeJobKey({
    indicator: local,
    lifecycleKey,
    params: { period: 20 },
  });
  const submittedJobKeys = new Set([localJobKey]);

  assert.deepEqual(
    Array.from(resolveSubmittedLocalJobKeysById({
      candleDownColor: "#f00",
      candleUpColor: "#0f0",
      indicators: [
        local,
        { id: "hosted", engineName: "RSI", params: { period: 14 } },
      ],
      lifecycleKey,
      submittedJobKeys,
    }).entries()),
    [["local-ma", localJobKey]],
  );

  assert.equal(resolveSubmittedLocalJobKeysById({
    candleDownColor: "#f00",
    candleUpColor: "#0f0",
    indicators: [{ ...local, params: { period: 21 } }],
    lifecycleKey,
    submittedJobKeys,
  }).size, 0);
});
