import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DRAWING_VITE_ENV_READERS = Object.freeze([
  ["src/chart-adapter/coordinateBridge.ts", "VITE_DRAWING_COORDINATE_PROJECTOR"],
  ["src/features/drawings/drawingDocumentAuthority.ts", "VITE_DRAWING_DOCUMENT_AUTHORITY"],
  ["src/features/drawings/drawingEngineMode.ts", "VITE_DRAWING_ENGINE_MODE"],
  ["src/features/drawings/drawingRasterBackend.ts", "VITE_DRAWING_RASTER_BACKEND"],
  ["src/features/drawings/interactionSurfaceMode.ts", "VITE_DRAWING_INTERACTION_OVERLAY"],
]);

test("drawing rollout readers keep Vite-statically-replaceable env property access", () => {
  for (const [relativePath, key] of DRAWING_VITE_ENV_READERS) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    const directAccess = new RegExp(`import\\.meta\\.env\\.${key}\\b`, "g");
    const optionalAccess = new RegExp(`import\\.meta\\.env\\?\\.${key}\\b`);
    const directMatches = source.match(directAccess) ?? [];

    assert.equal(
      directMatches.length,
      1,
      `${relativePath} must read ${key} through exactly one direct Vite env access`,
    );
    assert.doesNotMatch(
      source,
      optionalAccess,
      `${relativePath} must not use optional chaining for ${key}`,
    );
  }
});
