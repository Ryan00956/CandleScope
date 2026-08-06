import assert from "node:assert/strict";
import test from "node:test";

import { SeriesSnapshotHub } from "./series-snapshot-hub.mjs";

function bars(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    time: offset + index + 1,
    open: 1,
    high: 2,
    low: 0,
    close: 1,
    volume: 3,
  }));
}

test("shared Series snapshots clone reads and expose bounded diagnostics", () => {
  const hub = new SeriesSnapshotHub();
  hub.publish({ key: "binance-spot-BTCUSDT-1m", rows: bars(2) });
  const first = hub.read("binance-spot-BTCUSDT-1m");
  first.rows[0].close = 99;
  assert.equal(hub.read("binance-spot-BTCUSDT-1m").rows[0].close, 1);
  assert.deepEqual(hub.diagnostics().limits, {
    maxEntries: 64,
    maxBars: 256,
    maxPayloadBytes: 524288,
  });
});

test("shared Series snapshots reject malformed and oversized identities fail closed", () => {
  const hub = new SeriesSnapshotHub();
  assert.throws(() => hub.publish({ key: "bad key", rows: bars(1) }), /key is invalid/);
  assert.throws(() => hub.publish({ key: "binance-spot-BTCUSDT-1m", rows: bars(257) }), /1..256/);
  assert.equal(hub.read("bad key").ok, false);
  assert.equal(hub.diagnostics().counts.rejects, 3);
});

test("shared Series snapshot cache evicts the least recently used key at 64 entries", () => {
  const hub = new SeriesSnapshotHub();
  for (let index = 0; index < 65; index += 1) {
    hub.publish({ key: `binance-spot-S${index}-1m`, rows: bars(1, index) });
  }
  assert.equal(hub.diagnostics().entries, 64);
  assert.equal(hub.read("binance-spot-S0-1m").hit, false);
  assert.equal(hub.read("binance-spot-S64-1m").hit, true);
});
