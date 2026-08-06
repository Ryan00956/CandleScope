import assert from "node:assert/strict";
import test from "node:test";

import {
  clampBoundsToWorkArea,
  displayFingerprint,
  restoreWindowPlacement,
} from "./window-placement.mjs";

const primary = {
  id: 1,
  label: "Internal",
  internal: true,
  rotation: 0,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1707, height: 1067 },
  workArea: { x: 0, y: 0, width: 1707, height: 1020 },
};

const left = {
  id: 2,
  label: "External",
  internal: false,
  rotation: 0,
  scaleFactor: 1.25,
  bounds: { x: -1536, y: -120, width: 1536, height: 864 },
  workArea: { x: -1536, y: -120, width: 1536, height: 824 },
};

test("fingerprint stays stable when a display moves but native size and identity stay stable", () => {
  const moved = {
    ...left,
    bounds: { ...left.bounds, x: 1707, y: 80 },
    workArea: { ...left.workArea, x: 1707, y: 80 },
  };
  assert.equal(displayFingerprint(left), displayFingerprint(moved));
});

test("restoration honors the monitor fingerprint across negative-coordinate movement", () => {
  const result = restoreWindowPlacement({
    boundsDip: { x: -1500, y: -100, width: 1200, height: 700 },
    monitorFingerprint: displayFingerprint(left),
  }, [primary, left], primary.id);
  assert.equal(result.displayId, left.id);
  assert.equal(result.reason, "fingerprint");
  assert.deepEqual(result.boundsDip, { x: -1500, y: -100, width: 1200, height: 700 });
  assert.equal(result.dpiScale, 1.25);
});

test("a missing display clamps the full window into the primary work area", () => {
  const result = restoreWindowPlacement({
    boundsDip: { x: -5000, y: 4000, width: 2400, height: 1600 },
    monitorFingerprint: "display-unplugged",
  }, [primary], primary.id);
  assert.equal(result.reason, "missing-monitor");
  assert.deepEqual(result.boundsDip, { x: 0, y: 0, width: 1707, height: 1020 });
});

test("DIP bounds remain DIP values when scale changes and are clamped only by work area", () => {
  const twoHundredPercent = {
    ...primary,
    scaleFactor: 2,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const result = restoreWindowPlacement({
    boundsDip: { x: 50, y: 40, width: 1280, height: 800 },
    monitorFingerprint: displayFingerprint(twoHundredPercent),
  }, [twoHundredPercent], twoHundredPercent.id);
  assert.deepEqual(result.boundsDip, { x: 50, y: 40, width: 1280, height: 800 });
  assert.equal(result.dpiScale, 2);
});

test("small work areas do not produce negative dimensions", () => {
  assert.deepEqual(
    clampBoundsToWorkArea({ x: 100, y: 100, width: 10, height: 10 }, {
      x: -300,
      y: -200,
      width: 320,
      height: 240,
    }),
    { x: -300, y: -200, width: 320, height: 240 },
  );
});
