import assert from "node:assert/strict";
import test from "node:test";

import {
  listContributedMarketRailViews,
  registerMarketRailView,
  subscribeMarketRailRegistry,
} from "../marketRailRegistry.js";

test("market rail registry snapshots stay stable until the registry changes", () => {
  const initial = listContributedMarketRailViews();
  assert.strictEqual(listContributedMarketRailViews(), initial);

  let notifications = 0;
  const unsubscribe = subscribeMarketRailRegistry(() => {
    notifications += 1;
  });
  const unregister = registerMarketRailView({
    id: "test-contribution",
    title: "Test contribution",
    icon: null,
    order: 100,
    sizing: "fixed",
  });

  try {
    const registered = listContributedMarketRailViews();
    assert.notStrictEqual(registered, initial);
    assert.strictEqual(listContributedMarketRailViews(), registered);
    assert.deepEqual(registered.map((view) => view.id), ["test-contribution"]);
    assert.equal(notifications, 1);
  } finally {
    unregister();
    unsubscribe();
  }

  assert.strictEqual(listContributedMarketRailViews(), initial);
  assert.equal(notifications, 2);
});
