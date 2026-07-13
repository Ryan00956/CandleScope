import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasCropPlan,
  buildExportOptionsKey,
  canvasToBlob,
  normalizeExportOptions,
} from "../exportService.js";

test("main pane crop plan converts CSS pixels into captured canvas pixels", () => {
  assert.deepEqual(buildCanvasCropPlan({
    sourceWidth: 1800,
    sourceHeight: 1000,
    targetWidth: 900,
    targetHeight: 500,
    cropRect: { x: 0, y: 0, width: 900, height: 320 },
  }), {
    sx: 0,
    sy: 0,
    sw: 1800,
    sh: 640,
  });

  assert.deepEqual(buildCanvasCropPlan({
    sourceWidth: 1600,
    sourceHeight: 900,
    targetWidth: 800,
    targetHeight: 450,
    cropRect: { x: 100, y: 50, width: 500, height: 250 },
  }), {
    sx: 200,
    sy: 100,
    sw: 1000,
    sh: 500,
  });
});

test("invalid crop geometry leaves the captured canvas uncropped", () => {
  assert.equal(buildCanvasCropPlan({
    sourceWidth: 1800,
    sourceHeight: 1000,
    targetWidth: 900,
    targetHeight: 500,
    cropRect: null,
  }), null);
  assert.equal(buildCanvasCropPlan({
    sourceWidth: 1800,
    sourceHeight: 1000,
    targetWidth: 0,
    targetHeight: 500,
    cropRect: { x: 0, y: 0, width: 900, height: 320 },
  }), null);
});

test("export options key invalidates a preview when the resolved theme changes", () => {
  const darkKey = buildExportOptionsKey({
    format: "png",
    backgroundColor: "auto",
    metadata: { symbol: "BTCUSDT", interval: "1h", theme: "dark" },
  });
  const lightKey = buildExportOptionsKey({
    format: "png",
    backgroundColor: "auto",
    metadata: { symbol: "BTCUSDT", interval: "1h", theme: "light" },
  });

  assert.notEqual(darkKey, lightKey);
});

test("JPEG export normalizes an impossible transparent background", () => {
  assert.equal(normalizeExportOptions({
    format: "jpeg",
    backgroundColor: "transparent",
  }).backgroundColor, "auto");
  assert.equal(normalizeExportOptions({
    format: "png",
    backgroundColor: "transparent",
  }).backgroundColor, "transparent");
  assert.equal(normalizeExportOptions({
    format: "webp",
    backgroundColor: "transparent",
  }).backgroundColor, "transparent");
});

test("canvasToBlob requests and returns the exact selected MIME type", async () => {
  let request = null;
  const canvas = {
    toBlob(callback, type, quality) {
      request = { type, quality };
      callback(new Blob(["jpeg"], { type }));
    },
  };

  const blob = await canvasToBlob(canvas, "jpeg", 0.81);
  assert.deepEqual(request, { type: "image/jpeg", quality: 0.81 });
  assert.equal(blob.type, "image/jpeg");
});

test("canvasToBlob omits quality for PNG and rejects browser format fallback", async () => {
  let pngRequest = null;
  const pngCanvas = {
    toBlob(callback, type, quality) {
      pngRequest = { type, quality };
      callback(new Blob(["png"], { type }));
    },
  };
  await canvasToBlob(pngCanvas, "png", 0.5);
  assert.deepEqual(pngRequest, { type: "image/png", quality: undefined });

  const fallbackCanvas = {
    toBlob(callback) {
      callback(new Blob(["fallback"], { type: "image/png" }));
    },
  };
  await assert.rejects(
    canvasToBlob(fallbackCanvas, "webp", 0.92),
    /expected image\/webp|\u671f\u671b image\/webp/,
  );
});
