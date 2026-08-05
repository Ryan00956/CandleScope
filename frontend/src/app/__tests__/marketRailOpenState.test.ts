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

test("loadMarketRailLayout migrates legacy collapsed rail to empty open set", () => {
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
  assert.deepEqual(layout.openViewIds, []);
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
