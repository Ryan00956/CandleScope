import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ChartStrategyTesterPanel from "../ChartStrategyTesterPanel.js";
import { StrategyDraftStore, createMemoryStrategyDraftAdapter } from "../StrategyDraftStore.js";

test("first open renders three starts, no blank editor, and no premature Run button", () => {
  const html = renderToStaticMarkup(
    <ChartStrategyTesterPanel
      cellScope="workspace\u0000cell-1"
      session={{ exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1m" }}
      attachment={null}
      draftStore={new StrategyDraftStore(createMemoryStrategyDraftAdapter())}
      onAttachmentChange={() => undefined}
      onEntryStateChange={() => undefined}
      onRunRequest={() => undefined}
      onClose={() => undefined}
    />,
  );

  assert.match(html, /data-chart-strategy-panel="true"/);
  assert.match(html, />01<.*>02<.*>03</s);
  assert.match(html, /href="\/backtest\.html"/);
  assert.doesNotMatch(html, /data-chart-strategy-editor/);
  assert.doesNotMatch(html, /chart-strategy-run-button/);
  assert.doesNotMatch(html, /保存 revision|创建 Run/);
  assert.doesNotMatch(html, /<(?:input|select|textarea)[^>]+(?:dataset|snapshot|run|revision)/i);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
});
