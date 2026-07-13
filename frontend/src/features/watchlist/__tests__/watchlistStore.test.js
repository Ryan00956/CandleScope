import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAPSED_LISTS_KEY,
  WATCHLISTS_KEY,
  loadCollapsedLists,
  loadWatchlists,
} from "../watchlistStore.js";

function withStorage(values, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values[key] ?? null,
      setItem() {},
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("watchlist storage rejects damaged and malformed groups", () => {
  withStorage({ [WATCHLISTS_KEY]: "{damaged" }, () => {
    assert.deepEqual(loadWatchlists(), [
      { id: "default", name: "Watchlist", symbols: [], color: "#3b82f6" },
    ]);
  });

  withStorage({ [WATCHLISTS_KEY]: JSON.stringify([null, {}, { id: 2, name: [] }]) }, () => {
    assert.equal(loadWatchlists()[0].id, "default");
  });
});

test("watchlist storage keeps valid groups and filters invalid collapsed ids", () => {
  withStorage({
    [WATCHLISTS_KEY]: JSON.stringify([
      { id: "main", name: "Main", color: "#fff", symbols: ["spot:btcusdt", null] },
    ]),
    [COLLAPSED_LISTS_KEY]: JSON.stringify(["main", 3, null]),
  }, () => {
    assert.deepEqual(loadWatchlists(), [
      { id: "main", name: "Main", color: "#fff", symbols: ["spot:BTCUSDT"] },
    ]);
    assert.deepEqual(loadCollapsedLists(), ["main"]);
  });
});
