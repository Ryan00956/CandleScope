import assert from "node:assert/strict";
import test from "node:test";

import {
  loadDrawings,
  saveDrawings,
  serializeDataPoint,
  serializeHorizontalAnchor,
} from "../drawingPersistence.js";

test("serializeDataPoint persists canonical derived lineage but not order or logical", () => {
  assert.deepEqual(serializeDataPoint({
    time: 1_700_000_000,
    logical: 42,
    order: 9,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{\"reversalAmount\":3}",
    price: 100,
  }), {
    time: 1_700_000_000,
    sourceOrdinal: 2,
    sourceProjection: "point-and-figure",
    sourceProjectionConfig: "derived-ordinal:point-and-figure:{\"reversalAmount\":3}",
    price: 100,
  });
});

test("serializeDataPoint preserves legacy time-axis logical fallback", () => {
  assert.deepEqual(serializeDataPoint({
    time: 100,
    logical: 12.5,
    order: 99,
    price: 5,
  }), {
    time: 100,
    logical: 12.5,
    price: 5,
  });
});

test("serializeHorizontalAnchor safely round-trips position source metadata", () => {
  assert.deepEqual(serializeHorizontalAnchor({
    time: 200,
    sourceOrdinal: 0,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{\"numberOfLines\":3}",
    logical: 8,
    order: 3,
  }), {
    time: 200,
    sourceOrdinal: 0,
    sourceProjection: "line-break",
    sourceProjectionConfig: "derived-ordinal:line-break:{\"numberOfLines\":3}",
  });
});

test("persistence rejects unsafe source metadata", () => {
  assert.deepEqual(serializeDataPoint({
    time: 300,
    sourceOrdinal: -1,
    sourceProjection: "../renko",
    sourceProjectionConfig: "renko\nunsafe",
    price: 10,
  }), {
    time: 300,
    price: 10,
  });
});

test("save and load round-trip canonical source metadata without ordinal order", () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  try {
    saveDrawings("derived-roundtrip", [{
      _id: "line-1",
      _lineType: "line-segment",
      _dataPoints: [{
        time: 1_700_000_000,
        sourceOrdinal: 4,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        order: 88,
        logical: 99,
        price: 100,
      }, {
        time: 1_700_000_060,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 101,
      }],
      _color: "#fff",
      _lineWidth: 2,
    }]);

    assert.deepEqual(loadDrawings("derived-roundtrip"), [{
      type: "line",
      id: "line-1",
      lineType: "line-segment",
      dataPoints: [{
        time: 1_700_000_000,
        sourceOrdinal: 4,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 100,
      }, {
        time: 1_700_000_060,
        sourceOrdinal: 0,
        sourceProjection: "renko",
        sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
        price: 101,
      }],
      color: "#fff",
      lineWidth: 2,
    }]);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
