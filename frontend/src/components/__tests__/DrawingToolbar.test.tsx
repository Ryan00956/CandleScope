import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getLocale, setLocale } from "../../i18n/index.js";
import DrawingToolbar from "../DrawingToolbar.js";

function buttonTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<button[^>]*${attribute}[^>]*>`))?.[0] ?? "";
}

function renderInEnglish(element: React.ReactNode): string {
  const previousLocale = getLocale();
  try {
    setLocale("en");
    return renderToStaticMarkup(element);
  } finally {
    setLocale(previousLocale);
  }
}

test("engine wait disables drawing tools without hiding chart, cursor, or export controls", () => {
  const html = renderInEnglish(
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

test("continuous drawing toggle exposes its selected state beside the snap toggle", () => {
  const html = renderInEnglish(
    <DrawingToolbar
      activeTool="line-segment"
      drawingContinuousEnabled
      penColor="#f59e0b"
      penSize={2}
      onClearAll={() => {}}
      onToggleDrawingsHidden={() => {}}
      onPositionSizeChange={() => {}}
    />,
  );

  const button = buttonTag(html, 'data-drawing-tool="continuous"');
  assert.match(button, /class="drawing-tool-btn active"/);
  assert.match(button, /title="Continuous drawing enabled; stay on the selected tool after completing a drawing"/);
});
