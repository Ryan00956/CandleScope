import assert from "node:assert/strict";
import test from "node:test";

import {
  freeHarnessPort,
  HARNESS_PORT_MAX,
  HARNESS_PORT_MIN,
} from "./replay-harness-port.mjs";

test("replay harness ports stay in the non-ephemeral fixture range", async () => {
  const ports = await Promise.all(
    Array.from({ length: 8 }, () => freeHarnessPort()),
  );

  assert.equal(new Set(ports).size, ports.length);
  assert.ok(ports.every((port) => port >= HARNESS_PORT_MIN));
  assert.ok(ports.every((port) => port <= HARNESS_PORT_MAX));
});
