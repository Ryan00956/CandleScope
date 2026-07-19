import assert from "node:assert/strict";
import test from "node:test";
import type { KlineBar } from "../../market-data/marketDataTypes.js";
import { createKlineOrderFlowProjectionMemo } from "../klineOrderFlowProjection.js";

function bar(time: number, contribution: number | null): KlineBar {
  return {
    time: time as KlineBar["time"],
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 10,
    taker_buy_base: contribution === null ? null : 6,
    order_flow: contribution === null ? null : {
      taker_sell_base: 4,
      volume_delta_base: contribution,
      taker_buy_ratio_base: 0.6,
      cvd_contribution_base: contribution,
    },
  };
}

function cvdValues(panes: ReturnType<ReturnType<typeof createKlineOrderFlowProjectionMemo>["project"]>) {
  return panes.find((pane) => pane.id === "trade-flow-cvd")?.lines[0]?.data.map((point) => point.value);
}

test("forming K-line replacement replaces rather than double-adds CVD contribution", () => {
  const projection = createKlineOrderFlowProjectionMemo();
  const bars = [bar(60, 2), bar(120, -1)];
  const first = projection.project({ bars, enabled: true, forceFull: true, intervalSeconds: 60 });
  assert.deepEqual(cvdValues(first), [2, 1]);

  bars[1] = bar(120, 3);
  const updated = projection.project({ bars, enabled: true, forceFull: false, intervalSeconds: 60 });
  assert.deepEqual(cvdValues(updated), [2, 5]);
});

test("CVD restarts only at the latest contiguous valid suffix after a gap", () => {
  const projection = createKlineOrderFlowProjectionMemo();
  const panes = projection.project({
    bars: [bar(60, 2), bar(120, null), bar(180, 4)],
    enabled: true,
    forceFull: true,
    intervalSeconds: 60,
  });
  assert.deepEqual(cvdValues(panes), [4]);
  assert.match(panes[0]?.statusText || "", /最近连续段/);
});

test("forming K-line availability changes rebuild the latest valid CVD suffix", () => {
  const projection = createKlineOrderFlowProjectionMemo();
  const bars = [bar(60, 2), bar(120, 3)];
  projection.project({ bars, enabled: true, forceFull: true, intervalSeconds: 60 });

  bars[1] = bar(120, null);
  const unavailable = projection.project({
    bars,
    enabled: true,
    forceFull: false,
    intervalSeconds: 60,
  });
  assert.deepEqual(cvdValues(unavailable), []);

  bars[1] = bar(120, 3);
  const restored = projection.project({
    bars,
    enabled: true,
    forceFull: false,
    intervalSeconds: 60,
  });
  assert.deepEqual(cvdValues(restored), [2, 5]);
});

test("CVD status reports a time-axis discontinuity even when every bar has flow fields", () => {
  const projection = createKlineOrderFlowProjectionMemo();
  const panes = projection.project({
    bars: [bar(60, 2), bar(180, 4)],
    enabled: true,
    forceFull: true,
    intervalSeconds: 60,
  });
  assert.deepEqual(cvdValues(panes), [4]);
  assert.match(panes[0]?.statusText || "", /1 处时间缺口/);
  assert.equal(panes[0]?.pointMetadata?.[0]?.qualityLabel, "最近连续段锚定 0");
});
