import assert from "node:assert/strict";
import test from "node:test";

import type { IndicatorRangeEvent } from "../klineContracts.js";
import {
  isIndicatorRangeSessionCurrent,
  retainCurrentIndicatorRangeRequests,
} from "../marketDataEvents.js";
import { epochSeconds } from "../../../test/testHelpers.js";

function rangeEvent(
  id: number,
  sessionKey: string,
  interval: string,
): IndicatorRangeEvent {
  return {
    id,
    sessionKey,
    interval,
    start: epochSeconds(100),
    end: epochSeconds(200),
    reason: "window-prepend",
    createdAt: id,
  };
}

test("rapid interval switching drops cancelled-session requests without losing current work", () => {
  const oldRequest = rangeEvent(1, "binance:spot:BTCUSDT:1h", "1h");
  const currentRequest = rangeEvent(2, "binance:spot:BTCUSDT:89m", "89m");
  const wrongSeriesRequest = rangeEvent(3, "binance:spot:BTCUSDT:89m", "1h");
  const activeSession = {
    sessionKey: "binance:spot:BTCUSDT:89m",
    interval: "89m",
  };

  const retained = retainCurrentIndicatorRangeRequests(
    [oldRequest, currentRequest, wrongSeriesRequest],
    activeSession,
  );
  assert.deepEqual(retained.map((request) => request.id), [2]);

  // A current request appended before the stale-queue cleanup commits must be
  // retained as well; cancellation is scoped instead of clearing the array.
  const appendedCurrent = rangeEvent(4, activeSession.sessionKey, "89m");
  const afterConcurrentPublish = retainCurrentIndicatorRangeRequests(
    [oldRequest, currentRequest, appendedCurrent],
    activeSession,
  );
  assert.deepEqual(afterConcurrentPublish.map((request) => request.id), [2, 4]);
});

test("a stale publisher is rejected after the active interval changes", () => {
  const activeSession = {
    sessionKey: "binance:spot:BTCUSDT:89m",
    interval: "89m",
  };
  assert.equal(isIndicatorRangeSessionCurrent(activeSession, activeSession), true);
  assert.equal(isIndicatorRangeSessionCurrent(activeSession, {
    sessionKey: "binance:spot:BTCUSDT:1h",
    interval: "1h",
  }), false);
  assert.equal(isIndicatorRangeSessionCurrent(activeSession, {
    sessionKey: activeSession.sessionKey,
    interval: "1h",
  }), false);
});
