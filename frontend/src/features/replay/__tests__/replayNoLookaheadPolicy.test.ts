import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayEvent, parseReplaySessionResponse } from "../replayParser.js";
import { replayDeltaEvent, replayFill, replaySessionResponse } from "./fixtures.js";

test("snapshot parser rejects a bar published beyond the public cursor", () => {
  const response = structuredClone(replaySessionResponse());
  const snapshot = response.snapshot;
  const builder = snapshot.components.bar_builder;
  const bar = builder.closed_bars[0];
  assert.ok(bar);
  bar.open_time_ms = snapshot.cursor.virtual_time_ms + 1;
  bar.close_time_ms = bar.open_time_ms + 59_999;
  bar.first_base_open_ms = bar.open_time_ms;
  bar.last_base_open_ms = bar.open_time_ms;
  assert.throws(() => parseReplaySessionResponse(response), /unrevealed bar time/);
});

test("delta parser rejects source events and fills beyond virtual time", () => {
  const futureSource = structuredClone(replayDeltaEvent());
  futureSource.data.source_event.close_time_ms = futureSource.virtual_time_ms + 1;
  assert.throws(() => parseReplayEvent(futureSource), /unrevealed source event/);

  const futureFill = replayDeltaEvent({ fills: [replayFill(9_000_000_000_000)] });
  assert.throws(() => parseReplayEvent(futureFill), /future fill/);
});
