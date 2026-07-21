import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarketPageFrame from "../MarketPageFrame.js";
import MarketWorkspaceFrame from "../MarketWorkspaceFrame.js";
import MarketTopBarFrame from "../MarketTopBarFrame.js";
import MarketStatusBar from "../MarketStatusBar.js";
import MarketRightRailFrame from "../MarketRightRailFrame.js";

test("MarketPageFrame preserves live shell slot order and root class", () => {
  const html = renderToStaticMarkup(
    <MarketPageFrame
      topBar={<header data-slot="top" />}
      intervalSelector={<nav data-slot="interval" />}
      workspace={<main data-slot="workspace" />}
      featureSurfaces={<section data-slot="features" />}
      statusBar={<footer data-slot="status" />}
    />,
  );
  assert.match(html, /^<div class="app-layout">/);
  const order = ["top", "interval", "workspace", "features", "status"]
    .map((slot) => html.indexOf(`data-slot="${slot}"`));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test("MarketWorkspaceFrame preserves chart-with-toolbar and right-rail ownership slots", () => {
  const html = renderToStaticMarkup(
    <MarketWorkspaceFrame
      toolbar={<div data-slot="toolbar" />}
      exportOverlay={<div data-slot="export" />}
      chart={<div data-slot="chart" />}
      rightRail={<aside data-slot="rail" />}
    />,
  );
  assert.match(html, /class="main-content-area"/);
  assert.match(html, /class="chart-with-toolbar"/);
  assert.ok(html.indexOf("data-slot=\"toolbar\"") < html.indexOf("data-slot=\"chart\""));
  assert.ok(html.indexOf("data-slot=\"chart\"") < html.indexOf("data-slot=\"rail\""));
});

test("live and replay top/status adapters share exact source-neutral DOM owners", () => {
  for (const source of ["live", "replay"] as const) {
    const top = renderToStaticMarkup(
      <MarketTopBarFrame
        source={source}
        navigation={<span data-slot="navigation" />}
        identity={<span data-slot="identity" />}
        controls={<span data-slot="controls" />}
        quote={<span data-slot="quote" />}
        marketMetrics={<span data-slot="metrics" />}
        ohlcv={<span data-slot="ohlcv" />}
      />,
    );
    assert.match(top, /class="top-bar"/);
    assert.match(top, /data-market-shell-owner="top-bar"/);
    assert.match(top, new RegExp(`data-runtime-source="${source}"`));
    const order = ["navigation", "identity", "controls", "quote", "metrics", "ohlcv"]
      .map((slot) => top.indexOf(`data-slot="${slot}"`));
    assert.deepEqual(order, [...order].sort((left, right) => left - right));

    const status = renderToStaticMarkup(
      <MarketStatusBar
        source={source}
        connectionStatus="connected"
        left={<span data-slot="left" />}
        right={<span data-slot="right" />}
      />,
    );
    assert.match(status, /data-market-shell-owner="status-bar"/);
    assert.ok(status.indexOf("data-slot=\"left\"") < status.indexOf("data-slot=\"right\""));
  }
});

test("live and replay right rails share resize, sidebar, and dock ownership slots", () => {
  for (const source of ["live", "replay"] as const) {
    const html = renderToStaticMarkup(
      <MarketRightRailFrame
        source={source}
        sidebar={<div data-slot="sidebar" />}
        renderDock={(height) => <div data-slot="dock" data-height={height} />}
        layout={{ width: 360, collapsed: false, onWidthChange: () => undefined }}
        dockLayout={{ height: 320, collapsed: false, onHeightChange: () => undefined }}
      />,
    );
    assert.match(html, /data-market-shell-owner="right-rail"/);
    assert.match(html, /class="wl-resize-handle/);
    assert.match(html, /class="market-rail-splitter/);
    assert.ok(html.indexOf("data-slot=\"sidebar\"") < html.indexOf("data-slot=\"dock\""));
  }
});
