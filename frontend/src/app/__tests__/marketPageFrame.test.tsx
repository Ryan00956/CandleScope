import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarketPageFrame from "../MarketPageFrame.js";
import MarketWorkspaceFrame from "../MarketWorkspaceFrame.js";
import MarketTopBarFrame from "../MarketTopBarFrame.js";
import MarketStatusBar from "../MarketStatusBar.js";
import MarketRightRailFrame from "../MarketRightRailFrame.js";
import type { MarketRailViewDescriptor } from "../marketRailTypes.js";

const sampleViews: MarketRailViewDescriptor[] = [
  {
    id: "watchlist",
    title: "自选",
    icon: <span data-icon="watchlist" />,
    order: 10,
    sizing: "flex",
  },
  {
    id: "order-book",
    title: "盘口",
    icon: <span data-icon="order-book" />,
    order: 20,
    sizing: "fixed",
    defaultHeight: 320,
  },
];

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
      bottomPanel={<section data-slot="bottom" />}
      rightRail={<aside data-slot="rail" />}
    />,
  );
  assert.match(html, /class="main-content-area"/);
  assert.match(html, /class="chart-with-toolbar"/);
  assert.ok(html.indexOf("data-slot=\"toolbar\"") < html.indexOf("data-slot=\"chart\""));
  assert.ok(html.indexOf("data-slot=\"chart\"") < html.indexOf("data-slot=\"bottom\""));
  assert.ok(html.indexOf("data-slot=\"bottom\"") < html.indexOf("data-slot=\"rail\""));
  assert.match(html, /class="market-workspace-content"/);
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

test("live and replay use the same free multi-open scroll accordion", () => {
  for (const source of ["live", "replay"] as const) {
    const html = renderToStaticMarkup(
      <MarketRightRailFrame
        source={source}
        views={sampleViews}
        openViewIds={["watchlist", "order-book"]}
        onToggleView={() => undefined}
        renderView={(viewId, height) => (
          <div data-slot={viewId === "watchlist" ? "sidebar" : "dock"} data-height={height}>
            {viewId}
          </div>
        )}
        layout={{ width: 360, onWidthChange: () => undefined }}
        viewHeights={{ watchlist: 240, "order-book": 410 }}
        onViewHeightChange={() => undefined}
      />,
    );
    assert.match(html, /data-market-shell-owner="right-rail"/);
    assert.match(html, /data-layout-mode="scroll-accordion"/);
    assert.match(html, /data-market-shell-owner="activity-bar"/);
    assert.match(html, /data-market-shell-owner="right-rail-panel"/);
    assert.match(html, /class="wl-resize-handle/);
    assert.equal((html.match(/market-rail-view-resizer/g) ?? []).length, 2);
    assert.match(html, /data-height="240"/);
    assert.match(html, /data-height="410"/);
    assert.match(html, /aria-valuenow="240"/);
    assert.match(html, /aria-valuenow="410"/);
    assert.match(html, /data-rail-view="watchlist"[^>]*data-expanded="true"/);
    assert.match(html, /data-rail-view="order-book"[^>]*data-expanded="true"/);
    assert.ok(html.indexOf("data-slot=\"sidebar\"") < html.indexOf("data-slot=\"dock\""));
    assert.ok(html.indexOf("data-slot=\"dock\"") < html.indexOf("data-market-shell-owner=\"activity-bar\""));
  }
});

test("all accordion bodies can close while useful headers and the outer panel remain", () => {
  const html = renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={sampleViews}
      openViewIds={[]}
      onToggleView={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  );
  assert.match(html, /data-panel-open="true"/);
  assert.match(html, /data-market-shell-owner="activity-bar"/);
  assert.match(html, /data-market-shell-owner="right-rail-panel"/);
  assert.match(html, /aria-label="展开自选面板"/);
  assert.match(html, /aria-label="展开盘口面板"/);
  assert.equal((html.match(/market-rail-accordion-trigger/g) ?? []).length, 2);
  assert.doesNotMatch(html, /market-rail-view-resizer/);
  assert.match(html, /class="wl-resize-handle/);
});

test("one collapsed accordion view stays visible while another remains expanded", () => {
  const html = renderToStaticMarkup(
    <MarketRightRailFrame
      source="replay"
      views={sampleViews}
      openViewIds={["watchlist"]}
      onToggleView={() => undefined}
      renderView={(viewId) => <div data-kept={viewId}>{viewId}</div>}
      layout={{ width: 360 }}
      viewHeights={{ watchlist: 280, "order-book": 460 }}
      onViewHeightChange={() => undefined}
    />,
  );
  assert.match(html, /data-rail-view="watchlist"[^>]*data-expanded="true"/);
  assert.match(html, /data-kept="watchlist"/);
  assert.match(html, /data-rail-view="order-book"[^>]*data-expanded="false"/);
  assert.match(html, /aria-label="展开盘口面板"/);
  assert.doesNotMatch(html, /data-kept="order-book"/);
  assert.equal((html.match(/market-rail-view-resizer/g) ?? []).length, 1);
});

test("right rail can hide panel while keeping open views selected for full restore", () => {
  const html = renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={sampleViews}
      openViewIds={["watchlist", "order-book"]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={(viewId) => <div data-kept={viewId}>{viewId}</div>}
      layout={{ width: 360 }}
    />,
  );
  assert.match(html, /panel-collapsed/);
  assert.match(html, /data-panel-open="false"/);
  assert.match(html, /data-panel-collapsed="true"/);
  // Content stays mounted (display:none) so expand restores full UI state.
  assert.match(html, /data-market-shell-owner="right-rail-panel"/);
  assert.match(html, /data-kept="watchlist"/);
  assert.match(html, /data-kept="order-book"/);
  assert.match(html, /display:\s*none/);
  assert.doesNotMatch(html, /class="wl-resize-handle/);
  // Active icons remain lit while panel is only hidden.
  assert.match(html, /aria-pressed="true"[^>]*aria-expanded="false"[^>]*data-rail-view="watchlist"/);
  assert.match(html, /data-rail-action="toggle-panel"/);
  assert.match(html, /显示侧栏/);
});

test("multi-chart rail portal forwards independent card-close and panel-collapse controls", () => {
  const source = readFileSync(resolve(process.cwd(), "src/app/LiveChartCell.tsx"), "utf8");
  const portalStart = source.indexOf("{active && portalHosts.rightRail");
  const portalEnd = source.indexOf("{active && portalHosts.featureSurfaces", portalStart);

  assert.ok(portalStart >= 0, "right-rail portal must exist");
  assert.ok(portalEnd > portalStart, "right-rail portal must stay isolated from feature surfaces");

  const portalSource = source.slice(portalStart, portalEnd);
  assert.match(portalSource, /panelCollapsed=\{marketRail\.panelCollapsed \?\? false\}/);
  assert.match(portalSource, /onCloseView: marketRail\.onCloseView/);
  assert.match(portalSource, /onTogglePanelCollapsed: marketRail\.onTogglePanelCollapsed/);
});

test("right rail grows independent accordion cards inside one outer scrolling surface", () => {
  const styles = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
  assert.match(styles, /\.market-rail-panel \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.market-rail-panel \{[\s\S]*?overscroll-behavior-y: contain;/);
  assert.match(styles, /\.market-rail-accordion-section \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /\.market-rail-accordion-trigger \{[\s\S]*?min-height: 36px;/);
  assert.match(styles, /\.market-rail-view-host \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /\.market-rail-view-resizer \{[\s\S]*?flex-basis: 7px;/);
  assert.match(styles, /\.right-market-rail :is\([\s\S]*?overscroll-behavior-y: auto;/);
  assert.match(styles, /\.replay-market-dock-body \{ flex: 1 1 0; min-height: 0; overflow: auto; \}/);
});

test("replay activity buttons do not leave frozen transition timelines retaining old rails", () => {
  const styles = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
  assert.match(
    styles,
    /\.right-market-rail\[data-runtime-source="replay"\] \.market-activity-item \{[\s\S]*?transition: none;/,
  );
});
