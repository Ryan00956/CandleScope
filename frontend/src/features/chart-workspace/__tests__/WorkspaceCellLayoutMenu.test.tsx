import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkspaceCellLayoutMenu from "../WorkspaceCellLayoutMenu.js";

test("cell layout trigger exposes an accessible per-cell action entrypoint", () => {
  const html = renderToStaticMarkup(
    <WorkspaceCellLayoutMenu
      cellId="cell-2"
      layoutCellIds={["cell-1", "cell-2", "cell-3"]}
      onSplit={() => {}}
      onClose={() => {}}
      onSwap={() => {}}
    />,
  );

  assert.match(html, /aria-label="图 2 布局操作"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
});

test("disabled cell layout trigger cannot open structural actions", () => {
  const html = renderToStaticMarkup(
    <WorkspaceCellLayoutMenu
      cellId="cell-1"
      layoutCellIds={["cell-1"]}
      disabled
      onSplit={() => {}}
      onClose={() => {}}
      onSwap={() => {}}
    />,
  );

  assert.match(html, /disabled=""/);
  assert.match(html, /aria-expanded="false"/);
});
