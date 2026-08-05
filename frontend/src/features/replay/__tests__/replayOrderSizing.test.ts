import assert from "node:assert/strict";
import test from "node:test";

import { rebaseReplayMaxQuantity, replayOrderPreviewSide } from "../replayOrderSizing.js";

const BASE_INPUT = {
  previousMaxQuantity: 0.5,
  previousReferencePrice: 100,
  nextReferencePrice: 100,
  previousAvailableEquity: 10_000,
  nextAvailableEquity: 10_000,
  previousLeverage: 3,
  nextLeverage: 3,
  reduceOnly: false,
} as const;

test("rebases a stale 100% quantity downward before previewing a higher price", () => {
  const rebased = rebaseReplayMaxQuantity({
    ...BASE_INPUT,
    nextReferencePrice: 110,
  });

  assert.ok(rebased !== null);
  assert.ok(Math.abs(rebased - (0.5 * 100 / 110)) < 1e-12);
});

test("never grows a cached cap before the server confirms the new maximum", () => {
  assert.equal(rebaseReplayMaxQuantity({
    ...BASE_INPUT,
    nextReferencePrice: 90,
  }), 0.5);
});

test("rebases against lower equity and leverage without changing reduce-only capacity", () => {
  assert.equal(rebaseReplayMaxQuantity({
    ...BASE_INPUT,
    nextAvailableEquity: 8_000,
    nextLeverage: 2,
  }), 0.5 * 0.8 * (2 / 3));
  assert.equal(rebaseReplayMaxQuantity({
    ...BASE_INPUT,
    nextReferencePrice: 110,
    reduceOnly: true,
  }), 0.5);
});

test("previews the only non-reversing side once a position is open", () => {
  assert.equal(replayOrderPreviewSide(0, "BUY"), "BUY");
  assert.equal(replayOrderPreviewSide(0, "SELL"), "SELL");
  assert.equal(replayOrderPreviewSide(1, "SELL"), "BUY");
  assert.equal(replayOrderPreviewSide(-1, "BUY"), "SELL");
});
