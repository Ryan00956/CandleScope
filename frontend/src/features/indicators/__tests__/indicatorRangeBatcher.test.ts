import assert from "node:assert/strict";
import test from "node:test";

import { createIndicatorRangeBatcher } from "../indicatorRangeBatcher.js";
import { structuralMock } from "../../../test/testHelpers.js";

type IndicatorRangeBatcher = ReturnType<typeof createIndicatorRangeBatcher>;
type IndicatorRangeRequest = Parameters<IndicatorRangeBatcher["schedule"]>[0];
type SendBatch = NonNullable<Parameters<typeof createIndicatorRangeBatcher>[0]>["sendBatch"];
type BatchInput = Parameters<NonNullable<SendBatch>>[0];

function request(
  clientId: string,
  overrides: Partial<IndicatorRangeRequest> = {},
): IndicatorRangeRequest {
  return structuralMock<IndicatorRangeRequest>({
    clientId,
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "3m",
    start: 100,
    end: 200,
    ...overrides,
  });
}

test("coalesces same-series calls into one physical batch", async () => {
  const calls: BatchInput[] = [];
  const batcher = createIndicatorRangeBatcher({
    sendBatch: async (input) => {
      calls.push(input);
      return {
        results: input.requests.map((item) => ({
          clientId: item.clientId,
          payload: { ok: true, clientId: item.clientId },
        })),
      };
    },
  });

  const results = await Promise.all([
    batcher.schedule(request("vol")),
    batcher.schedule(request("boll")),
    batcher.schedule(request("macd")),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].requests.length, 3);
  assert.deepEqual(results.map((item) => item.clientId), ["vol", "boll", "macd"]);
  batcher.dispose();
});

test("does not combine different K-line series", async () => {
  const calls: BatchInput[] = [];
  const batcher = createIndicatorRangeBatcher({
    sendBatch: async (input) => {
      calls.push(input);
      return { results: input.requests.map((item) => ({ payload: { clientId: item.clientId } })) };
    },
  });

  await Promise.all([
    batcher.schedule(request("one")),
    batcher.schedule(request("two", { interval: "15m" })),
  ]);

  assert.equal(calls.length, 2);
  batcher.dispose();
});

test("drops an item aborted before the microtask flush", async () => {
  const calls: BatchInput[] = [];
  const controller = new AbortController();
  const batcher = createIndicatorRangeBatcher({
    sendBatch: async (input) => {
      calls.push(input);
      return { results: input.requests.map((item) => ({ payload: { clientId: item.clientId } })) };
    },
  });

  const aborted = batcher.schedule(request("old", { signal: controller.signal }));
  const live = batcher.schedule(request("live"));
  controller.abort();

  await assert.rejects(aborted, (error) => error instanceof Error && error.name === "AbortError");
  assert.equal((await live).clientId, "live");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].requests.map((item) => item.clientId), ["live"]);
  batcher.dispose();
});

test("can batch again after a dispose and lifecycle reset", async () => {
  const calls: BatchInput[] = [];
  const batcher = createIndicatorRangeBatcher({
    sendBatch: async (input) => {
      calls.push(input);
      return { results: input.requests.map((item) => ({ payload: { clientId: item.clientId } })) };
    },
  });

  const abandoned = batcher.schedule(request("strict-probe"));
  const abandonedResult = assert.rejects(
    abandoned,
    (error) => error instanceof Error && error.name === "AbortError",
  );
  batcher.dispose();
  batcher.reset();

  const resumed = await Promise.all([
    batcher.schedule(request("ma")),
    batcher.schedule(request("vol")),
  ]);

  await abandonedResult;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].requests.map((item) => item.clientId), ["ma", "vol"]);
  assert.deepEqual(resumed.map((item) => item.clientId), ["ma", "vol"]);
  batcher.dispose();
});
