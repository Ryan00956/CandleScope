import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAPSED_LISTS_KEY,
  WATCHLISTS_KEY,
  loadCollapsedLists,
  loadWatchlists,
} from "../watchlistStore.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

function withStorage(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem() {},
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("watchlist storage rejects damaged and malformed groups", () => {
  withStorage({ [WATCHLISTS_KEY]: "{damaged" }, () => {
    assert.deepEqual(loadWatchlists(), [
      { id: "default", name: "Watchlist", symbols: [], color: "#3b82f6" },
    ]);
  });

  withStorage({ [WATCHLISTS_KEY]: JSON.stringify([null, {}, { id: 2, name: [] }]) }, () => {
    assert.equal(mustBeDefined(loadWatchlists()[0]).id, "default");
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
