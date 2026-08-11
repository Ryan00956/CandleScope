import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPaneHeights,
  loadPaneOrder,
  savePaneHeights,
  savePaneOrder,
} from "../paneLayoutStorage.js";
import { withLocalStorage } from "./localStorageHarness.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

const PANE_HEIGHTS_KEY = "candlescope-pane-heights";
const PANE_ORDER_KEY = "candlescope-pane-order-v1";

test("pane height storage keeps only finite positive arrays", () => {
  withLocalStorage({
    [PANE_HEIGHTS_KEY]: JSON.stringify({
      valid: [400, 200],
      negative: [400, -1],
      infinite: [400, null],
      scalar: 400,
      empty: [],
    }),
  }, () => {
    assert.deepEqual(loadPaneHeights(), { valid: [400, 200] });
  });
});

test("pane height writes sanitize invalid entries without changing the storage key", () => {
  withLocalStorage({}, (storage) => {
    savePaneHeights({ valid: [300, 120], invalid: [0, 100] });
    assert.deepEqual(JSON.parse(mustBeDefined(storage.getItem(PANE_HEIGHTS_KEY))), {
      valid: [300, 120],
    });
  });
});

test("pane order storage keeps bounded unique pane ids", () => {
  withLocalStorage({
    [PANE_ORDER_KEY]: JSON.stringify(["rsi", "rsi", "", 42, "vol"]),
  }, (storage) => {
    assert.deepEqual(loadPaneOrder(), ["rsi", "vol"]);
    savePaneOrder(["vol", "macd", "vol", null]);
    assert.deepEqual(JSON.parse(mustBeDefined(storage.getItem(PANE_ORDER_KEY))), ["vol", "macd"]);
  });
});

test("pane order storage isolates chart cells and falls back to the legacy order", () => {
  withLocalStorage({
    [PANE_ORDER_KEY]: JSON.stringify(["main", "vol"]),
  }, (storage) => {
    assert.deepEqual(loadPaneOrder("cell-2"), ["main", "vol"]);
    savePaneOrder(["main", "rsi"], "cell-2");
    assert.deepEqual(loadPaneOrder("cell-2"), ["main", "rsi"]);
    assert.deepEqual(loadPaneOrder("cell-1"), ["main", "vol"]);
    assert.deepEqual(
      JSON.parse(mustBeDefined(storage.getItem(`${PANE_ORDER_KEY}:cell-2`))),
      ["main", "rsi"],
    );
  });
});
