import assert from "node:assert/strict";
import test from "node:test";

import { auditBoundary } from "./replay-soak.mjs";

test("replay soak blind audit catches standalone fixture epochs across HTTP shapes", () => {
  for (const value of [
    { body: JSON.stringify({ event_time_ms: 1_700_160_666_666 }) },
    { body: JSON.stringify({ event_time_ms: "1700160666666" }) },
    { url: "http://127.0.0.1/replay?start=1700160666666&blind=true" },
    { text: "cursor 1700160666666 hidden" },
  ]) {
    const result = auditBoundary("http", value);
    assert.equal(result.passed, false);
    assert.equal(result.forbiddenMatches[0]?.boundary, "fixture_epoch_milliseconds");
    assert.deepEqual(result.forbiddenMatches[0]?.values, ["1700160666666"]);
  }
});

test("replay soak blind audit does not mistake Decimal or digest substrings for epochs", () => {
  const result = auditBoundary("http", {
    equity: "9998.1700160666666",
    digest: "sha256:1700160666666abcdef",
    identifier: "order1700160666666suffix",
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.forbiddenMatches, []);
});

test("replay soak blind audit retains calendar and filesystem path boundaries", () => {
  const result = auditBoundary("dom", {
    date: "2023-11-16",
    database: "C:\\private\\replay.db",
  });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.forbiddenMatches.map((item) => item.boundary),
    ["fixture_calendar_date", "windows_filesystem_path", "archive_or_database_path"],
  );
});
