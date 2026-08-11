import assert from "node:assert/strict";
import test from "node:test";

import { configureChartWorkspaceCellsCandidate } from "../chartWorkspaceBulkUpdate.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";

test("bulk capacity configuration updates independent sessions in one document candidate", () => {
  const original = createDefaultChartWorkspace();
  const cellIds = Object.keys(original.cells);
  const configured = configureChartWorkspaceCellsCandidate(original, cellIds.map((cellId, index) => ({
    cellId,
    session: {
      exchange: "binance",
      marketType: "spot",
      symbol: `SYMBOL${index}USDT`,
      interval: "1m",
    },
    indicators: [{ id: `builtin-${index}`, params: { length: 20 } }],
  })));

  assert.notStrictEqual(configured, original);
  assert.deepEqual(Object.values(configured.cells).map((cell) => cell.session.symbol), [
    "SYMBOL0USDT",
    "SYMBOL1USDT",
    "SYMBOL2USDT",
    "SYMBOL3USDT",
  ]);
  assert.ok(Object.values(configured.cells).every((cell) => cell.linkGroupId === null));
  assert.ok(Object.values(configured.cells).every((cell) => cell.indicators.length === 1));
  assert.equal(original.cells["cell-1"]!.session.symbol, "BTCUSDT");
});

test("bulk capacity configuration rejects duplicate cell identities", () => {
  const original = createDefaultChartWorkspace();
  const configuration = {
    cellId: "cell-1",
    session: original.cells["cell-1"]!.session,
    indicators: [],
  };
  assert.throws(
    () => configureChartWorkspaceCellsCandidate(original, [configuration, configuration]),
    /Duplicate chart cell configuration/,
  );
});
