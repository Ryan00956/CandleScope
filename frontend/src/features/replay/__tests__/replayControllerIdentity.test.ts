import assert from "node:assert/strict";
import test from "node:test";
import {
  getReplayControllerClientInstanceId,
  replayControllerIdentityStorageKey,
  type ReplayControllerIdentityStorage,
} from "../replayControllerIdentity.js";

class MemoryStorage implements ReplayControllerIdentityStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("controller identity survives adapter reloads in the same Run and tab", () => {
  const storage = new MemoryStorage();
  let generated = 0;
  const createIdentity = () => `browser-${++generated}`;

  const first = getReplayControllerClientInstanceId("run-1", storage, createIdentity);
  const afterReload = getReplayControllerClientInstanceId("run-1", storage, createIdentity);

  assert.equal(first, "browser-1");
  assert.equal(afterReload, first);
  assert.equal(generated, 1);
});

test("controller identity remains Run-scoped and tab-scoped", () => {
  const firstTab = new MemoryStorage();
  const secondTab = new MemoryStorage();
  let generated = 0;
  const createIdentity = () => `browser-${++generated}`;

  const firstRun = getReplayControllerClientInstanceId("run-1", firstTab, createIdentity);
  const secondRun = getReplayControllerClientInstanceId("run-2", firstTab, createIdentity);
  const otherTab = getReplayControllerClientInstanceId("run-1", secondTab, createIdentity);

  assert.notEqual(firstRun, secondRun);
  assert.notEqual(firstRun, otherTab);
  assert.equal(firstTab.values.has(replayControllerIdentityStorageKey("run-1")), true);
  assert.equal(firstTab.values.has(replayControllerIdentityStorageKey("run-2")), true);
});

test("invalid persisted identities are replaced and invalid generated identities fail closed", () => {
  const storage = new MemoryStorage();
  storage.setItem(replayControllerIdentityStorageKey("run-1"), "contains spaces");
  assert.equal(
    getReplayControllerClientInstanceId("run-1", storage, () => "browser-valid"),
    "browser-valid",
  );
  assert.throws(
    () => getReplayControllerClientInstanceId("run-2", storage, () => "invalid identity"),
    /identity is invalid/,
  );
});

test("unavailable storage remains stable for remounts in the current document", () => {
  let generated = 0;
  const createIdentity = () => `browser-fallback-${++generated}`;
  const runId = `run-no-storage-${Date.now()}`;
  const first = getReplayControllerClientInstanceId(runId, null, createIdentity);
  const remount = getReplayControllerClientInstanceId(runId, null, createIdentity);
  assert.equal(remount, first);
  assert.equal(generated, 1);
});
