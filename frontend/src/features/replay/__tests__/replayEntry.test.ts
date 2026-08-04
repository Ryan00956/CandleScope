import assert from "node:assert/strict";
import test from "node:test";

import { resolveReplayEntry } from "../replayEntry.js";

test("direct replay access opens the run archive Hub", () => {
  assert.deepEqual(resolveReplayEntry({ pathname: "/replay.html", search: "" }), { kind: "configure" });
});

test("opaque run entry is restored from the replay document URL", () => {
  assert.deepEqual(
    resolveReplayEntry({ pathname: "/app/replay.html", search: "?run=run-0001" }),
    { kind: "run", runId: "run-0001" },
  );
});

test("invalid run, duplicate query, and wrong production rewrite remain replay errors", () => {
  assert.equal(resolveReplayEntry({ pathname: "/replay.html", search: "?run=%2Fbad" }).kind, "error");
  assert.equal(resolveReplayEntry({ pathname: "/replay.html", search: "?run=a&run=b" }).kind, "error");
  assert.deepEqual(resolveReplayEntry({ pathname: "/", search: "?run=run-0001" }), {
    kind: "error",
    code: "REPLAY_ROUTE_MISMATCH",
    message: "This replay document was served from an invalid route. Live fallback is disabled.",
  });
  assert.equal(resolveReplayEntry({ pathname: "/index.html", search: "" }).kind, "error");
});

test("unknown query parameters fail closed", () => {
  assert.equal(resolveReplayEntry({ pathname: "/replay.html", search: "?symbol=BTCUSDT" }).kind, "error");
  assert.equal(resolveReplayEntry({ pathname: "/replay.html", search: "?session=session-0001" }).kind, "error");
});
