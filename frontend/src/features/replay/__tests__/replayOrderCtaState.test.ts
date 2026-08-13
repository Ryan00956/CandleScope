import assert from "node:assert/strict";
import test from "node:test";

import { replayOrderCtaState } from "../replayOrderCtaState.js";

test("unrelated replay work blocks order activation without flashing the native disabled style", () => {
  assert.deepEqual(replayOrderCtaState({
    permanentlyUnavailable: false,
    transientlyBlocked: true,
    submitting: false,
  }), {
    disabled: false,
    ariaDisabled: true,
  });
});

test("real submissions and durable validation failures remain natively disabled", () => {
  assert.deepEqual(replayOrderCtaState({
    permanentlyUnavailable: false,
    transientlyBlocked: false,
    submitting: true,
  }), {
    disabled: true,
    ariaDisabled: true,
  });
  assert.deepEqual(replayOrderCtaState({
    permanentlyUnavailable: true,
    transientlyBlocked: false,
    submitting: false,
  }), {
    disabled: true,
    ariaDisabled: true,
  });
});
