import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayCapabilities } from "../replayParser.js";
import { replayEntryCapabilityFromPayload, replayEntryFlagEnabled } from "../useReplayEntryCapability.js";
import { disabledCapabilities, enabledCapabilities } from "./fixtures.js";

test("live replay entry flag is explicit and defaults fail closed", () => {
  assert.equal(replayEntryFlagEnabled(undefined), false);
  assert.equal(replayEntryFlagEnabled("0"), false);
  assert.equal(replayEntryFlagEnabled("TRUE"), false);
  assert.equal(replayEntryFlagEnabled("1"), true);
  assert.equal(replayEntryFlagEnabled("true"), true);
});

test("live entry view requires backend enabled and available capability", () => {
  assert.deepEqual(replayEntryCapabilityFromPayload(parseReplayCapabilities(enabledCapabilities())), {
    state: "enabled",
    href: "/replay.html",
    reason: null,
  });
  const disabled = replayEntryCapabilityFromPayload(parseReplayCapabilities(disabledCapabilities()));
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.reason, "REPLAY_DISABLED");
});
