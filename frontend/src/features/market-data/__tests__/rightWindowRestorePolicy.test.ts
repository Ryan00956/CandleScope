import assert from "node:assert/strict";
import test from "node:test";

import {
  canRequestMoreLeftDuringRuntime,
  canRequestRightWindowRestoreDuringRuntime,
  shouldCommitRightWindowRestore,
} from "../useMarketDataRuntime.js";

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
