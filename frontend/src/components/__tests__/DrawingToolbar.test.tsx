import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import DrawingToolbar from "../DrawingToolbar.js";

function buttonTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<button[^>]*${attribute}[^>]*>`))?.[0] ?? "";
}

test("engine wait disables drawing tools without hiding chart, cursor, or export controls", () => {
  const html = renderToStaticMarkup(
    <DrawingToolbar
      activeTool="cursor-crosshair"
      drawingInteractionReady={false}
      penColor="#f59e0b"
      penSize={2}
      selectedDrawing={{ id: "line-1", type: "line", color: "#f59e0b", lineWidth: 2 }}
      onClearAll={() => {}}
      onToggleDrawingsHidden={() => {}}
      onPositionSizeChange={() => {}}
    />,
  );

  assert.match(html, /data-drawing-toolbar-state="waiting-for-engine"/);
  assert.match(buttonTag(html, 'data-drawing-tool="pen"'), /disabled=""/);
  assert.doesNotMatch(buttonTag(html, 'data-chart-type="candlestick"'), /disabled=""/);
  assert.doesNotMatch(buttonTag(html, 'data-drawing-tool="cursor"'), /disabled=""/);
  assert.doesNotMatch(buttonTag(html, 'data-drawing-action="export"'), /disabled=""/);
  assert.doesNotMatch(buttonTag(html, 'title="Snap enabled'), /disabled=""/);
  assert.match(html, /title="Line color"/);
});
