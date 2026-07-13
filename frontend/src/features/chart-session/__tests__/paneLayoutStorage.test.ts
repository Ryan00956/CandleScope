import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPaneHeights,
  savePaneHeights,
} from "../paneLayoutStorage.js";
import { withLocalStorage } from "./localStorageHarness.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

const PANE_HEIGHTS_KEY = "candlescope-pane-heights";

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
