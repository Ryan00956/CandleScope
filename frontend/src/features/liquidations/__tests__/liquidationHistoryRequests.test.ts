import assert from "node:assert/strict";
import test from "node:test";

import {
  LiquidationHistoryRequestCoordinator,
  normalizeLiquidationHistoryRange,
  subtractLiquidationHistoryCoverage,
} from "../liquidationHistoryRequests.js";

test("future-only ranges fail closed before any history claim can be created", () => {
  const nowMs = 1_700_000_000_000;
  const requested = normalizeLiquidationHistoryRange({
    startMs: nowMs + 1,
    endMs: nowMs + 120_000,
  }, nowMs);
  assert.equal(requested, null);

  const coordinator = new LiquidationHistoryRequestCoordinator();
  if (requested) coordinator.claim("long", requested, []);
  assert.deepEqual(coordinator.inFlight("long"), []);
});

test("ranges crossing now include the current partial minute without covering the future", () => {
  const nowMs = 1_700_000_012_345;
  const requested = normalizeLiquidationHistoryRange({
    startMs: nowMs - 61_234,
    endMs: nowMs + 120_000,
  }, nowMs);

  assert.deepEqual(requested, {
    startMs: Math.floor((nowMs - 61_234) / 60_000) * 60_000,
    endMs: nowMs,
  });
});

test("coverage subtraction returns every gap around an occupied middle interval", () => {
  assert.deepEqual(
    subtractLiquidationHistoryCoverage(
      { startMs: 0, endMs: 299 },
      [{ startMs: 100, endMs: 199 }],
    ),
    [
      { startMs: 0, endMs: 99 },
      { startMs: 200, endMs: 299 },
    ],
  );
});

test("overlapping viewport requests claim only ranges not already in flight", () => {
  const coordinator = new LiquidationHistoryRequestCoordinator();
  const first = coordinator.claim("long", { startMs: 0, endMs: 199 }, []);
  const second = coordinator.claim("long", { startMs: 100, endMs: 299 }, []);

  assert.deepEqual(first.map((claim) => claim.range), [{ startMs: 0, endMs: 199 }]);
  assert.deepEqual(second.map((claim) => claim.range), [{ startMs: 200, endMs: 299 }]);
  assert.deepEqual(coordinator.inFlight("long"), [
    { startMs: 0, endMs: 199 },
    { startMs: 200, endMs: 299 },
  ]);
});

test("durable and in-flight ranges are subtracted together without hiding later gaps", () => {
  const coordinator = new LiquidationHistoryRequestCoordinator();
  coordinator.claim("short", { startMs: 100, endMs: 199 }, []);

  const claims = coordinator.claim(
    "short",
    { startMs: 0, endMs: 299 },
    [{ startMs: 0, endMs: 49 }],
  );

  assert.deepEqual(claims.map((claim) => claim.range), [
    { startMs: 50, endMs: 99 },
    { startMs: 200, endMs: 299 },
  ]);
});

test("claims are isolated by side and become retryable after release or clear", () => {
  const coordinator = new LiquidationHistoryRequestCoordinator();
  const [longClaim] = coordinator.claim("long", { startMs: 0, endMs: 99 }, []);
  assert.ok(longClaim);
  assert.deepEqual(
    coordinator.claim("short", { startMs: 0, endMs: 99 }, []).map((claim) => claim.range),
    [{ startMs: 0, endMs: 99 }],
  );
  assert.deepEqual(coordinator.claim("long", { startMs: 0, endMs: 99 }, []), []);

  coordinator.release(longClaim);
  assert.deepEqual(
    coordinator.claim("long", { startMs: 0, endMs: 99 }, []).map((claim) => claim.range),
    [{ startMs: 0, endMs: 99 }],
  );
  coordinator.clear();
  assert.deepEqual(coordinator.inFlight("long"), []);
  assert.deepEqual(coordinator.inFlight("short"), []);
});
