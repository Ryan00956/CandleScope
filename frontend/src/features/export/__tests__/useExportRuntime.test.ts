import assert from "node:assert/strict";
import test from "node:test";

import { buildExportPresentationKey } from "../exportService.js";
import { sameDrawingExportTarget } from "../useExportRuntime.js";

test("preview freshness tracks effective drawing visibility", () => {
  const visible = buildExportPresentationKey({ hideDrawings: false }, false);
  const globallyHidden = buildExportPresentationKey({ hideDrawings: false }, true);
  assert.notEqual(visible, globallyHidden);

  const optionHidden = buildExportPresentationKey({ hideDrawings: true }, false);
  const optionAndGlobalHidden = buildExportPresentationKey({ hideDrawings: true }, true);
  assert.equal(optionHidden, optionAndGlobalHidden);
});

test("preview reuse requires both drawing scope and revision to match", () => {
  assert.equal(sameDrawingExportTarget(null, null), true);
  assert.equal(sameDrawingExportTarget(
    { scopeKey: "BTCUSDT", documentRevision: 7 },
    { scopeKey: "BTCUSDT", documentRevision: 7 },
  ), true);
  assert.equal(sameDrawingExportTarget(
    { scopeKey: "BTCUSDT", documentRevision: 7 },
    { scopeKey: "ETHUSDT", documentRevision: 7 },
  ), false);
  assert.equal(sameDrawingExportTarget(
    { scopeKey: "BTCUSDT", documentRevision: 8 },
    { scopeKey: "BTCUSDT", documentRevision: 7 },
  ), false);
  assert.equal(sameDrawingExportTarget(
    { scopeKey: "BTCUSDT", documentRevision: 0 },
    null,
  ), false);
});
