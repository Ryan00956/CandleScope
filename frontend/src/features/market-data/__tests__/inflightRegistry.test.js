import assert from "node:assert/strict";
import test from "node:test";

import { InflightRegistry } from "../feed/inflightRegistry.js";

test("reuses a matching in-flight promise", async () => {
  const registry = new InflightRegistry();
  let calls = 0;

  const first = registry.run("same", async () => {
    calls += 1;
    return "ok";
  });
  const second = registry.run("same", async () => {
    calls += 1;
    return "other";
  });

  assert.equal(first, second);
  assert.equal(await second, "ok");
  assert.equal(calls, 1);
  assert.equal(registry.size(), 0);
});
