import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkspaceLayoutTree from "../WorkspaceLayoutTree.js";
import { createChartWorkspaceLayoutTree } from "../chartWorkspaceLayout.js";

test("recursive renderer materializes both levels of the main and confirmation template", () => {
  const html = renderToStaticMarkup(
    <WorkspaceLayoutTree
      tree={createChartWorkspaceLayoutTree("main-confirmation")}
      maximizedCellId={null}
      renderCell={(cellId, role) => (
        <article data-rendered-cell={cellId} data-rendered-role={role ?? "standard"} />
      )}
      onSplitRatioChange={() => {}}
      onCellDrop={() => {}}
    />,
  );

  assert.match(html, /data-layout-split-id="main-confirmation-root"/);
  assert.match(html, /data-layout-split-id="main-confirmation-confirmations"/);
  assert.match(html, /data-rendered-cell="cell-1" data-rendered-role="main"/);
  assert.match(html, /data-rendered-cell="cell-2" data-rendered-role="confirmation"/);
  assert.match(html, /data-rendered-cell="cell-3" data-rendered-role="confirmation"/);
  assert.equal((html.match(/role="separator"/g) ?? []).length, 2);
});

test("maximized recursive layout renders only the requested cell and no split handles", () => {
  const html = renderToStaticMarkup(
    <WorkspaceLayoutTree
      tree={createChartWorkspaceLayoutTree("main-confirmation")}
      maximizedCellId="cell-3"
      renderCell={(cellId, role) => (
        <article data-rendered-cell={cellId} data-rendered-role={role ?? "standard"} />
      )}
      onSplitRatioChange={() => {}}
      onCellDrop={() => {}}
    />,
  );

  assert.match(html, /data-rendered-cell="cell-3" data-rendered-role="confirmation"/);
  assert.doesNotMatch(html, /data-rendered-cell="cell-1"/);
  assert.doesNotMatch(html, /role="separator"/);
});

test("locked recursive layouts expose their split handles as disabled and unfocusable", () => {
  const html = renderToStaticMarkup(
    <WorkspaceLayoutTree
      tree={createChartWorkspaceLayoutTree("split-vertical")}
      maximizedCellId={null}
      disabled
      renderCell={(cellId) => <article data-rendered-cell={cellId} />}
      onSplitRatioChange={() => {}}
      onCellDrop={() => {}}
    />,
  );

  assert.match(html, /role="separator"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /tabindex="-1"/);
});
