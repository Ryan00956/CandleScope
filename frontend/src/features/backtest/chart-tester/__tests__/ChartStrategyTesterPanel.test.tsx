import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ChartStrategyTesterPanel from "../ChartStrategyTesterPanel.js";
import {
  loadChartStrategyPanelPreferences,
  saveChartStrategyPanelPreferences,
} from "../chartStrategyPanelPreferences.js";
import { StrategyDraftStore, createMemoryStrategyDraftAdapter } from "../StrategyDraftStore.js";
import { createChartStrategyTesterState } from "../chartStrategyTesterState.js";

const attachment = {
  schemaVersion: 1 as const,
  strategyDraftId: "draft-1",
  strategyRevisionId: null,
  displayName: "SMA Cross",
  language: "pyne" as const,
  parameters: {},
  rangeMode: "ALL_AVAILABLE" as const,
  customRange: null,
  fidelityPreference: "FAST" as const,
  quickPresetId: "CRYPTO_SPOT_STANDARD_V1",
  autoRun: false,
};

const session = { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1m" };

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
      runState={createChartStrategyTesterState(null, "workspace\u0000cell-1")}
      resolution={null}
      sourceDiagnostics={[]}
      pendingDataDraftRevision={null}
      onPrepareData={() => undefined}
      onStopObserving={() => undefined}
      onResumeObserving={() => undefined}
      onSourceDirty={() => undefined}
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

test("stop observing appears only after a backend Run ID exists", () => {
  const inputs = { session, attachment, draftContentRevision: 1 };
  const resolving = {
    ...createChartStrategyTesterState(inputs, "workspace\u0000cell-1"),
    status: "RESOLVING" as const,
  };
  const queued = {
    ...resolving,
    status: "QUEUED" as const,
    activeRunId: "bt_queued",
  };
  const render = (runState: typeof resolving | typeof queued) => renderToStaticMarkup(
    <ChartStrategyTesterPanel
      cellScope="workspace\u0000cell-1"
      session={session}
      attachment={attachment}
      draftStore={new StrategyDraftStore(createMemoryStrategyDraftAdapter())}
      onAttachmentChange={() => undefined}
      onEntryStateChange={() => undefined}
      onRunRequest={() => undefined}
      runState={runState}
      resolution={null}
      sourceDiagnostics={[]}
      pendingDataDraftRevision={null}
      onPrepareData={() => undefined}
      onStopObserving={() => undefined}
      onResumeObserving={() => undefined}
      onSourceDirty={() => undefined}
      onClose={() => undefined}
    />,
  );

  assert.doesNotMatch(render(resolving), /data-testid="chart-strategy-stop-observing"/);
  assert.match(render(queued), /data-testid="chart-strategy-stop-observing"/);
});

test("a paused auto-run reason is visible and actionable without exposing Run identity", () => {
  const html = renderToStaticMarkup(
    <ChartStrategyTesterPanel
      cellScope="workspace\u0000cell-1"
      session={session}
      attachment={{ ...attachment, autoRun: true, fidelityPreference: "PRECISE" }}
      draftStore={new StrategyDraftStore(createMemoryStrategyDraftAdapter())}
      onAttachmentChange={() => undefined}
      onEntryStateChange={() => undefined}
      onRunRequest={() => undefined}
      runState={createChartStrategyTesterState({
        session,
        attachment: { ...attachment, autoRun: true, fidelityPreference: "PRECISE" },
        draftContentRevision: 1,
      }, "workspace\u0000cell-1")}
      resolution={null}
      sourceDiagnostics={[]}
      pendingDataDraftRevision={null}
      autoRunPauseReason="PRECISE_REQUIRES_MANUAL"
      onPrepareData={() => undefined}
      onStopObserving={() => undefined}
      onResumeObserving={() => undefined}
      onSourceDirty={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /data-auto-run-pause="PRECISE_REQUIRES_MANUAL"/);
  assert.doesNotMatch(html, /bt_[A-Za-z0-9_-]+/);
});

test("panel height and active tab persist by cell scope without cross-cell copying", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
  saveChartStrategyPanelPreferences("workspace\u0000cell-1", {
    height: 444,
    activeTab: "trades",
  }, storage);
  assert.deepEqual(loadChartStrategyPanelPreferences("workspace\u0000cell-1", storage), {
    height: 444,
    activeTab: "trades",
  });
  assert.deepEqual(loadChartStrategyPanelPreferences("workspace\u0000cell-2", storage), {
    height: 383,
    activeTab: "script",
  });
});
