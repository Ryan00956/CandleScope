import assert from "node:assert/strict";
import test from "node:test";

import { shouldPreserveProjectionViewport } from "../projectionViewportPolicy.js";

test("viewport preservation requires an existing projected display", () => {
  for (const delta of [
    { type: "prepend" },
    { type: "mid-merge" },
    { type: "replace" },
    { type: "trim-left" },
    { type: "trim-right" },
    { type: "tick", trimmedLeft: 1 },
    { type: "append", trimmedRight: 1 },
  ]) {
    assert.equal(shouldPreserveProjectionViewport(delta), false);
  }
});

test("structural merge and trim deltas preserve an existing viewport", () => {
  for (const type of ["prepend", "mid-merge", "trim-left", "trim-right"]) {
    assert.equal(
      shouldPreserveProjectionViewport({ type }, { hasDisplay: true }),
      true,
    );
  }
});

test("replace preserves only a user-owned existing viewport", () => {
  assert.equal(
    shouldPreserveProjectionViewport(
      { type: "replace" },
      { hasDisplay: true, userInteracted: false },
    ),
    false,
  );
  assert.equal(
    shouldPreserveProjectionViewport(
      { type: "replace" },
      { hasDisplay: true, userInteracted: true },
    ),
    true,
  );
});

test("tick and append preserve only when they also trim the window", () => {
  assert.equal(
    shouldPreserveProjectionViewport(
      { type: "tick", trimmedLeft: 1 },
      { hasDisplay: true },
    ),
    true,
  );
  assert.equal(
    shouldPreserveProjectionViewport(
      { type: "append", trimmedRight: 2 },
      { hasDisplay: true },
    ),
    true,
  );
  assert.equal(
    shouldPreserveProjectionViewport(
      { type: "tick", trimmedLeft: 0, trimmedRight: 0 },
      { hasDisplay: true },
    ),
    false,
  );
  assert.equal(
    shouldPreserveProjectionViewport({ type: "append" }, { hasDisplay: true }),
    false,
  );
});

test("noop, clear, and unknown deltas never preserve the viewport", () => {
  for (const delta of [
    { type: "noop" },
    { type: "clear" },
    { type: "unknown", trimmedLeft: 1 },
    null,
  ]) {
    assert.equal(
      shouldPreserveProjectionViewport(delta, { hasDisplay: true }),
      false,
    );
  }
});
