import assert from "node:assert/strict";
import test from "node:test";

import {
  clampRightDrawerWidth,
  rightDrawerWidthBounds,
  type RightDrawerResizeOptions,
} from "./useRightDrawerResize.js";

const options: RightDrawerResizeOptions = {
  initialWidth: 430,
  minWidth: 360,
  maxWidth: 780,
  viewportMargin: 80,
};

test("right drawer width stays inside its content and viewport bounds", () => {
  assert.deepEqual(rightDrawerWidthBounds(options, 1440), { min: 360, max: 780 });
  assert.equal(clampRightDrawerWidth(200, options, 1440), 360);
  assert.equal(clampRightDrawerWidth(600, options, 1440), 600);
  assert.equal(clampRightDrawerWidth(1000, options, 1440), 780);
});

test("right drawer can contract below its normal minimum on a narrow viewport", () => {
  assert.deepEqual(rightDrawerWidthBounds(options, 320), { min: 240, max: 240 });
  assert.equal(clampRightDrawerWidth(430, options, 320), 240);
});
