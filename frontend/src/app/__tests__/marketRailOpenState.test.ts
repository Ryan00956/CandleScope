import assert from "node:assert/strict";
import test from "node:test";

import {
  loadMarketRailLayout,
  normalizeOpenViewIds,
  toggleOpenViewId,
} from "../marketRailOpenState.js";

test("toggleOpenViewId adds and removes views", () => {
  assert.deepEqual(toggleOpenViewId(["watchlist"], "order-book"), ["watchlist", "order-book"]);
  assert.deepEqual(toggleOpenViewId(["watchlist", "order-book"], "watchlist"), ["order-book"]);
});

test("loadMarketRailLayout migrates legacy collapsed rail to hide-only panel state", () => {
  const storage = {
    data: {
      "candlescope-sidebar-collapsed": "true",
      "candlescope-order-book-collapsed": "false",
    } as Record<string, string>,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };
  const layout = loadMarketRailLayout(storage);
  // Expand must be able to restore content — do not permanently clear openViewIds.
  assert.ok(layout.openViewIds.length > 0);
  assert.equal(layout.panelCollapsed, true);
  assert.ok(layout.openViewIds.includes("watchlist"));
});

test("loadMarketRailLayout migrates a v1 empty open set to restorable v2 collapse state", () => {
  const storage = {
    data: {
      "candlescope-market-rail-layout-v1": JSON.stringify({
        openViewIds: [],
        viewHeights: { "order-book": 444 },
      }),
    } as Record<string, string>,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };

  const layout = loadMarketRailLayout(storage);

  assert.deepEqual(layout.openViewIds, ["watchlist", "order-book"]);
  assert.equal(layout.panelCollapsed, true);
  assert.equal(layout.viewHeights["order-book"], 444);
  assert.deepEqual(
    JSON.parse(storage.data["candlescope-market-rail-layout-v2"] ?? "null"),
    layout,
  );
});

test("loadMarketRailLayout preserves an intentional empty open set in v2", () => {
  const storage = {
    data: {
      "candlescope-market-rail-layout-v1": JSON.stringify({
        openViewIds: ["watchlist", "order-book"],
        panelCollapsed: true,
        viewHeights: {},
      }),
      "candlescope-market-rail-layout-v2": JSON.stringify({
        openViewIds: [],
        panelCollapsed: false,
        viewHeights: {},
      }),
    } as Record<string, string>,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };

  const layout = loadMarketRailLayout(storage);

  assert.deepEqual(layout.openViewIds, []);
  assert.equal(layout.panelCollapsed, false);
});

test("loadMarketRailLayout preserves whole-panel collapse even when every accordion body is closed", () => {
  const storage = {
    data: {
      "candlescope-market-rail-layout-v2": JSON.stringify({
        openViewIds: [],
        panelCollapsed: true,
        viewHeights: { watchlist: 280 },
      }),
    } as Record<string, string>,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };

  const layout = loadMarketRailLayout(storage);

  assert.deepEqual(layout.openViewIds, []);
  assert.equal(layout.panelCollapsed, true);
  assert.equal(layout.viewHeights.watchlist, 280);
});

test("loadMarketRailLayout migrates legacy expanded dockView tape", () => {
  const storage = {
    data: {
      "candlescope-sidebar-collapsed": "false",
      "candlescope-order-book-collapsed": "false",
      "candlescope-trade-flow-preferences-v1": JSON.stringify({ dockView: "tape" }),
    } as Record<string, string>,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
  };
  const layout = loadMarketRailLayout(storage);
  assert.deepEqual(layout.openViewIds, ["watchlist", "tape"]);
});

test("normalizeOpenViewIds drops duplicates and blanks", () => {
  assert.deepEqual(
    normalizeOpenViewIds(["watchlist", "", "watchlist", "order-book"]),
    ["watchlist", "order-book"],
  );
});
