import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MarketPageFrame from "../MarketPageFrame.js";
import MarketWorkspaceFrame from "../MarketWorkspaceFrame.js";

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
