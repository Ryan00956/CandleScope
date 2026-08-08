import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateRailViewHeights,
  loadMarketRailLayout,
  normalizeOpenViewIds,
  orderedOpenViews,
  toggleOpenViewId,
} from "../marketRailOpenState.js";
import type { MarketRailViewDescriptor } from "../marketRailTypes.js";

const views: MarketRailViewDescriptor[] = [
  {
    id: "watchlist",
    title: "自选",
    icon: null,
    order: 10,
    sizing: "flex",
    minHeight: 120,
  },
  {
    id: "order-book",
    title: "盘口",
    icon: null,
    order: 20,
    sizing: "fixed",
    defaultHeight: 360,
    minHeight: 220,
    maxHeight: 640,
  },
  {
    id: "tape",
    title: "成交",
    icon: null,
    order: 30,
    sizing: "fixed",
    defaultHeight: 280,
    minHeight: 220,
    maxHeight: 640,
  },
];

test("toggleOpenViewId adds and removes views", () => {
  assert.deepEqual(toggleOpenViewId(["watchlist"], "order-book"), ["watchlist", "order-book"]);
  assert.deepEqual(toggleOpenViewId(["watchlist", "order-book"], "watchlist"), ["order-book"]);
});

test("orderedOpenViews stacks by registry order not open order", () => {
  const ordered = orderedOpenViews(views, ["tape", "watchlist", "order-book"]);
  assert.deepEqual(ordered.map((view) => view.id), ["watchlist", "order-book", "tape"]);
});

test("allocateRailViewHeights gives flex remainder after fixed docks", () => {
  const heights = allocateRailViewHeights(
    orderedOpenViews(views, ["watchlist", "order-book"]),
    800,
    { "order-book": 300 },
  );
  assert.equal(heights["order-book"], 300);
  assert.equal(heights.watchlist, 800 - 300 - 5);
});

test("allocateRailViewHeights fills single open view", () => {
  const heights = allocateRailViewHeights(
    orderedOpenViews(views, ["watchlist"]),
    640,
    {},
  );
  assert.equal(heights.watchlist, 640);
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
