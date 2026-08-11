import assert from "node:assert/strict";
import test from "node:test";

import {
  canRequestMoreLeftDuringRuntime,
  canRequestRightWindowRestoreDuringRuntime,
  formatChartDemandScope,
  shouldCommitRightWindowRestore,
} from "../useMarketDataRuntime.js";

test("chart demand scopes cannot collide across fast-refresh runtimes", () => {
  assert.equal(
    formatChartDemandScope("client", "runtime-a", 1),
    "chart:client:runtime-a:1",
  );
  assert.notEqual(
    formatChartDemandScope("client", "runtime-a", 1),
    formatChartDemandScope("client", "runtime-b", 1),
  );
  assert.notEqual(
    formatChartDemandScope("client", "runtime-a", 1),
    formatChartDemandScope("client", "runtime-a", 2),
  );
});

test("chart demand scope carries stable workspace window and cell ownership", () => {
  assert.equal(
    formatChartDemandScope("client", "runtime", 1, {
      workspaceId: "workspace-a",
      windowId: "window-b",
      cellId: "cell-03",
    }),
    "chart:client:runtime:1:workspace:workspace-a:window:window-b:cell:cell-03",
  );
});

test("chart demand scope hashes long dynamic ownership within the backend limit", () => {
  const owner = {
    workspaceId: "workspace-8ec343e5-6f43-454a-8b44-799e2c8d6db2",
    windowId: "window-1802a500-a615-43de-80b8-f0ee382cdceb",
    cellId: "cell-9b38ec9a-a897-41a3-92c1-a632d67a1e41",
  };
  const scope = formatChartDemandScope("clientid", "runtime-instance", 64, owner);
  const otherCellScope = formatChartDemandScope("clientid", "runtime-instance", 64, {
    ...owner,
    cellId: "cell-2d334872-c273-4a6b-9e66-028b3c7fc032",
  });

  assert.ok(scope.length <= 128);
  assert.match(scope, /^chart:clientid:runtime-instance:64:owner:[0-9a-f]{16}$/);
  assert.notEqual(scope, otherCellScope);
  assert.equal(formatChartDemandScope("clientid", "runtime-instance", 64, owner), scope);
});

test("right-window restore commits only for the owning session and epoch", () => {
  const owned = {
    aborted: false,
    active: true,
    currentEpoch: 7,
    currentSessionKey: "binance:spot:BTCUSDT:89m",
    expectedEpoch: 7,
    expectedSessionKey: "binance:spot:BTCUSDT:89m",
  };

  assert.equal(shouldCommitRightWindowRestore(owned), true);
  assert.equal(shouldCommitRightWindowRestore({
    ...owned,
    currentSessionKey: "binance:spot:BTCUSDT:1m",
  }), false);
  assert.equal(shouldCommitRightWindowRestore({ ...owned, currentEpoch: 8 }), false);
  assert.equal(shouldCommitRightWindowRestore({ ...owned, aborted: true }), false);
  assert.equal(shouldCommitRightWindowRestore({ ...owned, active: false }), false);
});

test("right-window restore is mutually exclusive with new left-page demand", () => {
  const ready = {
    hasMoreLeft: true,
    loading: false,
    loadingMoreLeft: false,
    marketDataReady: true,
  };

  assert.equal(canRequestMoreLeftDuringRuntime(ready), true);
  assert.equal(canRequestMoreLeftDuringRuntime({
    ...ready,
    restoringLatestWindow: true,
  }), false);
});

test("left-page loading and pending ownership both block right-window restore", () => {
  const ready = {
    loading: false,
    loadingMoreLeft: false,
    marketDataReady: true,
    paginationPhase: "idle" as const,
  };

  assert.equal(canRequestRightWindowRestoreDuringRuntime(ready), true);
  assert.equal(canRequestRightWindowRestoreDuringRuntime({
    ...ready,
    loadingMoreLeft: true,
    paginationPhase: "loading",
  }), false);
  assert.equal(canRequestRightWindowRestoreDuringRuntime({
    ...ready,
    paginationPhase: "pending",
  }), false);
  assert.equal(canRequestRightWindowRestoreDuringRuntime({
    ...ready,
    loading: true,
  }), false);
});
