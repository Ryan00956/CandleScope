import assert from "node:assert/strict";
import test from "node:test";

import { createKagiSeriesPaneView } from "../kagiSeries.js";

function kagiRow({
  close,
  color,
  direction,
  high,
  low,
  open,
  sections,
  state,
  time = 1,
  turnPrice = null,
}) {
  return {
    time,
    open,
    high,
    low,
    close,
    ...(color ? { color } : {}),
    customValues: {
      kagi: {
        direction,
        reversalAmount: 4,
        reversalKind: turnPrice == null ? null : (direction === "down" ? "shoulder" : "waist"),
        reversalTicks: 4,
        sections,
        source: "close",
        state,
        turnPrice,
      },
    },
  };
}

function recordingContext() {
  let path = [];
  const strokes = [];
  return {
    context: {
      beginPath() { path = []; },
      lineTo: (...args) => path.push(["lineTo", ...args]),
      moveTo: (...args) => path.push(["moveTo", ...args]),
      stroke() {
        strokes.push({
          color: this.strokeStyle,
          lineWidth: this.lineWidth,
          path: path.slice(),
        });
      },
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
      strokeStyle: "",
    },
    strokes,
  };
}

function draw(paneView, rows, {
  barSpacing = 12,
  horizontalPixelRatio = 1,
  options = {},
  verticalPixelRatio = 1,
  visibleRange = { from: 0, to: rows.length },
} = {}) {
  const recording = recordingContext();
  paneView.update({
    barSpacing,
    conflationFactor: 1,
    visibleRange,
    bars: rows.map((originalData, index) => ({
      x: 10 + index * 12,
      originalData,
    })),
  }, {
    upColor: "green",
    downColor: "red",
    lineWidth: 2,
    thickLineWidth: 4,
    ...options,
  });
  paneView.renderer().draw({
    useBitmapCoordinateSpace: (render) => render({
      context: recording.context,
      horizontalPixelRatio,
      verticalPixelRatio,
    }),
  }, (price) => 200 - price);
  return recording.strokes;
}

test("Kagi custom series exposes the full leg range and validates fallback legs", () => {
  const paneView = createKagiSeriesPaneView();
  const row = kagiRow({
    time: 10,
    open: 100,
    high: 110,
    low: 100,
    close: 110,
    direction: "up",
    sections: [{ from: 100, to: 110, style: "yang" }],
    state: "yang",
  });

  assert.deepEqual(paneView.priceValueBuilder(row), [110, 100, 110]);
  assert.equal(paneView.isWhitespace(row), false);
  assert.equal(paneView.isWhitespace({ time: 11, open: 100, high: 105, low: 100, close: 105 }), false);
  assert.equal(paneView.isWhitespace({ time: 12 }), true);
  const defaults = paneView.defaultOptions();
  assert.equal(defaults.upColor, "#22c55e");
  assert.equal(defaults.downColor, "#ef4444");
  assert.equal(defaults.lineWidth, 2);
  assert.equal(defaults.thickLineWidth, 4);
});

test("Kagi renderer draws vertical sections and a horizontal turn connector", () => {
  const paneView = createKagiSeriesPaneView();
  const rows = [
    kagiRow({
      time: 10,
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      direction: "up",
      sections: [
        { from: 100, to: 105, style: "yin" },
        { from: 105, to: 110, style: "yang" },
      ],
      state: "yang",
    }),
    kagiRow({
      time: 20,
      open: 109,
      high: 110,
      low: 100,
      close: 100,
      direction: "down",
      sections: [
        { from: 110, to: 106, style: "yang" },
        { from: 106, to: 100, style: "yin" },
      ],
      state: "yin",
      turnPrice: 110,
    }),
  ];
  const strokes = draw(paneView, rows, {
    horizontalPixelRatio: 2,
    verticalPixelRatio: 3,
  });

  assert.equal(strokes.length, 5);
  assert.deepEqual(strokes.map(({ color, lineWidth }) => [color, lineWidth]), [
    ["green", 4],
    ["green", 8],
    ["green", 8],
    ["red", 8],
    ["red", 4],
  ]);
  assert.deepEqual(strokes[0].path, [
    ["moveTo", 20, 300],
    ["lineTo", 20, 285],
  ]);
  assert.deepEqual(strokes[2].path, [
    ["moveTo", 20, 270],
    ["lineTo", 44, 270],
  ]);
  assert.deepEqual(strokes[4].path, [
    ["moveTo", 44, 282],
    ["lineTo", 44, 300],
  ]);
});

test("Kagi renderer applies barcolor to legs and the preceding reversal connector", () => {
  const paneView = createKagiSeriesPaneView();
  const rows = [
    kagiRow({
      time: 10,
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      color: "orange",
      direction: "up",
      sections: [{ from: 100, to: 110, style: "yang" }],
      state: "yang",
    }),
    kagiRow({
      time: 20,
      open: 110,
      high: 110,
      low: 100,
      close: 100,
      color: "purple",
      direction: "down",
      sections: [{ from: 110, to: 100, style: "yin" }],
      state: "yin",
      turnPrice: 110,
    }),
  ];

  const strokes = draw(paneView, rows);

  assert.deepEqual(strokes.map(({ color }) => color), ["orange", "orange", "purple"]);
});

test("Kagi renderer falls back to OHLC when metadata or valid sections are missing", () => {
  const paneView = createKagiSeriesPaneView();
  const withoutMetadata = {
    time: 10,
    open: 100,
    high: 106,
    low: 100,
    close: 106,
  };
  const invalidSections = kagiRow({
    time: 20,
    open: 106,
    high: 106,
    low: 101,
    close: 101,
    direction: "down",
    sections: [{ from: null, to: "bad", style: "yang" }],
    state: "yin",
    turnPrice: 106,
  });
  const strokes = draw(paneView, [withoutMetadata, invalidSections]);

  assert.equal(strokes.length, 3);
  assert.deepEqual(strokes.map(({ color, lineWidth }) => [color, lineWidth]), [
    ["green", 2],
    ["green", 2],
    ["red", 2],
  ]);
});

test("Kagi renderer scales thick and thin strokes down for narrow bar spacing", () => {
  const paneView = createKagiSeriesPaneView();
  const row = kagiRow({
    open: 100,
    high: 110,
    low: 100,
    close: 110,
    direction: "up",
    sections: [
      { from: 100, to: 105, style: "yin" },
      { from: 105, to: 110, style: "yang" },
    ],
    state: "yang",
  });
  const strokes = draw(paneView, [row], {
    barSpacing: 2,
    horizontalPixelRatio: 2,
    verticalPixelRatio: 2,
  });

  assert.equal(strokes.length, 2);
  assert.ok(strokes[0].lineWidth >= 1);
  assert.ok(strokes[0].lineWidth < strokes[1].lineWidth);
  assert.ok(strokes[1].lineWidth <= 2 * 2 * 0.72);
});

test("Kagi renderer ignores invalid coordinates without affecting valid visible legs", () => {
  const paneView = createKagiSeriesPaneView();
  const valid = kagiRow({
    open: 100,
    high: 105,
    low: 100,
    close: 105,
    direction: "up",
    sections: [{ from: 100, to: 105, style: "yin" }],
    state: "yin",
  });
  const invalid = kagiRow({
    time: 2,
    open: 105,
    high: 110,
    low: 105,
    close: 110,
    direction: "up",
    sections: [{ from: 105, to: 110, style: "yang" }],
    state: "yang",
    turnPrice: 105,
  });
  const recording = recordingContext();
  paneView.update({
    barSpacing: 12,
    visibleRange: { from: 0, to: 2 },
    bars: [
      { x: 10, originalData: valid },
      { x: Number.NaN, originalData: invalid },
    ],
  }, paneView.defaultOptions());
  paneView.renderer().draw({
    useBitmapCoordinateSpace: (render) => render({
      context: recording.context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }, (price) => (price === 105 ? Number.NaN : 200 - price));

  assert.equal(recording.strokes.length, 0);
});
