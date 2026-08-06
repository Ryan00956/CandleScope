import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayCapabilities } from "../replayParser.js";
import { replayEntryCapabilityFromPayload } from "../useReplayEntryCapability.js";
import { disabledCapabilities, enabledCapabilities } from "./fixtures.js";

test("live entry is always visible and capability decides whether it is actionable", () => {
  assert.deepEqual(replayEntryCapabilityFromPayload(parseReplayCapabilities(enabledCapabilities())), {
    state: "enabled",
    href: "/replay.html",
    reason: null,
  });
  const disabled = replayEntryCapabilityFromPayload(parseReplayCapabilities(disabledCapabilities()));
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.reason, "REPLAY_DISABLED");
});
