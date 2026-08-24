import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  sanitizeTradeExplanation,
  tradeExplanationCanonicalJson,
  tradeExplanationSha256,
  verifyTradeExplanation,
} from "../tradeExplanationEvidence.js";

function fixture(): { payload: Record<string, unknown>; canonicalWithoutHash: string } {
  return JSON.parse(readFileSync(resolve(
    process.cwd(),
    "../backend/tests/fixtures/backtest/trade_explanation_v1_jcs.json",
  ), "utf8")) as { payload: Record<string, unknown>; canonicalWithoutHash: string };
}

test("TypeScript recomputes the frozen Python JCS evidence fixture exactly", async () => {
  const value = fixture();
  const unsigned = { ...value.payload };
  delete unsigned.evidenceHash;
  assert.equal(tradeExplanationCanonicalJson(unsigned), value.canonicalWithoutHash);
  assert.equal(await tradeExplanationSha256(unsigned), value.payload.evidenceHash);
  assert.equal(await verifyTradeExplanation(value.payload), true);
});

test("hash mismatch and unsafe integers fail closed to UNAVAILABLE", async () => {
  const value = fixture();
  const corrupt = structuredClone(value.payload);
  corrupt.reasonLabel = "post-hoc guess";
  assert.equal(await verifyTradeExplanation(corrupt), false);
  const sanitized = await sanitizeTradeExplanation(corrupt);
  assert.equal(sanitized.completeness, "UNAVAILABLE");
  assert.equal(sanitized.reasonCode, null);
  assert.equal(sanitized.reasonLabel, null);
  assert.deepEqual(sanitized.conditions, []);
  assert.deepEqual(sanitized.variables, {});
  assert.equal(await verifyTradeExplanation(sanitized), true);

  const unsafe = structuredClone(value.payload);
  unsafe.decisionTimeMs = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(await verifyTradeExplanation(unsafe), false);
});
