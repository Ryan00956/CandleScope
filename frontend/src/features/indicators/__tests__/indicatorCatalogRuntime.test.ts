import assert from "node:assert/strict";
import test from "node:test";

import {
  createIndicatorCatalogStore,
  shouldLoadIndicatorCatalog,
  shouldShowIndicatorCatalogLoading,
} from "../useIndicatorCatalogRuntime.js";
import type { CatalogCustomIndicator, IndicatorCatalogSnapshot } from "../useIndicatorCatalogRuntime.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const loadedCatalog: IndicatorCatalogSnapshot = {
  presets: [{
    id: "ma",
    name: "MA",
    engineName: "MA",
    script: "# __ENGINE__:MA",
    params: { period: 20 },
    description: "Moving average",
    category: "Trend",
    paramSchema: [],
    outputs: ["ma"],
    is_builtin: true,
    defaultEnabled: false,
    paneTarget: "main",
  }],
  customIndicators: [{
    id: "custom-one",
    name: "Custom one",
    script: "plot(close)",
    params: {},
    description: "",
    category: "custom",
    is_builtin: false,
    isPreset: false,
    paneTarget: "sub",
    securityMode: "safe",
  } as CatalogCustomIndicator],
};

test("catalog stays lazy while the panel is closed", () => {
  const store = createIndicatorCatalogStore(async () => loadedCatalog);
  assert.equal(shouldLoadIndicatorCatalog(false, store.getSnapshot()), false);
  assert.equal(store.getSnapshot(), null);
});

test("concurrent opens share one catalog request and later opens reuse its snapshot", async () => {
  const pending = deferred<IndicatorCatalogSnapshot>();
  let calls = 0;
  const store = createIndicatorCatalogStore(() => {
    calls += 1;
    return pending.promise;
  });

  const firstOpen = store.load();
  const reopenedWhileLoading = store.load();
  assert.strictEqual(firstOpen, reopenedWhileLoading);
  await Promise.resolve();
  assert.equal(calls, 1);

  pending.resolve(loadedCatalog);
  assert.deepEqual(await reopenedWhileLoading, loadedCatalog);
  assert.equal(shouldLoadIndicatorCatalog(true, store.getSnapshot()), false);

  const reopenedAfterLoad = await store.load();
  assert.strictEqual(reopenedAfterLoad, store.getSnapshot());
  assert.equal(calls, 1);
});

test("a failed shared request clears the in-flight gate for an explicit later retry", async () => {
  let calls = 0;
  const store = createIndicatorCatalogStore(async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return loadedCatalog;
  });

  await assert.rejects(store.load(), /offline/);
  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(await store.load(), loadedCatalog);
  assert.equal(calls, 2);
});

test("custom indicator edits update the reusable catalog snapshot", async () => {
  const store = createIndicatorCatalogStore(async () => loadedCatalog);
  await store.load();

  store.updateCustomIndicators((current) => current.map((item) => (
    item.id === "custom-one" ? { ...item, name: "Renamed custom" } : item
  )));
  assert.equal(store.getSnapshot()?.customIndicators[0]?.name, "Renamed custom");

  store.updateCustomIndicators((current) => current.filter((item) => item.id !== "custom-one"));
  assert.deepEqual(store.getSnapshot()?.customIndicators, []);
});

test("custom edits made during the first request survive an older catalog response", async () => {
  const pending = deferred<IndicatorCatalogSnapshot>();
  const store = createIndicatorCatalogStore(() => pending.promise);
  const loading = store.load();
  await Promise.resolve();

  store.updateCustomIndicators((current) => [...current, {
    ...loadedCatalog.customIndicators[0]!,
    id: "saved-during-load",
    name: "Saved during load",
  }]);
  pending.resolve({ ...loadedCatalog, customIndicators: [] });

  assert.deepEqual((await loading).customIndicators.map((item) => item.id), [
    "saved-during-load",
  ]);
});

test("catalog loading UI is suppressed once either catalog section is already available", () => {
  assert.equal(shouldShowIndicatorCatalogLoading(true, [], []), true);
  assert.equal(shouldShowIndicatorCatalogLoading(true, loadedCatalog.presets, []), false);
  assert.equal(shouldShowIndicatorCatalogLoading(true, [], loadedCatalog.customIndicators), false);
  assert.equal(shouldShowIndicatorCatalogLoading(false, [], []), false);
});
