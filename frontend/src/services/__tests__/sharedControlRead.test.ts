import assert from "node:assert/strict";
import test from "node:test";

import {
  resetSharedControlReadsForTests,
  sharedControlRead,
  sharedControlReadCountForTests,
} from "../sharedControlRead.js";

test("shared control reads coalesce inflight work and reuse a bounded TTL value", async () => {
  resetSharedControlReadsForTests();
  let calls = 0;
  const load = async () => ({ revision: ++calls });
  const [first, second] = await Promise.all([
    sharedControlRead("catalog", 1_000, load),
    sharedControlRead("catalog", 1_000, load),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal((await sharedControlRead("catalog", 1_000, load)).revision, 1);
  assert.equal(sharedControlReadCountForTests(), 1);
});

test("caller abort does not cancel the physical read shared by another Cell", async () => {
  resetSharedControlReadsForTests();
  const controller = new AbortController();
  let resolve!: (value: number) => void;
  const physical = new Promise<number>((done) => { resolve = done; });
  const cancelled = sharedControlRead("snapshot", 1_000, () => physical, controller.signal);
  const retained = sharedControlRead("snapshot", 1_000, () => physical);
  controller.abort();
  resolve(42);
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(await retained, 42);
});

test("failed and overflow entries are removed within the hard bound", async () => {
  resetSharedControlReadsForTests();
  await assert.rejects(sharedControlRead("failed", 1_000, async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(sharedControlReadCountForTests(), 0);
  for (let index = 0; index < 40; index += 1) {
    await sharedControlRead(`key-${index}`, 1_000, async () => index);
  }
  assert.equal(sharedControlReadCountForTests(), 32);
});
