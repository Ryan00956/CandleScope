import assert from "node:assert/strict";
import test from "node:test";

import { sourceFileKind } from "./check-architecture.mjs";

test("architecture source discovery accepts TypeScript and rejects legacy JavaScript", () => {
  assert.equal(sourceFileKind("feature.ts"), "typescript");
  assert.equal(sourceFileKind("Component.tsx"), "typescript");
  assert.equal(sourceFileKind("legacy.js"), "legacy-javascript");
  assert.equal(sourceFileKind("Legacy.jsx"), "legacy-javascript");
  assert.equal(sourceFileKind("tool.mjs"), null);
});
